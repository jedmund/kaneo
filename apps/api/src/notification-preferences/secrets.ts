import { createEncryptedSecretCodec } from "../utils/encrypted-secret";

const codec = createEncryptedSecretCodec({
  prefix: "enc:v1:",
  keyEnvironmentVariable: "NOTIFICATION_SECRET_ENCRYPTION_KEY",
  missingKeyMessage:
    "NOTIFICATION_SECRET_ENCRYPTION_KEY is required to store encrypted notification secrets",
  invalidPayloadMessage: "Invalid encrypted notification secret payload",
  decryptionFailedMessage: "Failed to decrypt notification secret",
});

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return codec.isEncrypted(value);
}

export function encryptSecret(
  value: string | null | undefined,
): string | null | undefined {
  return codec.encrypt(value);
}

export function decryptSecret(
  value: string | null | undefined,
): string | null | undefined {
  return codec.decrypt(value);
}
