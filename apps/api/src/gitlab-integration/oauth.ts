import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { scmConnectionTable, scmOAuthStateTable } from "../database/schema";
import {
  createGitLabClient,
  gitlabOAuthFetch,
  normalizeGitLabUrl,
  resolveGitLabInternalUrl,
} from "../plugins/gitlab/client";
import {
  decryptScmCredential,
  decryptScmSecret,
  encryptScmCredential,
  encryptScmSecret,
  type ScmCredential,
} from "../scm/secrets";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const OAUTH_REFRESH_BUFFER_MS = 60 * 1_000;
const GITLAB_OAUTH_LOCK_NAMESPACE = 1961;

type GitLabConnectionRow = typeof scmConnectionTable.$inferSelect;
type GitLabCredentialConnection = Pick<
  GitLabConnectionRow,
  "id" | "authType" | "publicUrl" | "internalUrl" | "credentialCiphertext"
>;

type GitLabOAuthTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
};

export type GitLabOAuthConfig = {
  publicUrl: string;
  internalUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  clientOrigin: string;
};

export function getGitLabOAuthConfig(): GitLabOAuthConfig {
  const publicUrlValue = process.env.GITLAB_PUBLIC_URL?.trim();
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITLAB_OAUTH_CLIENT_SECRET?.trim();
  if (!publicUrlValue || !clientId || !clientSecret) {
    throw new Error("GitLab OAuth is not configured on this Kaneo instance");
  }

  const publicUrl = normalizeGitLabUrl(publicUrlValue);
  const apiUrl = (
    process.env.KANEO_API_URL?.trim() || "http://localhost:1337"
  ).replace(/\/+$/, "");
  const clientUrl =
    process.env.KANEO_CLIENT_URL?.trim() || "http://localhost:5173";

  return {
    publicUrl,
    internalUrl: resolveGitLabInternalUrl(publicUrl),
    clientId,
    clientSecret,
    redirectUri: `${apiUrl}/gitlab-integration/oauth/callback`,
    clientOrigin: new URL(clientUrl).origin,
  };
}

export function getGitLabOAuthAvailability() {
  try {
    const config = getGitLabOAuthConfig();
    return { enabled: true as const, publicUrl: config.publicUrl };
  } catch {
    return { enabled: false as const, publicUrl: null };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function createGitLabOAuthPkce() {
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(64).toString("base64url");
  return {
    state,
    stateHash: sha256(state),
    codeVerifier,
    codeChallenge: sha256(codeVerifier),
  };
}

function parseOAuthTokenResponse(value: unknown): GitLabOAuthTokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitLab returned an invalid OAuth token response");
  }
  const response = value as Partial<GitLabOAuthTokenResponse>;
  if (
    typeof response.access_token !== "string" ||
    !response.access_token ||
    typeof response.refresh_token !== "string" ||
    !response.refresh_token ||
    typeof response.expires_in !== "number" ||
    !Number.isFinite(response.expires_in) ||
    response.expires_in <= 0
  ) {
    throw new Error("GitLab returned an invalid OAuth token response");
  }
  return response as GitLabOAuthTokenResponse;
}

function tokenCredential(response: GitLabOAuthTokenResponse): {
  credential: Extract<ScmCredential, { type: "oauth" }>;
  expiresAt: Date;
} {
  const expiresAt = new Date(Date.now() + response.expires_in * 1_000);
  return {
    credential: {
      type: "oauth",
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: expiresAt.toISOString(),
    },
    expiresAt,
  };
}

function oauthForm(config: GitLabOAuthConfig) {
  return new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
}

function requireConfiguredOAuthConnection(
  connection: GitLabCredentialConnection,
) {
  const config = getGitLabOAuthConfig();
  if (
    connection.authType !== "oauth" ||
    normalizeGitLabUrl(connection.publicUrl) !== config.publicUrl ||
    normalizeGitLabUrl(connection.internalUrl) !== config.internalUrl
  ) {
    throw new Error("GitLab OAuth connection configuration is invalid");
  }
  return config;
}

export async function beginGitLabOAuth(input: {
  workspaceId: string;
  userId: string;
  name: string;
  connectionId?: string;
}) {
  const config = getGitLabOAuthConfig();
  let connectionName = input.name.trim();
  if (input.connectionId) {
    const [connection] = await db
      .select()
      .from(scmConnectionTable)
      .where(
        and(
          eq(scmConnectionTable.id, input.connectionId),
          eq(scmConnectionTable.workspaceId, input.workspaceId),
          eq(scmConnectionTable.provider, "gitlab"),
          eq(scmConnectionTable.authType, "oauth"),
        ),
      )
      .limit(1);
    if (!connection) {
      throw new HTTPException(404, {
        message: "GitLab OAuth connection not found",
      });
    }
    requireConfiguredOAuthConnection(connection);
    connectionName = connection.name;
  }

  const { state, stateHash, codeVerifier, codeChallenge } =
    createGitLabOAuthPkce();
  const now = new Date();
  await db
    .delete(scmOAuthStateTable)
    .where(lt(scmOAuthStateTable.expiresAt, now));
  await db.insert(scmOAuthStateTable).values({
    provider: "gitlab",
    stateHash,
    workspaceId: input.workspaceId,
    userId: input.userId,
    connectionId: input.connectionId,
    connectionName,
    codeVerifierCiphertext: encryptScmSecret(codeVerifier),
    expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
  });

  const authorizationUrl = new URL("/oauth/authorize", config.publicUrl);
  authorizationUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    state,
    scope: "api",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return { authorizationUrl: authorizationUrl.toString() };
}

export async function completeGitLabOAuth(input: {
  code: string;
  state: string;
}) {
  const config = getGitLabOAuthConfig();
  const now = new Date();
  const [oauthState] = await db
    .update(scmOAuthStateTable)
    .set({ consumedAt: now })
    .where(
      and(
        eq(scmOAuthStateTable.provider, "gitlab"),
        eq(scmOAuthStateTable.stateHash, sha256(input.state)),
        isNull(scmOAuthStateTable.consumedAt),
        gt(scmOAuthStateTable.expiresAt, now),
      ),
    )
    .returning();
  if (!oauthState) {
    throw new Error("GitLab OAuth state is invalid, expired, or already used");
  }

  const form = oauthForm(config);
  form.set("grant_type", "authorization_code");
  form.set("code", input.code);
  form.set(
    "code_verifier",
    decryptScmSecret(oauthState.codeVerifierCiphertext),
  );
  const response = parseOAuthTokenResponse(
    await gitlabOAuthFetch<unknown>(config, "/oauth/token", form),
  );
  const { credential, expiresAt } = tokenCredential(response);
  const gitlabUser = await createGitLabClient({
    publicUrl: config.publicUrl,
    internalUrl: config.internalUrl,
    auth: { type: "oauth", accessToken: credential.accessToken },
  }).getCurrentUser();

  const values = {
    workspaceId: oauthState.workspaceId,
    provider: "gitlab",
    name: oauthState.connectionName,
    authType: "oauth",
    publicUrl: config.publicUrl,
    internalUrl: config.internalUrl,
    credentialCiphertext: encryptScmCredential(credential),
    ownerUserId: oauthState.userId,
    status: "active",
    statusMessage: null,
    expiresAt,
    metadata: {
      gitlabUserId: gitlabUser.id,
      gitlabUsername: gitlabUser.username,
    },
  };

  try {
    if (oauthState.connectionId) {
      const [updated] = await db
        .update(scmConnectionTable)
        .set(values)
        .where(
          and(
            eq(scmConnectionTable.id, oauthState.connectionId),
            eq(scmConnectionTable.workspaceId, oauthState.workspaceId),
            eq(scmConnectionTable.provider, "gitlab"),
            eq(scmConnectionTable.authType, "oauth"),
          ),
        )
        .returning();
      if (!updated) throw new Error("GitLab OAuth connection no longer exists");
      return updated;
    }

    const [created] = await db
      .insert(scmConnectionTable)
      .values(values)
      .returning();
    if (!created) throw new Error("Failed to create GitLab OAuth connection");
    return created;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new Error("A GitLab connection with this name already exists");
    }
    throw error;
  }
}

function credentialNeedsRefresh(
  credential: Extract<ScmCredential, { type: "oauth" }>,
) {
  const expiresAt = new Date(credential.expiresAt).getTime();
  return (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() + OAUTH_REFRESH_BUFFER_MS
  );
}

/** Return a valid credential, rotating GitLab's single-use refresh token once. */
export async function getValidGitLabCredential(
  connection: GitLabCredentialConnection,
): Promise<ScmCredential> {
  const current = decryptScmCredential(connection.credentialCiphertext);
  if (connection.authType === "token" && current.type === "token") {
    return current;
  }
  if (connection.authType !== "oauth" || current.type !== "oauth") {
    throw new Error("GitLab connection credential type is invalid");
  }
  if (!credentialNeedsRefresh(current)) return current;

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${GITLAB_OAUTH_LOCK_NAMESPACE}, hashtext(${connection.id}))`,
    );
    const [freshConnection] = await tx
      .select()
      .from(scmConnectionTable)
      .where(eq(scmConnectionTable.id, connection.id))
      .limit(1);
    if (!freshConnection) {
      return { error: "GitLab connection no longer exists" } as const;
    }

    const credential = decryptScmCredential(
      freshConnection.credentialCiphertext,
    );
    if (credential.type !== "oauth") return { credential } as const;
    if (!credentialNeedsRefresh(credential)) return { credential } as const;

    try {
      const config = requireConfiguredOAuthConnection(freshConnection);
      const form = oauthForm(config);
      form.set("grant_type", "refresh_token");
      form.set("refresh_token", credential.refreshToken);
      const response = parseOAuthTokenResponse(
        await gitlabOAuthFetch<unknown>(config, "/oauth/token", form),
      );
      const rotated = tokenCredential(response);
      await tx
        .update(scmConnectionTable)
        .set({
          credentialCiphertext: encryptScmCredential(rotated.credential),
          expiresAt: rotated.expiresAt,
          status: "active",
          statusMessage: null,
        })
        .where(eq(scmConnectionTable.id, freshConnection.id));
      return { credential: rotated.credential } as const;
    } catch {
      await tx
        .update(scmConnectionTable)
        .set({
          status: "reauthorization_required",
          statusMessage: "GitLab OAuth authorization must be renewed",
        })
        .where(eq(scmConnectionTable.id, freshConnection.id));
      return {
        error: "GitLab OAuth authorization must be renewed",
      } as const;
    }
  });

  if ("error" in result) throw new Error(result.error);
  return result.credential;
}

export async function revokeGitLabOAuthCredential(
  connection: GitLabConnectionRow,
): Promise<void> {
  if (connection.authType !== "oauth") return;
  const config = requireConfiguredOAuthConnection(connection);
  const credential = await getValidGitLabCredential(connection);
  if (credential.type !== "oauth") return;
  const form = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    token: credential.accessToken,
  });
  await gitlabOAuthFetch(config, "/oauth/revoke", form);
}

export function gitLabOAuthCallbackHtml(status: "success" | "error") {
  const clientOrigin = new URL(
    process.env.KANEO_CLIENT_URL?.trim() || "http://localhost:5173",
  ).origin;
  const payload = JSON.stringify({
    type: "kaneo:gitlab-oauth",
    status,
  }).replace(/</g, "\\u003c");
  const targetOrigin = JSON.stringify(clientOrigin).replace(/</g, "\\u003c");
  const title =
    status === "success" ? "GitLab connected" : "GitLab connection failed";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><p>${title}. You can close this window.</p><script>window.opener?.postMessage(${payload},${targetOrigin});window.close();</script></body></html>`;
}
