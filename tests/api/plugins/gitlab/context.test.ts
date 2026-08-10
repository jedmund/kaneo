import { describe, expect, it } from "vitest";
import { requireGitLabContext } from "../../../../apps/api/src/plugins/gitlab/context";
import {
  parseGitLabIssueIid,
  parseGitLabLinkMetadata,
} from "../../../../apps/api/src/plugins/gitlab/link";
import type { PluginContext } from "../../../../apps/api/src/plugins/types";

const context: PluginContext = {
  integrationId: "integration-1",
  integrationRepositoryId: "repository-1",
  projectId: "kaneo-project-1",
  config: {},
  repository: {
    id: "repository-1",
    connectionId: "connection-1",
    provider: "gitlab",
    providerRepositoryId: "42",
    fullPath: "atelier/kaneo",
    remoteOrigin: "https://git.atelier.house",
    webUrl: "https://git.atelier.house/atelier/kaneo",
    defaultBranch: "main",
    metadata: null,
  },
  connection: {
    id: "connection-1",
    authType: "token",
    publicUrl: "https://git.atelier.house",
    internalUrl: "http://gitlab",
    credential: { type: "token", accessToken: "secret" },
  },
};

describe("GitLab plugin context", () => {
  it("keeps the numeric project ID separate from its nested display path", () => {
    const resolved = requireGitLabContext(context);
    expect(resolved.projectId).toBe(42);
    expect(resolved.repository.fullPath).toBe("atelier/kaneo");
  });

  it("rejects missing bindings and malformed project IDs", () => {
    expect(() =>
      requireGitLabContext({ ...context, connection: undefined }),
    ).toThrow(/not configured/);
    expect(() =>
      requireGitLabContext({
        ...context,
        repository: context.repository
          ? { ...context.repository, providerRepositoryId: "atelier/kaneo" }
          : undefined,
      }),
    ).toThrow(/invalid project ID/);
  });

  it("strictly parses project-scoped issue IIDs and tolerates old metadata", () => {
    expect(parseGitLabIssueIid("17")).toBe(17);
    expect(() => parseGitLabIssueIid("17abc")).toThrow(/invalid IID/);
    expect(parseGitLabLinkMetadata("not-json")).toEqual({});
    expect(parseGitLabLinkMetadata('{"globalId":99}')).toEqual({
      globalId: 99,
    });
  });
});
