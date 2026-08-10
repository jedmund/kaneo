import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { handleGitLabWebhookRequest } from "../../apps/api/src/plugins/gitlab/webhook-handler";
import {
  encryptScmCredential,
  encryptScmSecret,
} from "../../apps/api/src/scm/secrets";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const signingKey = Buffer.alloc(32, 9);
const signingToken = `whsec_${signingKey.toString("base64")}`;

function signedHeaders(
  rawBody: string,
  deliveryId: string,
  timestamp = Math.floor(Date.now() / 1_000),
) {
  const webhookTimestamp = String(timestamp);
  const signature = createHmac("sha256", signingKey)
    .update(`${deliveryId}.${webhookTimestamp}.${rawBody}`)
    .digest("base64");
  return {
    webhookId: deliveryId,
    webhookTimestamp,
    webhookSignature: `v1,${signature}`,
  };
}

async function createGitLabBinding() {
  const member = await createWorkspaceMember({ role: "owner" });
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
    slug: "KAN",
  });
  const providerRepositoryId = "451";

  const [connection] = await db
    .insert(schema.scmConnectionTable)
    .values({
      workspaceId: member.workspace.id,
      provider: "gitlab",
      name: "Integration GitLab",
      authType: "token",
      publicUrl: "https://gitlab.example.test",
      internalUrl: "https://gitlab.example.test",
      credentialCiphertext: encryptScmCredential({
        type: "token",
        accessToken: "glpat-integration-test",
      }),
      ownerUserId: member.user.id,
      metadata: { gitlabUsername: "kaneo-bot" },
    })
    .returning();
  const [integration] = await db
    .insert(schema.integrationTable)
    .values({
      projectId: project.id,
      type: "gitlab",
      config: JSON.stringify({ multiRepository: true }),
    })
    .returning();
  const [repository] = await db
    .insert(schema.integrationRepositoryTable)
    .values({
      integrationId: integration.id,
      connectionId: connection.id,
      provider: "gitlab",
      remoteOrigin: connection.publicUrl,
      providerRepositoryId,
      fullPath: "team/security-fixture",
      webUrl: "https://gitlab.example.test/team/security-fixture",
      defaultBranch: "main",
      webhookId: "99",
      webhookSecretCiphertext: encryptScmSecret(signingToken),
    })
    .returning();

  return { repository, providerRepositoryId };
}

function pushBody(providerRepositoryId: string, ref = "refs/heads/main") {
  return JSON.stringify({
    object_kind: "push",
    ref,
    checkout_sha: "a".repeat(40),
    project: { id: Number(providerRepositoryId) },
    commits: [],
  });
}

describe("API integration: GitLab webhook delivery security", () => {
  beforeEach(async () => {
    vi.stubEnv(
      "SCM_SECRET_ENCRYPTION_KEY",
      "integration-test-scm-key-with-at-least-32-characters",
    );
    await resetTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("completes the first delivery and deduplicates an exact replay", async () => {
    const { repository, providerRepositoryId } = await createGitLabBinding();
    const rawBody = pushBody(providerRepositoryId);
    const headers = signedHeaders(rawBody, "delivery-replay");

    await expect(
      handleGitLabWebhookRequest({
        repositoryId: repository.id,
        rawBody,
        headers,
      }),
    ).resolves.toEqual({ duplicate: false });
    await expect(
      handleGitLabWebhookRequest({
        repositoryId: repository.id,
        rawBody,
        headers,
      }),
    ).resolves.toEqual({ duplicate: true });

    const deliveries = await db.select().from(schema.scmWebhookDeliveryTable);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        integrationRepositoryId: repository.id,
        deliveryId: "delivery-replay",
        eventName: "push",
        status: "completed",
        lastError: null,
        processedAt: expect.any(Date),
      }),
    );
  });

  it("rejects a delivery ID reused with different signed content", async () => {
    const { repository, providerRepositoryId } = await createGitLabBinding();
    const firstBody = pushBody(providerRepositoryId);
    const changedBody = pushBody(providerRepositoryId, "refs/heads/master");

    await handleGitLabWebhookRequest({
      repositoryId: repository.id,
      rawBody: firstBody,
      headers: signedHeaders(firstBody, "delivery-collision"),
    });

    await expect(
      handleGitLabWebhookRequest({
        repositoryId: repository.id,
        rawBody: changedBody,
        headers: signedHeaders(changedBody, "delivery-collision"),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.scmWebhookDeliveryTable)).toHaveLength(
      1,
    );
  });

  it("does not claim invalid, stale, or malformed signed requests", async () => {
    const { repository, providerRepositoryId } = await createGitLabBinding();
    const rawBody = pushBody(providerRepositoryId);

    await expect(
      handleGitLabWebhookRequest({
        repositoryId: repository.id,
        rawBody,
        headers: {
          ...signedHeaders(rawBody, "delivery-invalid"),
          webhookSignature: "v1,invalid",
        },
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      handleGitLabWebhookRequest({
        repositoryId: repository.id,
        rawBody,
        headers: signedHeaders(
          rawBody,
          "delivery-stale",
          Math.floor(Date.now() / 1_000) - 301,
        ),
      }),
    ).rejects.toMatchObject({ status: 401 });

    const malformed = "not-json";
    await expect(
      handleGitLabWebhookRequest({
        repositoryId: repository.id,
        rawBody: malformed,
        headers: signedHeaders(malformed, "delivery-malformed"),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await db.select().from(schema.scmWebhookDeliveryTable)).toEqual([]);
  });

  it("reclaims failed deliveries while retaining one durable ledger row", async () => {
    const { repository, providerRepositoryId } = await createGitLabBinding();
    const rawBody = pushBody(String(Number(providerRepositoryId) + 1));
    const headers = signedHeaders(rawBody, "delivery-retry");

    await expect(
      handleGitLabWebhookRequest({
        repositoryId: repository.id,
        rawBody,
        headers,
      }),
    ).rejects.toMatchObject({ status: 500 });
    await expect(
      handleGitLabWebhookRequest({
        repositoryId: repository.id,
        rawBody,
        headers,
      }),
    ).rejects.toMatchObject({ status: 500 });

    const deliveries = await db
      .select()
      .from(schema.scmWebhookDeliveryTable)
      .where(
        eq(
          schema.scmWebhookDeliveryTable.integrationRepositoryId,
          repository.id,
        ),
      );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        deliveryId: "delivery-retry",
        status: "failed",
        lastError: "GitLab webhook project does not match this repository",
        processedAt: null,
      }),
    );
  });
});
