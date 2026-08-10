import { describe, expect, it } from "vitest";
import { serializeGitHubRepository } from "../../../apps/api/src/github-integration/repositories";

describe("GitHub repository bindings", () => {
  it("exposes repository identity without leaking provider metadata", () => {
    const repository = serializeGitHubRepository({
      id: "repository-1",
      providerRepositoryId: "42",
      fullPath: "usekaneo/kaneo",
      webUrl: "https://github.com/usekaneo/kaneo",
      defaultBranch: "main",
      isActive: true,
      metadata: {
        installationId: 81,
        private: true,
        legacyConfig: true,
      },
    });

    expect(repository).toEqual({
      id: "repository-1",
      providerRepositoryId: "42",
      fullPath: "usekaneo/kaneo",
      webUrl: "https://github.com/usekaneo/kaneo",
      defaultBranch: "main",
      installationId: 81,
      private: true,
      isActive: true,
    });
    expect(repository).not.toHaveProperty("legacyConfig");
  });
});
