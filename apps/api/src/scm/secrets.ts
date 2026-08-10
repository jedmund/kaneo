import { createEncryptedSecretCodec } from "../utils/encrypted-secret";

const codec = createEncryptedSecretCodec({
  prefix: "scm:v1:",
  keyEnvironmentVariable: "SCM_SECRET_ENCRYPTION_KEY",
  missingKeyMessage:
    "SCM_SECRET_ENCRYPTION_KEY is required to store SCM credentials",
  invalidPayloadMessage: "Invalid encrypted SCM credential payload",
  decryptionFailedMessage: "Failed to decrypt SCM credential",
});

const secretCodec = createEncryptedSecretCodec({
  prefix: "scm-secret:v1:",
  keyEnvironmentVariable: "SCM_SECRET_ENCRYPTION_KEY",
  missingKeyMessage:
    "SCM_SECRET_ENCRYPTION_KEY is required to store SCM secrets",
  invalidPayloadMessage: "Invalid encrypted SCM secret payload",
  decryptionFailedMessage: "Failed to decrypt SCM secret",
});

export type ScmCredential =
  | { type: "token"; accessToken: string }
  | {
      type: "oauth";
      accessToken: string;
      refreshToken: string;
      expiresAt: string;
    };

export function encryptScmCredential(credential: ScmCredential): string {
  const encrypted = codec.encrypt(JSON.stringify(credential));
  if (!encrypted) throw new Error("Failed to encrypt SCM credential");
  return encrypted;
}

export function decryptScmCredential(ciphertext: string): ScmCredential {
  if (!codec.isEncrypted(ciphertext)) {
    throw new Error("SCM credential is not encrypted");
  }
  const decrypted = codec.decrypt(ciphertext);
  if (!decrypted) throw new Error("SCM credential is empty");

  const value = JSON.parse(decrypted) as Partial<ScmCredential>;
  if (
    (value.type !== "token" && value.type !== "oauth") ||
    typeof value.accessToken !== "string" ||
    value.accessToken.length === 0
  ) {
    throw new Error("SCM credential payload is invalid");
  }
  if (
    value.type === "oauth" &&
    (typeof value.refreshToken !== "string" ||
      typeof value.expiresAt !== "string")
  ) {
    throw new Error("SCM OAuth credential payload is invalid");
  }

  return value as ScmCredential;
}

export function maskScmToken(token: string): string {
  if (token.length <= 8) return "••••••••";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function encryptScmSecret(value: string): string {
  const encrypted = secretCodec.encrypt(value);
  if (!encrypted) throw new Error("Failed to encrypt SCM secret");
  return encrypted;
}

export function decryptScmSecret(ciphertext: string): string {
  if (!secretCodec.isEncrypted(ciphertext)) {
    throw new Error("SCM secret is not encrypted");
  }
  const decrypted = secretCodec.decrypt(ciphertext);
  if (!decrypted) throw new Error("SCM secret is empty");
  return decrypted;
}
