import { afterEach, describe, expect, it } from "vitest";
import {
  sanitizeGiteaConfig,
  serializeGiteaRepository,
} from "../../../apps/api/src/gitea-integration/repositories";
import { encryptScmSecret } from "../../../apps/api/src/scm/secrets";

const originalKey = process.env.SCM_SECRET_ENCRYPTION_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.SCM_SECRET_ENCRYPTION_KEY;
  else process.env.SCM_SECRET_ENCRYPTION_KEY = originalKey;
});

describe("Gitea repository bindings", () => {
  it("removes legacy plaintext credentials from integration config", () => {
    expect(
      sanitizeGiteaConfig({
        baseUrl: "https://git.example.com",
        accessToken: "plaintext-token",
        webhookSecret: "plaintext-secret",
        branchPattern: "{slug}-{number}",
      }),
    ).toEqual({
      baseUrl: "https://git.example.com",
      branchPattern: "{slug}-{number}",
    });
  });

  it("returns a repository-specific webhook and reveals its secret only on request", () => {
    process.env.SCM_SECRET_ENCRYPTION_KEY = "test-key-with-high-entropy";
    const row = {
      id: "repository-1",
      providerRepositoryId: "42",
      fullPath: "atelier/kaneo",
      webUrl: "https://git.example.com/atelier/kaneo",
      defaultBranch: "main",
      webhookSecretCiphertext: encryptScmSecret("signed-secret"),
      isActive: true,
    };

    const masked = serializeGiteaRepository(
      row,
      "https://kaneo.example.com/api",
    );
    expect(masked.webhookUrl).toBe(
      "https://kaneo.example.com/api/gitea-integration/webhook/repository-1",
    );
    expect(masked.webhookSecret).toBe("");

    const revealed = serializeGiteaRepository(
      row,
      "https://kaneo.example.com/api",
      true,
    );
    expect(revealed.webhookSecret).toBe("signed-secret");
    expect(JSON.stringify(revealed)).not.toContain("scm-secret:v1:");
  });
});
