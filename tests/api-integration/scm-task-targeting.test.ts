import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import {
  broadcastTaskTitleChanged,
  processScmSyncJob,
  registerPlugin,
} from "../../apps/api/src/plugins/registry";
import type { PluginContext } from "../../apps/api/src/plugins/types";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const movedTaskContexts: PluginContext[] = [];
const remoteIssuesBySyncJob = new Map<
  string,
  { externalId: string; url: string; title: string }
>();
const taskCreationAttempts: string[] = [];
registerPlugin({
  type: "test-moved-task-scm",
  name: "Moved task test SCM",
  kind: "scm",
  validateConfig: async () => ({ valid: true }),
  onTaskTitleChanged: async (_event, context) => {
    movedTaskContexts.push(context);
  },
  onTaskCreated: async (event) => {
    const syncJobId = event.scmSyncJobId ?? "";
    taskCreationAttempts.push(syncJobId);
    remoteIssuesBySyncJob.set(syncJobId, {
      externalId: "81",
      url: "https://git.example.test/team/retry-repository/issues/81",
      title: event.title,
    });
    throw new Error("Simulated worker exit after remote issue creation");
  },
  reconcileTaskCreated: async (event) => {
    const issue = remoteIssuesBySyncJob.get(event.scmSyncJobId ?? "");
    return issue
      ? {
          ...issue,
          metadata: { state: "open" },
        }
      : null;
  },
});

async function attachRepository(projectId: string, fullPath: string) {
  const [integration] = await db
    .insert(schema.integrationTable)
    .values({
      projectId,
      type: "gitea",
      config: JSON.stringify({}),
    })
    .returning();

  const [repository] = await db
    .insert(schema.integrationRepositoryTable)
    .values({
      integrationId: integration.id,
      provider: "gitea",
      remoteOrigin: "https://git.example.test",
      providerRepositoryId: `${projectId}:${fullPath}`,
      fullPath,
      webUrl: `https://git.example.test/${fullPath}`,
      defaultBranch: "main",
    })
    .returning();

  return repository;
}

function createTaskRequest(
  app: ReturnType<typeof createApp>["app"],
  projectId: string,
  integrationRepositoryId?: string,
) {
  return app.request(`/api/task/${projectId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Targeted task",
      description: "",
      priority: "low",
      status: "to-do",
      integrationRepositoryId,
    }),
  });
}

describe("API integration: SCM task targeting", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    movedTaskContexts.length = 0;
    remoteIssuesBySyncJob.clear();
    taskCreationAttempts.length = 0;
  });

  it("creates a Kaneo-only task without an SCM job by default", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await createTaskRequest(app, project.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({ scmSync: null }),
    );
    expect(await db.select().from(schema.scmSyncJobTable)).toHaveLength(0);
  });

  it("records exactly one targeted job in the task transaction", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const repository = await attachRepository(project.id, "team/roadmap");

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await createTaskRequest(app, project.id, repository.id);
    const body = (await response.json()) as {
      id: string;
      scmSync: { id: string; status: string; lastError: string | null };
    };

    expect(response.status).toBe(200);
    expect(body.scmSync).toEqual(
      expect.objectContaining({
        status: "failed",
        lastError: expect.any(String),
      }),
    );

    const jobs = await db
      .select()
      .from(schema.scmSyncJobTable)
      .where(eq(schema.scmSyncJobTable.taskId, body.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(
      expect.objectContaining({
        integrationRepositoryId: repository.id,
        operation: "create_issue",
        status: "failed",
        attempts: 1,
      }),
    );
  });

  it("rejects a repository from another project before creating a task", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project: firstProject } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: secondProject } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const repository = await attachRepository(
      secondProject.id,
      "team/other-project",
    );

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await createTaskRequest(
      app,
      firstProject.id,
      repository.id,
    );

    expect(response.status).toBe(400);
    expect(await db.select().from(schema.taskTable)).toHaveLength(0);
    expect(await db.select().from(schema.scmSyncJobTable)).toHaveLength(0);
  });

  it("lists only active repositories attached to the requested project", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project: firstProject } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: secondProject } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const firstRepository = await attachRepository(
      firstProject.id,
      "team/first",
    );
    const inactiveRepository = await attachRepository(
      secondProject.id,
      "team/inactive",
    );
    await db
      .update(schema.integrationRepositoryTable)
      .set({ isActive: false })
      .where(eq(schema.integrationRepositoryTable.id, inactiveRepository.id));

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(
      `/api/scm/repositories/project/${firstProject.id}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: firstRepository.id,
        projectId: firstProject.id,
        fullPath: "team/first",
      }),
    ]);
  });

  it("keeps syncing through the linked source repository after a project move", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project: sourceProject } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: destinationProject, columns } = await createProjectFixture(
      {
        workspaceId: member.workspace.id,
      },
    );
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: sourceProject.id,
        type: "test-moved-task-scm",
        config: JSON.stringify({}),
      })
      .returning();
    const [repository] = await db
      .insert(schema.integrationRepositoryTable)
      .values({
        integrationId: integration.id,
        provider: "test-moved-task-scm",
        remoteOrigin: "https://git.example.test",
        providerRepositoryId: "moved-task-repository",
        fullPath: "team/moved-task-repository",
        webUrl: "https://git.example.test/team/moved-task-repository",
      })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: destinationProject.id,
        columnId: columns.todo.id,
        title: "Moved task",
        status: "to-do",
        number: 1,
      })
      .returning();
    await db.insert(schema.externalLinkTable).values({
      taskId: task.id,
      integrationId: integration.id,
      integrationRepositoryId: repository.id,
      resourceType: "issue",
      externalId: "17",
      url: `${repository.webUrl}/issues/17`,
    });

    await broadcastTaskTitleChanged({
      taskId: task.id,
      projectId: destinationProject.id,
      userId: member.user.id,
      oldTitle: "Moved task",
      newTitle: "Still syncing",
    });

    expect(movedTaskContexts).toHaveLength(1);
    expect(movedTaskContexts[0]).toMatchObject({
      integrationId: integration.id,
      integrationRepositoryId: repository.id,
      projectId: sourceProject.id,
    });
  });

  it("reconciles a remote issue before retrying a stale creation job", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "test-moved-task-scm",
        config: JSON.stringify({}),
      })
      .returning();
    const [repository] = await db
      .insert(schema.integrationRepositoryTable)
      .values({
        integrationId: integration.id,
        provider: "test-moved-task-scm",
        remoteOrigin: "https://git.example.test",
        providerRepositoryId: "retry-repository",
        fullPath: "team/retry-repository",
        webUrl: "https://git.example.test/team/retry-repository",
      })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        columnId: columns.todo.id,
        title: "Retry-safe task",
        description: "Created once",
        status: "to-do",
        priority: "high",
        number: 1,
      })
      .returning();
    const [job] = await db
      .insert(schema.scmSyncJobTable)
      .values({
        taskId: task.id,
        integrationRepositoryId: repository.id,
        operation: "create_issue",
        dedupeKey: `create-issue:${task.id}:${repository.id}`,
        payload: {
          taskId: task.id,
          projectId: project.id,
          userId: member.user.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          status: task.status,
          number: task.number ?? 1,
        },
      })
      .returning();

    expect(await processScmSyncJob(job.id)).toBe(false);
    await db
      .update(schema.scmSyncJobTable)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.scmSyncJobTable.id, job.id));
    expect(await processScmSyncJob(job.id)).toBe(true);

    expect(taskCreationAttempts).toEqual([job.id]);
    expect(remoteIssuesBySyncJob.size).toBe(1);
    expect(
      await db
        .select()
        .from(schema.externalLinkTable)
        .where(eq(schema.externalLinkTable.taskId, task.id)),
    ).toEqual([
      expect.objectContaining({
        integrationRepositoryId: repository.id,
        externalId: "81",
      }),
    ]);
    expect(
      await db.query.scmSyncJobTable.findFirst({
        where: eq(schema.scmSyncJobTable.id, job.id),
      }),
    ).toEqual(expect.objectContaining({ status: "completed", attempts: 2 }));
  });
});
