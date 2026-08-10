import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { formatIssueBody } from "../../apps/api/src/plugins/github/utils/format";
import { handleTaskCreated } from "../../apps/api/src/plugins/gitlab/events/task-created";
import { formatKaneoGeneratedGitLabNote } from "../../apps/api/src/plugins/gitlab/notes";
import {
  type GitLabWebhookBinding,
  handleGitLabIssueHook,
  handleGitLabNoteHook,
} from "../../apps/api/src/plugins/gitlab/webhook-events";
import type {
  PluginContext,
  TaskCreatedEvent,
} from "../../apps/api/src/plugins/types";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const originalPrivateDestinations =
  process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS;

async function createGitLabBinding() {
  const member = await createWorkspaceMember({ role: "owner" });
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [integration] = await db
    .insert(schema.integrationTable)
    .values({
      projectId: project.id,
      type: "gitlab",
      config: JSON.stringify({}),
    })
    .returning();
  const [repository] = await db
    .insert(schema.integrationRepositoryTable)
    .values({
      integrationId: integration.id,
      provider: "gitlab",
      remoteOrigin: "https://gitlab.example",
      providerRepositoryId: "17",
      fullPath: "group/project",
      webUrl: "https://gitlab.example/group/project",
      defaultBranch: "main",
    })
    .returning();

  const binding: GitLabWebhookBinding = {
    repository: {
      id: repository.id,
      integrationId: integration.id,
      providerRepositoryId: repository.providerRepositoryId,
      webUrl: repository.webUrl,
      fullPath: repository.fullPath,
    },
    integration: {
      id: integration.id,
      projectId: project.id,
      project: {
        id: project.id,
        slug: project.slug,
        workspaceId: project.workspaceId,
      },
    },
    connection: { metadata: null },
  };
  return { binding, integration, project, repository };
}

function issueHook(description: string | null = "Imported description") {
  return {
    object_kind: "issue" as const,
    user: { id: 5, username: "developer", name: "Developer" },
    project: {
      id: 17,
      web_url: "https://gitlab.example/group/project",
      path_with_namespace: "group/project",
    },
    labels: [],
    object_attributes: {
      id: 901,
      iid: 23,
      project_id: 17,
      action: "open" as const,
      state: "opened" as const,
      title: "GitLab issue",
      description,
      url: "https://gitlab.example/group/project/-/issues/23",
    },
  };
}

function noteHook(id: number, note: string) {
  return {
    object_kind: "note" as const,
    user: { id: 7, username: "connection-owner", name: "Connection Owner" },
    project: { id: 17 },
    issue: { id: 901, iid: 23 },
    object_attributes: {
      id,
      note,
      noteable_type: "Issue",
      noteable_iid: 23,
      url: `https://gitlab.example/group/project/-/issues/23#note_${id}`,
      system: false,
    },
  };
}

describe("API integration: GitLab webhook idempotency", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPrivateDestinations === undefined) {
      delete process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS;
    } else {
      process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS =
        originalPrivateDestinations;
    }
  });

  it("creates the inbound task and external link atomically under retries", async () => {
    const { binding, project } = await createGitLabBinding();
    const deliveries = await Promise.allSettled([
      handleGitLabIssueHook(issueHook(), binding),
      handleGitLabIssueHook(issueHook(), binding),
    ]);
    expect(deliveries.some((delivery) => delivery.status === "fulfilled")).toBe(
      true,
    );

    // A failed concurrent delivery is retried after the winning transaction.
    await handleGitLabIssueHook(issueHook(), binding);

    const tasks = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    const links = await db
      .select()
      .from(schema.externalLinkTable)
      .where(
        and(
          eq(
            schema.externalLinkTable.integrationRepositoryId,
            binding.repository.id,
          ),
          eq(schema.externalLinkTable.resourceType, "issue"),
          eq(schema.externalLinkTable.externalId, "23"),
        ),
      );

    expect(tasks).toHaveLength(1);
    expect(links).toHaveLength(1);
    expect(links[0]?.taskId).toBe(tasks[0]?.id);
  });

  it("correlates Kaneo-created issues by task marker", async () => {
    const { binding, project } = await createGitLabBinding();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Existing Kaneo task",
        description: "Original description",
        status: "to-do",
        number: 10,
      })
      .returning();
    const [job] = await db
      .insert(schema.scmSyncJobTable)
      .values({
        taskId: task.id,
        integrationRepositoryId: binding.repository.id,
        operation: "create_issue",
        dedupeKey: `create-issue:${task.id}:${binding.repository.id}`,
        payload: {},
      })
      .returning();

    await handleGitLabIssueHook(
      issueHook(formatIssueBody("Original description", task.id, job.id)),
      binding,
    );

    const tasks = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    const [link] = await db
      .select()
      .from(schema.externalLinkTable)
      .where(
        and(
          eq(
            schema.externalLinkTable.integrationRepositoryId,
            binding.repository.id,
          ),
          eq(schema.externalLinkTable.resourceType, "issue"),
          eq(schema.externalLinkTable.externalId, "23"),
        ),
      );

    expect(tasks).toHaveLength(1);
    expect(link?.taskId).toBe(task.id);
  });

  it("does not trust a task marker whose sync job belongs to another task", async () => {
    const { binding, project } = await createGitLabBinding();
    const [targetTask, jobTask] = await db
      .insert(schema.taskTable)
      .values([
        {
          projectId: project.id,
          title: "Marker target",
          status: "to-do",
          number: 10,
        },
        {
          projectId: project.id,
          title: "Job owner",
          status: "to-do",
          number: 11,
        },
      ])
      .returning();
    const [job] = await db
      .insert(schema.scmSyncJobTable)
      .values({
        taskId: jobTask.id,
        integrationRepositoryId: binding.repository.id,
        operation: "create_issue",
        dedupeKey: `create-issue:${jobTask.id}:${binding.repository.id}`,
        payload: {},
      })
      .returning();

    await handleGitLabIssueHook(
      issueHook(formatIssueBody("Spoofed marker", targetTask.id, job.id)),
      binding,
    );

    const [link] = await db
      .select()
      .from(schema.externalLinkTable)
      .where(
        and(
          eq(
            schema.externalLinkTable.integrationRepositoryId,
            binding.repository.id,
          ),
          eq(schema.externalLinkTable.resourceType, "issue"),
          eq(schema.externalLinkTable.externalId, "23"),
        ),
      );
    expect(link?.taskId).not.toBe(targetTask.id);
    expect(link?.taskId).not.toBe(jobTask.id);
  });

  it("accepts a matching link created by the issue-opened webhook race", async () => {
    process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS = "true";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { integration, project, repository } = await createGitLabBinding();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Outbound task",
        status: "to-do",
        number: 12,
      })
      .returning();
    const event: TaskCreatedEvent = {
      taskId: task.id,
      projectId: project.id,
      userId: "user_123",
      title: task.title,
      description: null,
      priority: null,
      status: task.status,
      number: task.number ?? 12,
      scmSyncJobId: "job_race",
    };
    const context = {
      integrationId: integration.id,
      integrationRepositoryId: repository.id,
      projectId: project.id,
      config: {},
      repository: {
        id: repository.id,
        connectionId: null,
        provider: "gitlab",
        providerRepositoryId: repository.providerRepositoryId,
        fullPath: repository.fullPath,
        remoteOrigin: repository.remoteOrigin,
        webUrl: repository.webUrl,
        defaultBranch: repository.defaultBranch,
        metadata: null,
      },
      connection: {
        id: "connection_123",
        authType: "token",
        publicUrl: "https://gitlab.example",
        internalUrl: "https://gitlab.example",
        credential: { type: "token", accessToken: "secret" },
      },
    } satisfies PluginContext;
    const remoteIssue = {
      id: 901,
      iid: 23,
      project_id: 17,
      title: task.title,
      description: formatIssueBody(null, task.id, event.scmSyncJobId),
      state: "opened",
      web_url: "https://gitlab.example/group/project/-/issues/23",
      labels: [],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/projects/17/issues")) {
        await db.insert(schema.externalLinkTable).values({
          taskId: task.id,
          integrationId: integration.id,
          integrationRepositoryId: repository.id,
          resourceType: "issue",
          externalId: "23",
          url: remoteIssue.web_url,
          title: remoteIssue.title,
          metadata: JSON.stringify({ createdFrom: "kaneo" }),
        });
        return Response.json(remoteIssue);
      }
      return new Response("Decoration unavailable", { status: 503 });
    });

    await expect(handleTaskCreated(event, context)).resolves.toBeUndefined();
    const links = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(links).toHaveLength(1);
    expect(links[0]?.externalId).toBe("23");
  });

  it("keeps manual owner notes and ignores explicitly marked Kaneo notes", async () => {
    const { binding } = await createGitLabBinding();
    binding.connection.metadata = { gitlabUsername: "connection-owner" };
    await handleGitLabIssueHook(issueHook(), binding);

    await handleGitLabNoteHook(noteHook(701, "Manual owner comment"), binding);
    await handleGitLabNoteHook(
      noteHook(702, formatKaneoGeneratedGitLabNote("Kaneo echo")),
      binding,
    );

    const activities = await db.select().from(schema.activityTable);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      content: "Manual owner comment",
      externalUserName: "connection-owner",
      externalSource: "gitlab",
    });
  });
});
