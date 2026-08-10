import { and, asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  integrationRepositoryTable,
  scmConnectionTable,
} from "../database/schema";
import {
  createGitLabClient,
  GitLabApiError,
  normalizeGitLabUrl,
  resolveGitLabInternalUrl,
} from "../plugins/gitlab/client";
import { encryptScmCredential, maskScmToken } from "../scm/secrets";
import { getValidGitLabCredential, revokeGitLabOAuthCredential } from "./oauth";

type GitLabConnectionRow = typeof scmConnectionTable.$inferSelect;

type GitLabConnectionMetadata = {
  tokenHint?: string;
  gitlabUserId?: number;
  gitlabUsername?: string;
};

export type PublicGitLabConnection = {
  id: string;
  workspaceId: string;
  name: string;
  authType: string;
  publicUrl: string;
  status: string;
  statusMessage: string | null;
  credentialHint: string | null;
  gitlabUsername: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  attachedRepositoryCount: number;
};

function readMetadata(value: unknown): GitLabConnectionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  return {
    tokenHint:
      typeof metadata.tokenHint === "string" ? metadata.tokenHint : undefined,
    gitlabUserId:
      typeof metadata.gitlabUserId === "number"
        ? metadata.gitlabUserId
        : undefined,
    gitlabUsername:
      typeof metadata.gitlabUsername === "string"
        ? metadata.gitlabUsername
        : undefined,
  };
}

export function toPublicGitLabConnection(
  connection: GitLabConnectionRow,
  attachedRepositoryCount = 0,
): PublicGitLabConnection {
  const metadata = readMetadata(connection.metadata);
  return {
    id: connection.id,
    workspaceId: connection.workspaceId,
    name: connection.name,
    authType: connection.authType,
    publicUrl: connection.publicUrl,
    status: connection.status,
    statusMessage: connection.statusMessage,
    credentialHint: metadata.tokenHint ?? null,
    gitlabUsername: metadata.gitlabUsername ?? null,
    expiresAt: connection.expiresAt?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
    attachedRepositoryCount,
  };
}

function throwConnectionError(error: unknown): never {
  if (error instanceof HTTPException) throw error;
  if (error instanceof GitLabApiError) {
    const message =
      error.status === 401 || error.status === 403
        ? "GitLab rejected the token or it lacks the required access"
        : `Unable to verify the GitLab connection (${error.status})`;
    throw new HTTPException(400, { message });
  }
  if (error instanceof Error) {
    throw new HTTPException(400, { message: error.message });
  }
  throw new HTTPException(400, { message: "Unable to verify GitLab access" });
}

export async function getGitLabClientForConnection(
  connection: GitLabConnectionRow,
) {
  const credential = await getValidGitLabCredential(connection);
  return createGitLabClient({
    publicUrl: connection.publicUrl,
    internalUrl: connection.internalUrl,
    auth: { type: credential.type, accessToken: credential.accessToken },
  });
}

export async function requireGitLabConnection(
  workspaceId: string,
  connectionId: string,
): Promise<GitLabConnectionRow> {
  const [connection] = await db
    .select()
    .from(scmConnectionTable)
    .where(
      and(
        eq(scmConnectionTable.id, connectionId),
        eq(scmConnectionTable.workspaceId, workspaceId),
        eq(scmConnectionTable.provider, "gitlab"),
      ),
    )
    .limit(1);

  if (!connection) {
    throw new HTTPException(404, { message: "GitLab connection not found" });
  }
  return connection;
}

export async function listGitLabConnections(workspaceId: string) {
  const rows = await db
    .select({
      connection: scmConnectionTable,
      attachedRepositoryCount: sql<number>`count(${integrationRepositoryTable.id})::int`,
    })
    .from(scmConnectionTable)
    .leftJoin(
      integrationRepositoryTable,
      eq(integrationRepositoryTable.connectionId, scmConnectionTable.id),
    )
    .where(
      and(
        eq(scmConnectionTable.workspaceId, workspaceId),
        eq(scmConnectionTable.provider, "gitlab"),
      ),
    )
    .groupBy(scmConnectionTable.id)
    .orderBy(asc(scmConnectionTable.name));

  return rows.map(({ connection, attachedRepositoryCount }) =>
    toPublicGitLabConnection(connection, attachedRepositoryCount),
  );
}

export async function createTokenConnection(input: {
  workspaceId: string;
  ownerUserId: string;
  name: string;
  publicUrl: string;
  accessToken: string;
}) {
  let publicUrl: string;
  let internalUrl: string;
  let gitlabUser: { id: number; username: string; name: string };
  try {
    publicUrl = normalizeGitLabUrl(input.publicUrl);
    internalUrl = resolveGitLabInternalUrl(publicUrl);
    gitlabUser = await createGitLabClient({
      publicUrl,
      internalUrl,
      auth: { type: "token", accessToken: input.accessToken },
    }).getCurrentUser();
  } catch (error) {
    throwConnectionError(error);
  }

  try {
    const [connection] = await db
      .insert(scmConnectionTable)
      .values({
        workspaceId: input.workspaceId,
        provider: "gitlab",
        name: input.name.trim(),
        authType: "token",
        publicUrl,
        internalUrl,
        credentialCiphertext: encryptScmCredential({
          type: "token",
          accessToken: input.accessToken,
        }),
        ownerUserId: input.ownerUserId,
        status: "active",
        statusMessage: null,
        metadata: {
          tokenHint: maskScmToken(input.accessToken),
          gitlabUserId: gitlabUser.id,
          gitlabUsername: gitlabUser.username,
        },
      })
      .returning();

    if (!connection) {
      throw new HTTPException(500, {
        message: "Failed to create GitLab connection",
      });
    }
    return toPublicGitLabConnection(connection);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new HTTPException(409, {
        message: "A GitLab connection with this name already exists",
      });
    }
    throw error;
  }
}

export async function rotateTokenConnection(input: {
  workspaceId: string;
  connectionId: string;
  accessToken: string;
}) {
  const connection = await requireGitLabConnection(
    input.workspaceId,
    input.connectionId,
  );
  if (connection.authType !== "token") {
    throw new HTTPException(400, {
      message: "OAuth connections must be reauthorized instead of rotated",
    });
  }

  let gitlabUser: { id: number; username: string; name: string };
  try {
    gitlabUser = await createGitLabClient({
      publicUrl: connection.publicUrl,
      internalUrl: connection.internalUrl,
      auth: { type: "token", accessToken: input.accessToken },
    }).getCurrentUser();
  } catch (error) {
    throwConnectionError(error);
  }

  const [updated] = await db
    .update(scmConnectionTable)
    .set({
      credentialCiphertext: encryptScmCredential({
        type: "token",
        accessToken: input.accessToken,
      }),
      status: "active",
      statusMessage: null,
      metadata: {
        ...readMetadata(connection.metadata),
        tokenHint: maskScmToken(input.accessToken),
        gitlabUserId: gitlabUser.id,
        gitlabUsername: gitlabUser.username,
      },
    })
    .where(eq(scmConnectionTable.id, connection.id))
    .returning();

  if (!updated) {
    throw new HTTPException(500, {
      message: "Failed to rotate GitLab connection token",
    });
  }
  return toPublicGitLabConnection(updated);
}

export async function listConnectionProjects(
  workspaceId: string,
  connectionId: string,
) {
  const connection = await requireGitLabConnection(workspaceId, connectionId);
  try {
    const projects = await (
      await getGitLabClientForConnection(connection)
    ).listMaintainedProjects();
    if (connection.status !== "active" || connection.statusMessage) {
      await db
        .update(scmConnectionTable)
        .set({ status: "active", statusMessage: null })
        .where(eq(scmConnectionTable.id, connection.id));
    }
    return projects;
  } catch (error) {
    const statusMessage =
      error instanceof GitLabApiError
        ? `GitLab API request failed (${error.status})`
        : "GitLab connection check failed";
    await db
      .update(scmConnectionTable)
      .set({ status: "error", statusMessage })
      .where(eq(scmConnectionTable.id, connection.id));
    throwConnectionError(error);
  }
}

export async function deleteGitLabConnection(
  workspaceId: string,
  connectionId: string,
) {
  const connection = await requireGitLabConnection(workspaceId, connectionId);
  const [repositoryCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(integrationRepositoryTable)
    .where(eq(integrationRepositoryTable.connectionId, connection.id));
  if ((repositoryCount?.count ?? 0) > 0) {
    throw new HTTPException(409, {
      message: "Detach all repositories before deleting this connection",
    });
  }
  if (connection.authType === "oauth") {
    try {
      await revokeGitLabOAuthCredential(connection);
    } catch {
      // Local deletion must remain possible after remote revocation or expiry.
    }
  }
  await db
    .delete(scmConnectionTable)
    .where(eq(scmConnectionTable.id, connection.id));
}
