import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { parseGitLabLinkMetadata } from "../../apps/api/src/plugins/gitlab/link";
import {
  type GitLabWebhookBinding,
  handleGitLabMergeRequestHook,
} from "../../apps/api/src/plugins/gitlab/webhook-events";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function createMergeRequestFixture() {
  const member = await createWorkspaceMember({ role: "owner" });
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
    slug: "KAN",
  });
  const [integration] = await db
    .insert(schema.integrationTable)
    .values({
      projectId: project.id,
      type: "gitlab",
      config: JSON.stringify({ multiRepository: true }),
    })
    .returning();
  const repositories = await db
    .insert(schema.integrationRepositoryTable)
    .values([
      {
        integrationId: integration.id,
        provider: "gitlab",
        remoteOrigin: "https://gitlab.example.test",
        providerRepositoryId: "451",
        fullPath: "team/frontend",
        webUrl: "https://gitlab.example.test/team/frontend",
        defaultBranch: "main",
      },
      {
        integrationId: integration.id,
        provider: "gitlab",
        remoteOrigin: "https://gitlab.example.test",
        providerRepositoryId: "452",
        fullPath: "team/backend",
        webUrl: "https://gitlab.example.test/team/backend",
        defaultBranch: "main",
      },
    ])
    .returning();
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      number: 42,
      title: "Ship repository routing",
      status: columns.todo.slug,
      columnId: columns.todo.id,
    })
    .returning();

  const binding = (repository: (typeof repositories)[number]) =>
    ({
      repository: {
        id: repository.id,
        integrationId: repository.integrationId,
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
      connection: { metadata: { gitlabUsername: "kaneo-bot" } },
    }) satisfies GitLabWebhookBinding;

  return {
    task,
    columns,
    repositories,
    bindings: repositories.map(binding),
  };
}

function mergeRequestPayload(input: {
  providerRepositoryId: string;
  iid?: number;
  state: "opened" | "closed" | "merged";
  action?: string;
  draft?: boolean;
}) {
  const iid = input.iid ?? 11;
  return {
    object_kind: "merge_request" as const,
    user: { id: 7, username: "developer", name: "Developer" },
    project: { id: Number(input.providerRepositoryId) },
    object_attributes: {
      id: Number(input.providerRepositoryId) * 1_000 + iid,
      iid,
      action: input.action ?? input.state,
      state: input.state,
      title: "KAN-42 Ship repository routing",
      description: "Coordinates changes across two repositories.",
      url: `https://gitlab.example.test/project/-/merge_requests/${iid}`,
      source_branch: "kan-42-repository-routing",
      target_branch: "main",
      draft: input.draft ?? false,
      merged_at: input.state === "merged" ? "2026-08-09T20:00:00.000Z" : null,
      closed_at: input.state === "closed" ? "2026-08-09T20:00:00.000Z" : null,
    },
  };
}

async function taskStatus(taskId: string) {
  const task = await db.query.taskTable.findFirst({
    where: eq(schema.taskTable.id, taskId),
  });
  return task?.status;
}

describe("API integration: GitLab merge request lifecycle", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("tracks repository-scoped MRs and finishes only after the last open MR merges", async () => {
    const { task, columns, repositories, bindings } =
      await createMergeRequestFixture();
    const [frontend, backend] = repositories;
    const [frontendBinding, backendBinding] = bindings;

    await handleGitLabMergeRequestHook(
      mergeRequestPayload({
        providerRepositoryId: frontend.providerRepositoryId,
        state: "opened",
        action: "open",
        draft: true,
      }),
      frontendBinding,
    );
    expect(await taskStatus(task.id)).toBe(columns.inReview.slug);

    let links = await db.query.externalLinkTable.findMany({
      where: eq(schema.externalLinkTable.taskId, task.id),
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual(
      expect.objectContaining({
        integrationRepositoryId: frontend.id,
        externalId: "11",
        resourceType: "pull_request",
      }),
    );
    expect(parseGitLabLinkMetadata(links[0]?.metadata ?? null)).toEqual(
      expect.objectContaining({
        state: "opened",
        draft: true,
        merged: false,
        branch: "kan-42-repository-routing",
      }),
    );

    await handleGitLabMergeRequestHook(
      mergeRequestPayload({
        providerRepositoryId: frontend.providerRepositoryId,
        state: "closed",
        action: "close",
      }),
      frontendBinding,
    );
    expect(await taskStatus(task.id)).toBe(columns.inReview.slug);

    await handleGitLabMergeRequestHook(
      mergeRequestPayload({
        providerRepositoryId: frontend.providerRepositoryId,
        state: "opened",
        action: "reopen",
      }),
      frontendBinding,
    );
    await handleGitLabMergeRequestHook(
      mergeRequestPayload({
        providerRepositoryId: backend.providerRepositoryId,
        state: "opened",
        action: "open",
      }),
      backendBinding,
    );

    links = await db.query.externalLinkTable.findMany({
      where: eq(schema.externalLinkTable.taskId, task.id),
    });
    expect(links).toHaveLength(2);
    expect(new Set(links.map((link) => link.integrationRepositoryId))).toEqual(
      new Set([frontend.id, backend.id]),
    );
    expect(new Set(links.map((link) => link.externalId))).toEqual(
      new Set(["11"]),
    );

    await handleGitLabMergeRequestHook(
      mergeRequestPayload({
        providerRepositoryId: frontend.providerRepositoryId,
        state: "merged",
        action: "merge",
      }),
      frontendBinding,
    );
    expect(await taskStatus(task.id)).toBe(columns.inReview.slug);

    await handleGitLabMergeRequestHook(
      mergeRequestPayload({
        providerRepositoryId: backend.providerRepositoryId,
        state: "merged",
        action: "merge",
      }),
      backendBinding,
    );
    expect(await taskStatus(task.id)).toBe(columns.done.slug);

    links = await db.query.externalLinkTable.findMany({
      where: eq(schema.externalLinkTable.taskId, task.id),
    });
    expect(links.map((link) => parseGitLabLinkMetadata(link.metadata))).toEqual(
      [
        expect.objectContaining({
          state: "merged",
          merged: true,
          draft: false,
        }),
        expect.objectContaining({
          state: "merged",
          merged: true,
          draft: false,
        }),
      ],
    );
  });
});
