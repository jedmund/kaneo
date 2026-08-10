import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileTaskCreated } from "../../../../apps/api/src/plugins/gitlab/events/task-created";
import type {
  PluginContext,
  TaskCreatedEvent,
} from "../../../../apps/api/src/plugins/types";

const originalPrivateDestinations =
  process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPrivateDestinations === undefined) {
    delete process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS;
  } else {
    process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS =
      originalPrivateDestinations;
  }
});

const event: TaskCreatedEvent = {
  taskId: "task_123",
  projectId: "project_123",
  userId: "user_123",
  title: "Avoid a duplicate",
  description: null,
  priority: null,
  status: "to-do",
  number: 1,
  scmSyncJobId: "sync_job_456",
};

const context: PluginContext = {
  integrationId: "integration_123",
  integrationRepositoryId: "repository_123",
  projectId: "project_123",
  config: {},
  repository: {
    id: "repository_123",
    connectionId: "connection_123",
    provider: "gitlab",
    providerRepositoryId: "17",
    fullPath: "group/project",
    remoteOrigin: "https://gitlab.example",
    webUrl: "https://gitlab.example/group/project",
    defaultBranch: "main",
    metadata: null,
  },
  connection: {
    id: "connection_123",
    authType: "token",
    publicUrl: "https://gitlab.example",
    internalUrl: "https://gitlab.example",
    credential: { type: "token", accessToken: "secret" },
  },
};

describe("GitLab task creation reconciliation", () => {
  it("recovers an issue carrying the durable sync job marker", async () => {
    process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS = "true";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 9001,
            iid: 23,
            project_id: 17,
            title: "Avoid a duplicate",
            description:
              "<sub>Task: task_123</sub>\n<!-- kaneo-scm-sync-job: sync_job_456 -->",
            state: "opened",
            web_url: "https://gitlab.example/group/project/-/issues/23",
            labels: [],
          },
        ]),
        { status: 200 },
      ),
    );

    await expect(reconcileTaskCreated(event, context)).resolves.toMatchObject({
      externalId: "23",
      metadata: {
        globalId: 9001,
        recoveredFromSyncJob: "sync_job_456",
      },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/projects/17/issues?state=all",
    );
  });

  it("requires the durable job ID", async () => {
    await expect(
      reconcileTaskCreated({ ...event, scmSyncJobId: undefined }, context),
    ).rejects.toThrow(/sync job ID/);
  });
});
