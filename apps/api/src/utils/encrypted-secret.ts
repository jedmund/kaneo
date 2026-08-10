import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { HTTPException } from "hono/http-exception";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

type EncryptedSecretCodecOptions = {
  prefix: string;
  keyEnvironmentVariable: string;
  missingKeyMessage: string;
  invalidPayloadMessage: string;
  decryptionFailedMessage: string;
};

function encodePart(value: Buffer) {
  return value.toString("base64url");
}

function decodePart(value: string) {
  return Buffer.from(value, "base64url");
}

/**
 * Creates an AES-256-GCM codec whose key is supplied through one environment
 * variable. The encoded format is prefix + base64url(iv.tag.ciphertext).
 *
 * Key material is hashed to 32 bytes to preserve compatibility with Kaneo's
 * original notification-secret format while still accepting high-entropy
 * base64, hex, or passphrase-style deployment secrets.
 */
export function createEncryptedSecretCodec(
  options: EncryptedSecretCodecOptions,
) {
  function getKey() {
    const rawKey = process.env[options.keyEnvironmentVariable]?.trim();
    if (!rawKey) return null;
    return createHash("sha256").update(rawKey).digest();
  }

  function requireKey() {
    const key = getKey();
    if (!key) {
      throw new HTTPException(500, { message: options.missingKeyMessage });
    }
    return key;
  }

  function isEncrypted(value: string | null | undefined): boolean {
    return typeof value === "string" && value.startsWith(options.prefix);
  }

  function decrypt(
    value: string | null | undefined,
  ): string | null | undefined {
    if (value === undefined || value === null || !isEncrypted(value)) {
      return value;
    }

    const payload = value.slice(options.prefix.length);
    const [iv, authTag, encrypted] = payload.split(".");
    if (!iv || !authTag || !encrypted) {
      throw new HTTPException(500, {
        message: options.invalidPayloadMessage,
      });
    }

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        requireKey(),
        decodePart(iv),
      );
      decipher.setAuthTag(decodePart(authTag));
      return Buffer.concat([
        decipher.update(decodePart(encrypted)),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(500, {
        message: options.decryptionFailedMessage,
      });
    }
  }

  function isValidEncrypted(value: string): boolean {
    try {
      decrypt(value);
      return true;
    } catch {
      return false;
    }
  }

  function encrypt(
    value: string | null | undefined,
  ): string | null | undefined {
    if (value === undefined || value === null) return value;
    if (isEncrypted(value) && isValidEncrypted(value)) return value;

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, requireKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);

    return `${options.prefix}${encodePart(iv)}.${encodePart(
      cipher.getAuthTag(),
    )}.${encodePart(encrypted)}`;
  }

  return { decrypt, encrypt, isEncrypted };
}
