import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type GitLabWebhookHeaders = {
  webhookId: string | undefined;
  webhookTimestamp: string | undefined;
  webhookSignature: string | undefined;
};

function decodeSigningKey(signingToken: string) {
  if (!signingToken.startsWith("whsec_")) return null;
  const encoded = signingToken.slice("whsec_".length);
  const key = Buffer.from(encoded, "base64");
  return key.length === 32 ? key : null;
}

function signaturesFromHeader(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => part.split(",", 2))
    .filter(
      (entry): entry is [string, string] =>
        entry.length === 2 && entry[0] === "v1" && Boolean(entry[1]),
    )
    .map(([, signature]) => signature);
}

export function verifyGitLabWebhookSignature(input: {
  rawBody: string;
  signingToken: string;
  headers: GitLabWebhookHeaders;
  now?: Date;
  toleranceSeconds?: number;
}) {
  const { webhookId, webhookTimestamp, webhookSignature } = input.headers;
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;

  const timestamp = Number(webhookTimestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const key = decodeSigningKey(input.signingToken);
  if (!key) return false;
  const expected = createHmac("sha256", key)
    .update(`${webhookId}.${webhookTimestamp}.${input.rawBody}`)
    .digest();

  for (const candidate of signaturesFromHeader(webhookSignature)) {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(candidate, "base64");
    } catch {
      continue;
    }
    if (
      decoded.length === expected.length &&
      timingSafeEqual(decoded, expected)
    ) {
      return true;
    }
  }
  return false;
}
