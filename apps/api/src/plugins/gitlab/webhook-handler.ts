import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  integrationRepositoryTable,
  scmWebhookDeliveryTable,
} from "../../database/schema";
import { decryptScmSecret } from "../../scm/secrets";
import {
  type GitLabWebhookHeaders,
  verifyGitLabWebhookSignature,
} from "./verify-signature";
import { dispatchGitLabWebhook, gitLabObjectKind } from "./webhook-events";

async function requireWebhookBinding(repositoryId: string) {
  const binding = await db.query.integrationRepositoryTable.findFirst({
    where: and(
      eq(integrationRepositoryTable.id, repositoryId),
      eq(integrationRepositoryTable.provider, "gitlab"),
      eq(integrationRepositoryTable.isActive, true),
    ),
    with: {
      integration: { with: { project: true } },
      connection: true,
    },
  });
  if (
    !binding?.connection ||
    binding.integration.type !== "gitlab" ||
    !binding.integration.isActive ||
    !binding.webhookSecretCiphertext
  ) {
    throw new HTTPException(404, {
      message: "GitLab webhook repository not found",
    });
  }
  return {
    repository: binding,
    integration: binding.integration,
    connection: binding.connection,
    webhookSecretCiphertext: binding.webhookSecretCiphertext,
  };
}

async function claimDelivery(input: {
  repositoryId: string;
  deliveryId: string;
  eventName: string;
  bodySha256: string;
}) {
  const [created] = await db
    .insert(scmWebhookDeliveryTable)
    .values({
      integrationRepositoryId: input.repositoryId,
      provider: "gitlab",
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      bodySha256: input.bodySha256,
      status: "processing",
    })
    .onConflictDoNothing({
      target: [
        scmWebhookDeliveryTable.integrationRepositoryId,
        scmWebhookDeliveryTable.deliveryId,
      ],
    })
    .returning();
  if (created) return { delivery: created, duplicate: false };

  const existing = await db.query.scmWebhookDeliveryTable.findFirst({
    where: and(
      eq(scmWebhookDeliveryTable.integrationRepositoryId, input.repositoryId),
      eq(scmWebhookDeliveryTable.deliveryId, input.deliveryId),
    ),
  });
  if (!existing) {
    throw new Error("GitLab delivery claim disappeared");
  }
  if (
    existing.bodySha256 !== input.bodySha256 ||
    existing.eventName !== input.eventName
  ) {
    throw new HTTPException(409, {
      message: "GitLab delivery ID was reused with different content",
    });
  }

  const staleProcessing =
    existing.status === "processing" &&
    existing.updatedAt < new Date(Date.now() - 10 * 60 * 1000);
  if (existing.status === "failed" || staleProcessing) {
    const [retried] = await db
      .update(scmWebhookDeliveryTable)
      .set({ status: "processing", lastError: null })
      .where(
        and(
          eq(scmWebhookDeliveryTable.id, existing.id),
          ...(existing.status === "failed"
            ? [eq(scmWebhookDeliveryTable.status, "failed")]
            : [
                eq(scmWebhookDeliveryTable.status, "processing"),
                lt(
                  scmWebhookDeliveryTable.updatedAt,
                  new Date(Date.now() - 10 * 60 * 1000),
                ),
              ]),
        ),
      )
      .returning();
    if (retried) return { delivery: retried, duplicate: false };
  }

  return { delivery: existing, duplicate: true };
}

export async function handleGitLabWebhookRequest(input: {
  repositoryId: string;
  rawBody: string;
  headers: GitLabWebhookHeaders;
}) {
  const binding = await requireWebhookBinding(input.repositoryId);
  const signingToken = decryptScmSecret(binding.webhookSecretCiphertext);
  if (
    !verifyGitLabWebhookSignature({
      rawBody: input.rawBody,
      signingToken,
      headers: input.headers,
    })
  ) {
    throw new HTTPException(401, {
      message: "Invalid GitLab webhook signature",
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody) as unknown;
  } catch {
    throw new HTTPException(400, { message: "Invalid GitLab webhook JSON" });
  }
  const eventName = gitLabObjectKind(payload);
  if (!eventName || !input.headers.webhookId) {
    throw new HTTPException(400, {
      message: "Invalid GitLab webhook payload",
    });
  }

  const claimed = await claimDelivery({
    repositoryId: binding.repository.id,
    deliveryId: input.headers.webhookId,
    eventName,
    bodySha256: createHash("sha256").update(input.rawBody).digest("hex"),
  });
  if (claimed.duplicate) {
    return { duplicate: true };
  }

  try {
    await dispatchGitLabWebhook(payload, binding);
    await db
      .update(scmWebhookDeliveryTable)
      .set({
        status: "completed",
        processedAt: new Date(),
        lastError: null,
      })
      .where(eq(scmWebhookDeliveryTable.id, claimed.delivery.id));
    return { duplicate: false };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 2_000) : String(error);
    await db
      .update(scmWebhookDeliveryTable)
      .set({ status: "failed", lastError: message })
      .where(eq(scmWebhookDeliveryTable.id, claimed.delivery.id));
    console.error("GitLab webhook processing failed", {
      repositoryId: binding.repository.id,
      deliveryId: input.headers.webhookId,
      eventName,
      error: message,
    });
    throw new HTTPException(500, {
      message: "GitLab webhook processing failed",
    });
  }
}
