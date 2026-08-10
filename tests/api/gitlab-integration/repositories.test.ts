import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  generateGitLabSigningToken,
  toPublicGitLabRepository,
} from "../../../apps/api/src/gitlab-integration/repositories";

describe("GitLab repository bindings", () => {
  it("generates a Standard Webhooks signing token with 32 bytes of key data", () => {
    const token = generateGitLabSigningToken();
    expect(token).toMatch(/^whsec_/);
    expect(Buffer.from(token.slice("whsec_".length), "base64")).toHaveLength(
      32,
    );
  });

  it("does not expose the signing token or remote hook ID", () => {
    const repository: Parameters<typeof toPublicGitLabRepository>[0] = {
      id: "repository-1",
      integrationId: "integration-1",
      connectionId: "connection-1",
      provider: "gitlab",
      remoteOrigin: "https://git.atelier.house",
      providerRepositoryId: "42",
      fullPath: "atelier/kaneo",
      webUrl: "https://git.atelier.house/atelier/kaneo",
      defaultBranch: "main",
      webhookId: "81",
      webhookSecretCiphertext: "scm-secret:v1:ciphertext",
      metadata: null,
      isActive: true,
      createdAt: new Date("2026-08-09T12:00:00.000Z"),
      updatedAt: new Date("2026-08-09T12:30:00.000Z"),
    };

    const result = toPublicGitLabRepository(repository);
    expect(result.webhookConfigured).toBe(true);
    expect(result).not.toHaveProperty("webhookId");
    expect(result).not.toHaveProperty("webhookSecretCiphertext");
    expect(result).not.toHaveProperty("remoteOrigin");
  });
});
