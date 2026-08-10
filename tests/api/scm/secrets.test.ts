import { afterEach, describe, expect, it } from "vitest";
import {
  decryptScmCredential,
  decryptScmSecret,
  encryptScmCredential,
  encryptScmSecret,
  maskScmToken,
} from "../../../apps/api/src/scm/secrets";

const originalKey = process.env.SCM_SECRET_ENCRYPTION_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.SCM_SECRET_ENCRYPTION_KEY;
  else process.env.SCM_SECRET_ENCRYPTION_KEY = originalKey;
});

describe("SCM credential encryption", () => {
  it("round-trips token credentials without exposing plaintext", () => {
    process.env.SCM_SECRET_ENCRYPTION_KEY = "test-key-with-high-entropy";
    const encrypted = encryptScmCredential({
      type: "token",
      accessToken: "glpat-secret-value",
    });

    expect(encrypted).toMatch(/^scm:v1:/);
    expect(encrypted).not.toContain("glpat-secret-value");
    expect(decryptScmCredential(encrypted)).toEqual({
      type: "token",
      accessToken: "glpat-secret-value",
    });
  });

  it("fails closed when the encryption key is absent", () => {
    delete process.env.SCM_SECRET_ENCRYPTION_KEY;
    expect(() =>
      encryptScmCredential({ type: "token", accessToken: "secret" }),
    ).toThrow(/SCM_SECRET_ENCRYPTION_KEY/);
  });

  it("rejects plaintext and ciphertext encrypted under another key", () => {
    process.env.SCM_SECRET_ENCRYPTION_KEY = "first-key";
    const encrypted = encryptScmCredential({
      type: "token",
      accessToken: "secret",
    });

    expect(() => decryptScmCredential("secret")).toThrow(/not encrypted/);
    process.env.SCM_SECRET_ENCRYPTION_KEY = "second-key";
    expect(() => decryptScmCredential(encrypted)).toThrow(/decrypt/);
  });

  it("masks tokens while retaining a rotation hint", () => {
    expect(maskScmToken("glpat-1234567890")).toBe("glpa…7890");
    expect(maskScmToken("short")).toBe("••••••••");
  });

  it("encrypts provider signing secrets independently from credentials", () => {
    process.env.SCM_SECRET_ENCRYPTION_KEY = "test-key-with-high-entropy";
    const ciphertext = encryptScmSecret("whsec_signing-secret");
    expect(ciphertext).toMatch(/^scm-secret:v1:/);
    expect(ciphertext).not.toContain("signing-secret");
    expect(decryptScmSecret(ciphertext)).toBe("whsec_signing-secret");
  });
});
