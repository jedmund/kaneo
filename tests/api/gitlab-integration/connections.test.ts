import { describe, expect, it } from "vitest";
import { toPublicGitLabConnection } from "../../../apps/api/src/gitlab-integration/connections";

describe("GitLab connection responses", () => {
  it("exposes health and a masked hint without network routes or credentials", () => {
    const connection: Parameters<typeof toPublicGitLabConnection>[0] = {
      id: "connection-1",
      workspaceId: "workspace-1",
      provider: "gitlab",
      name: "Atelier GitLab",
      authType: "token",
      publicUrl: "https://git.atelier.house",
      internalUrl: "http://gitlab",
      credentialCiphertext: "scm:v1:ciphertext",
      ownerUserId: "user-1",
      status: "active",
      statusMessage: null,
      expiresAt: null,
      metadata: {
        tokenHint: "glpa…1234",
        gitlabUserId: 42,
        gitlabUsername: "kaneo-bot",
      },
      createdAt: new Date("2026-08-09T12:00:00.000Z"),
      updatedAt: new Date("2026-08-09T12:30:00.000Z"),
    };

    const result = toPublicGitLabConnection(connection, 3);

    expect(result).toEqual({
      id: "connection-1",
      workspaceId: "workspace-1",
      name: "Atelier GitLab",
      authType: "token",
      publicUrl: "https://git.atelier.house",
      status: "active",
      statusMessage: null,
      credentialHint: "glpa…1234",
      gitlabUsername: "kaneo-bot",
      expiresAt: null,
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:30:00.000Z",
      attachedRepositoryCount: 3,
    });
    expect(result).not.toHaveProperty("internalUrl");
    expect(result).not.toHaveProperty("credentialCiphertext");
  });
});
