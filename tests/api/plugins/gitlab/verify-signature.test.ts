import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitLabWebhookSignature } from "../../../../apps/api/src/plugins/gitlab/verify-signature";

const signingToken = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const rawBody = '{"object_kind":"issue","value":"untouched"}';
const webhookId = "delivery-123";
const webhookTimestamp = "1786334400";

function signature(body = rawBody) {
  return createHmac("sha256", Buffer.alloc(32, 7))
    .update(`${webhookId}.${webhookTimestamp}.${body}`)
    .digest("base64");
}

describe("GitLab Standard Webhooks signatures", () => {
  it("verifies v1 over delivery id, timestamp, and the exact raw body", () => {
    expect(
      verifyGitLabWebhookSignature({
        rawBody,
        signingToken,
        headers: {
          webhookId,
          webhookTimestamp,
          webhookSignature: `v1,${signature()}`,
        },
        now: new Date(Number(webhookTimestamp) * 1000),
      }),
    ).toBe(true);
  });

  it("accepts any matching signature during secret rotation", () => {
    expect(
      verifyGitLabWebhookSignature({
        rawBody,
        signingToken,
        headers: {
          webhookId,
          webhookTimestamp,
          webhookSignature: `v1,invalid v1,${signature()}`,
        },
        now: new Date(Number(webhookTimestamp) * 1000),
      }),
    ).toBe(true);
  });

  it("rejects modified bodies, missing headers, invalid keys, and stale events", () => {
    const headers = {
      webhookId,
      webhookTimestamp,
      webhookSignature: `v1,${signature()}`,
    };
    expect(
      verifyGitLabWebhookSignature({
        rawBody: `${rawBody} `,
        signingToken,
        headers,
        now: new Date(Number(webhookTimestamp) * 1000),
      }),
    ).toBe(false);
    expect(
      verifyGitLabWebhookSignature({
        rawBody,
        signingToken,
        headers: { ...headers, webhookId: undefined },
        now: new Date(Number(webhookTimestamp) * 1000),
      }),
    ).toBe(false);
    expect(
      verifyGitLabWebhookSignature({
        rawBody,
        signingToken: "whsec_invalid",
        headers,
        now: new Date(Number(webhookTimestamp) * 1000),
      }),
    ).toBe(false);
    expect(
      verifyGitLabWebhookSignature({
        rawBody,
        signingToken,
        headers,
        now: new Date((Number(webhookTimestamp) + 301) * 1000),
      }),
    ).toBe(false);
  });
});
