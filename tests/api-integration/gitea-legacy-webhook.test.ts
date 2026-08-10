import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { handleGiteaWebhookRequest } from "../../apps/api/src/plugins/gitea/webhook-handler";
import { encryptScmSecret } from "../../apps/api/src/scm/secrets";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const originalEncryptionKey = process.env.SCM_SECRET_ENCRYPTION_KEY;

describe("API integration: legacy Gitea webhooks", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    process.env.SCM_SECRET_ENCRYPTION_KEY =
      "gitea-legacy-webhook-integration-test-key";
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.SCM_SECRET_ENCRYPTION_KEY;
    } else {
      process.env.SCM_SECRET_ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  it("uses the migrated repository secret for an integration-ID URL", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "gitea",
        config: JSON.stringify({
          baseUrl: "https://gitea.example",
          repositoryOwner: "atelier",
          repositoryName: "kaneo",
        }),
      })
      .returning();
    await db.insert(schema.integrationRepositoryTable).values({
      integrationId: integration.id,
      provider: "gitea",
      remoteOrigin: "https://gitea.example",
      providerRepositoryId: "42",
      fullPath: "atelier/kaneo",
      webUrl: "https://gitea.example/atelier/kaneo",
      webhookSecretCiphertext: encryptScmSecret("legacy-hook-secret"),
    });
    const rawBody = JSON.stringify({
      repository: {
        id: 42,
        full_name: "atelier/kaneo",
        name: "kaneo",
        owner: { login: "atelier" },
      },
    });
    const signature = createHmac("sha256", "legacy-hook-secret")
      .update(rawBody)
      .digest("hex");

    await expect(
      handleGiteaWebhookRequest(
        integration.id,
        rawBody,
        signature,
        "repository",
      ),
    ).resolves.toEqual({ success: true });
  });
});
