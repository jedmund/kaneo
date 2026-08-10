import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { getValidGitLabCredential } from "../../apps/api/src/gitlab-integration/oauth";
import {
  decryptScmCredential,
  encryptScmCredential,
} from "../../apps/api/src/scm/secrets";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

const expiredCredential = {
  type: "oauth" as const,
  accessToken: "expired-access-token",
  refreshToken: "single-use-refresh-token",
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
};

async function createExpiredOAuthConnection() {
  const member = await createWorkspaceMember({ role: "owner" });
  const [connection] = await db
    .insert(schema.scmConnectionTable)
    .values({
      workspaceId: member.workspace.id,
      provider: "gitlab",
      name: "OAuth Integration GitLab",
      authType: "oauth",
      publicUrl: "https://gitlab.example.test",
      internalUrl: "http://gitlab",
      credentialCiphertext: encryptScmCredential(expiredCredential),
      ownerUserId: member.user.id,
      expiresAt: new Date(expiredCredential.expiresAt),
    })
    .returning();

  return connection;
}

describe("API integration: GitLab OAuth refresh", () => {
  beforeEach(async () => {
    vi.stubEnv(
      "SCM_SECRET_ENCRYPTION_KEY",
      "integration-test-scm-key-with-at-least-32-characters",
    );
    vi.stubEnv("GITLAB_PUBLIC_URL", "https://gitlab.example.test");
    vi.stubEnv("GITLAB_INTERNAL_URL", "http://gitlab");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "integration-client-id");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "integration-client-secret");
    await resetTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("serializes concurrent refreshes and persists only the rotated token", async () => {
    const connection = await createExpiredOAuthConnection();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 7_200,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      getValidGitLabCredential(connection),
      getValidGitLabCredential(connection),
    ]);

    expect(first).toEqual(second);
    expect(first).toEqual(
      expect.objectContaining({
        type: "oauth",
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gitlab/oauth/token",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.body?.toString()).toContain(
      "refresh_token=single-use-refresh-token",
    );

    const [persisted] = await db
      .select()
      .from(schema.scmConnectionTable)
      .where(eq(schema.scmConnectionTable.id, connection.id));
    expect(persisted.status).toBe("active");
    expect(persisted.statusMessage).toBeNull();
    expect(persisted.credentialCiphertext).not.toContain(
      "rotated-access-token",
    );
    expect(persisted.credentialCiphertext).not.toContain(
      "rotated-refresh-token",
    );
    expect(decryptScmCredential(persisted.credentialCiphertext)).toEqual(first);
  });

  it("marks a rejected refresh as requiring reauthorization", async () => {
    const connection = await createExpiredOAuthConnection();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(getValidGitLabCredential(connection)).rejects.toThrow(
      "GitLab OAuth authorization must be renewed",
    );

    const [persisted] = await db
      .select()
      .from(schema.scmConnectionTable)
      .where(eq(schema.scmConnectionTable.id, connection.id));
    expect(persisted).toEqual(
      expect.objectContaining({
        status: "reauthorization_required",
        statusMessage: "GitLab OAuth authorization must be renewed",
      }),
    );
    expect(decryptScmCredential(persisted.credentialCiphertext)).toEqual(
      expiredCredential,
    );
  });
});
