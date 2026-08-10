import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

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
});
