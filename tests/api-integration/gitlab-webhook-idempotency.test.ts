import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { formatIssueBody } from "../../apps/api/src/plugins/github/utils/format";
import { formatKaneoGeneratedGitLabNote } from "../../apps/api/src/plugins/gitlab/notes";
import {
  type GitLabWebhookBinding,
  handleGitLabIssueHook,
  handleGitLabNoteHook,
} from "../../apps/api/src/plugins/gitlab/webhook-events";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

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
  return { binding, project };
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

    await handleGitLabIssueHook(
      issueHook(formatIssueBody("Original description", task.id, "job_123")),
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
