import { describe, expect, it } from "vitest";
import { legacyRepositoryFromIntegration } from "../../../apps/api/src/scm/migrate-legacy-repositories";
import { normalizeScmOrigin } from "../../../apps/api/src/scm/repositories";

const timestamps = {
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-02T00:00:00Z"),
};

describe("SCM repositories", () => {
  it("normalizes origins without weakening URL validation", () => {
    expect(normalizeScmOrigin("https://git.example.com/gitlab/")).toBe(
      "https://git.example.com/gitlab",
    );
    expect(() => normalizeScmOrigin("file:///etc/passwd")).toThrow(
      "must use http or https",
    );
    expect(() => normalizeScmOrigin("https://user:pass@example.com")).toThrow(
      "must not contain credentials",
    );
  });

  it("maps a legacy GitHub integration to its primary repository", () => {
    expect(
      legacyRepositoryFromIntegration({
        id: "integration-1",
        type: "github",
        config: JSON.stringify({
          repositoryOwner: "usekaneo",
          repositoryName: "kaneo",
          installationId: 81,
        }),
        isActive: true,
        ...timestamps,
      }),
    ).toEqual({
      integrationId: "integration-1",
      provider: "github",
      remoteOrigin: "https://github.com",
      providerRepositoryId: "usekaneo/kaneo",
      fullPath: "usekaneo/kaneo",
      webUrl: "https://github.com/usekaneo/kaneo",
      metadata: { legacyConfig: true, installationId: 81 },
      isActive: true,
      ...timestamps,
    });
  });

  it("preserves a self-managed Gitea subpath and provider repository ID", () => {
    expect(
      legacyRepositoryFromIntegration({
        id: "integration-2",
        type: "gitea",
        config: JSON.stringify({
          baseUrl: "https://git.example.com/gitea/",
          repositoryId: "42",
          repositoryOwner: "atelier",
          repositoryName: "kaneo",
        }),
        isActive: null,
        ...timestamps,
      }),
    ).toMatchObject({
      provider: "gitea",
      remoteOrigin: "https://git.example.com/gitea",
      providerRepositoryId: "42",
      fullPath: "atelier/kaneo",
      webUrl: "https://git.example.com/gitea/atelier/kaneo",
      isActive: true,
    });
  });

  it("ignores providers and configs that cannot identify a repository", () => {
    expect(
      legacyRepositoryFromIntegration({
        id: "integration-3",
        type: "slack",
        config: "{}",
        isActive: true,
        ...timestamps,
      }),
    ).toBeUndefined();

    expect(
      legacyRepositoryFromIntegration({
        id: "integration-4",
        type: "gitea",
        config: JSON.stringify({ repositoryOwner: "atelier" }),
        isActive: true,
        ...timestamps,
      }),
    ).toBeUndefined();
  });
});
