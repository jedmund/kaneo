import { randomBytes } from "node:crypto";
import { and, asc, eq, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import db from "../database";
import {
  integrationRepositoryTable,
  integrationTable,
  projectTable,
  scmConnectionTable,
} from "../database/schema";
import {
  defaultGiteaConfig,
  type GiteaConfig,
  normalizeGiteaBaseUrl,
} from "../plugins/gitea/config";
import {
  createGiteaClient,
  GiteaApiError,
  verifyGiteaToken,
} from "../plugins/gitea/utils/gitea-api";
import {
  decryptScmCredential,
  decryptScmSecret,
  encryptScmCredential,
  encryptScmSecret,
  maskScmToken,
} from "../scm/secrets";

function connectionName(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return `Gitea ${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
}

function repositoryPath(fullPath: string) {
  const parts = fullPath.split("/");
  const repositoryName = parts.pop();
  const repositoryOwner = parts.join("/");
  if (!repositoryOwner || !repositoryName) {
    throw new HTTPException(500, { message: "Invalid Gitea repository path" });
  }
  return { repositoryOwner, repositoryName };
}

export function sanitizeGiteaConfig(config: Record<string, unknown>) {
  const {
    accessToken: _accessToken,
    webhookSecret: _webhookSecret,
    ...safeConfig
  } = config;
  return safeConfig;
}

export function serializeGiteaRepository(
  row: {
    id: string;
    providerRepositoryId: string;
    fullPath: string;
    webUrl: string;
    defaultBranch: string | null;
    webhookSecretCiphertext: string | null;
    isActive: boolean;
  },
  apiBase: string,
  includeWebhookSecret = false,
) {
  return {
    id: row.id,
    providerRepositoryId: row.providerRepositoryId,
    fullPath: row.fullPath,
    webUrl: row.webUrl,
    defaultBranch: row.defaultBranch,
    webhookUrl: `${apiBase.replace(/\/$/, "")}/gitea-integration/webhook/${row.id}`,
    webhookSecret:
      includeWebhookSecret && row.webhookSecretCiphertext
        ? decryptScmSecret(row.webhookSecretCiphertext)
        : "",
    isActive: row.isActive,
  };
}

export async function listAttachedGiteaRepositories(
  integrationId: string,
  apiBase: string,
  includeWebhookSecret = false,
) {
  const rows = await db.query.integrationRepositoryTable.findMany({
    where: and(
      eq(integrationRepositoryTable.integrationId, integrationId),
      eq(integrationRepositoryTable.provider, "gitea"),
    ),
    orderBy: asc(integrationRepositoryTable.fullPath),
  });

  return rows.map((row) =>
    serializeGiteaRepository(row, apiBase, includeWebhookSecret),
  );
}

async function resolveGiteaConnection(input: {
  workspaceId: string;
  baseUrl: string;
  accessToken?: string;
  ownerUserId?: string;
}) {
  const existing = await db.query.scmConnectionTable.findFirst({
    where: and(
      eq(scmConnectionTable.workspaceId, input.workspaceId),
      eq(scmConnectionTable.provider, "gitea"),
      eq(scmConnectionTable.publicUrl, input.baseUrl),
    ),
  });

  const suppliedToken = input.accessToken?.trim();
  const accessToken = suppliedToken
    ? suppliedToken
    : existing
      ? decryptScmCredential(existing.credentialCiphertext).accessToken
      : "";

  if (!accessToken) {
    throw new HTTPException(400, {
      message: "Personal access token is required",
    });
  }

  await verifyGiteaToken(input.baseUrl, accessToken);

  if (existing) {
    if (suppliedToken || existing.status !== "active") {
      const [updated] = await db
        .update(scmConnectionTable)
        .set({
          credentialCiphertext: encryptScmCredential({
            type: "token",
            accessToken,
          }),
          status: "active",
          statusMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(scmConnectionTable.id, existing.id))
        .returning();
      return { connection: updated ?? existing, accessToken };
    }
    return { connection: existing, accessToken };
  }

  const [created] = await db
    .insert(scmConnectionTable)
    .values({
      workspaceId: input.workspaceId,
      provider: "gitea",
      name: connectionName(input.baseUrl),
      authType: "token",
      publicUrl: input.baseUrl,
      internalUrl: input.baseUrl,
      credentialCiphertext: encryptScmCredential({
        type: "token",
        accessToken,
      }),
      ownerUserId: input.ownerUserId,
      status: "active",
    })
    .returning();

  if (!created) {
    throw new HTTPException(500, {
      message: "Failed to create Gitea connection",
    });
  }
  return { connection: created, accessToken };
}

export async function attachGiteaRepository(input: {
  projectId: string;
  baseUrl: string;
  accessToken?: string;
  repositoryOwner: string;
  repositoryName: string;
  ownerUserId?: string;
}) {
  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, input.projectId),
  });
  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const baseUrl = normalizeGiteaBaseUrl(input.baseUrl);
  let connection: Awaited<ReturnType<typeof resolveGiteaConnection>>;
  try {
    connection = await resolveGiteaConnection({
      workspaceId: project.workspaceId,
      baseUrl,
      accessToken: input.accessToken,
      ownerUserId: input.ownerUserId,
    });
  } catch (error) {
    if (error instanceof GiteaApiError) {
      throw new HTTPException((error.status || 400) as ContentfulStatusCode, {
        message: error.message,
      });
    }
    throw error;
  }

  const client = createGiteaClient({
    baseUrl,
    accessToken: connection.accessToken,
  });
  const remoteRepository = await client.getRepo(
    input.repositoryOwner,
    input.repositoryName,
  );
  const fullPath =
    remoteRepository.full_name ??
    `${remoteRepository.owner.login ?? remoteRepository.owner.username}/${remoteRepository.name}`;
  const providerRepositoryId =
    remoteRepository.id?.toString() ?? fullPath.toLowerCase();

  const existingBinding = await db.query.integrationRepositoryTable.findFirst({
    where: and(
      eq(integrationRepositoryTable.provider, "gitea"),
      eq(integrationRepositoryTable.remoteOrigin, baseUrl),
      or(
        eq(
          integrationRepositoryTable.providerRepositoryId,
          providerRepositoryId,
        ),
        eq(integrationRepositoryTable.fullPath, fullPath),
      ),
    ),
    with: { integration: true },
  });

  if (
    existingBinding &&
    existingBinding.integration.projectId !== input.projectId
  ) {
    throw new HTTPException(409, {
      message: `Repository ${fullPath} on this Gitea instance is already linked to another project`,
    });
  }

  let integration = await db.query.integrationTable.findFirst({
    where: and(
      eq(integrationTable.projectId, input.projectId),
      eq(integrationTable.type, "gitea"),
    ),
  });

  if (!integration) {
    const [created] = await db
      .insert(integrationTable)
      .values({
        projectId: input.projectId,
        type: "gitea",
        config: JSON.stringify({
          baseUrl,
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          ...defaultGiteaConfig,
        } satisfies GiteaConfig),
        isActive: true,
      })
      .returning();
    integration = created;
  } else {
    const parsed = JSON.parse(integration.config) as GiteaConfig;
    const safe = sanitizeGiteaConfig(parsed);
    const [updated] = await db
      .update(integrationTable)
      .set({
        config: JSON.stringify(safe),
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(integrationTable.id, integration.id))
      .returning();
    integration = updated;
  }

  if (!integration) {
    throw new HTTPException(500, {
      message: "Failed to create Gitea integration",
    });
  }

  const webhookSecret = randomBytes(32).toString("hex");
  const values = {
    integrationId: integration.id,
    connectionId: connection.connection.id,
    provider: "gitea",
    remoteOrigin: baseUrl,
    providerRepositoryId,
    fullPath,
    webUrl: remoteRepository.html_url,
    defaultBranch: remoteRepository.default_branch ?? null,
    webhookSecretCiphertext:
      existingBinding?.webhookSecretCiphertext ??
      encryptScmSecret(webhookSecret),
    metadata: { private: remoteRepository.private },
    isActive: true,
  } as const;

  if (existingBinding) {
    await db
      .update(integrationRepositoryTable)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(integrationRepositoryTable.id, existingBinding.id));
  } else {
    await db.insert(integrationRepositoryTable).values(values);
  }

  return integration.id;
}

export async function requireAttachedGiteaRepository(input: {
  projectId: string;
  repositoryId: string;
}) {
  const binding = await db.query.integrationRepositoryTable.findFirst({
    where: and(
      eq(integrationRepositoryTable.id, input.repositoryId),
      eq(integrationRepositoryTable.provider, "gitea"),
      eq(integrationRepositoryTable.isActive, true),
    ),
    with: { integration: true, connection: true },
  });

  if (
    !binding?.integration.isActive ||
    binding.integration.projectId !== input.projectId ||
    !binding.connection
  ) {
    throw new HTTPException(400, {
      message:
        "Gitea repository is inactive or does not belong to this project",
    });
  }

  const credential = decryptScmCredential(
    binding.connection.credentialCiphertext,
  );
  return {
    binding,
    integration: binding.integration,
    config: {
      ...(JSON.parse(binding.integration.config) as GiteaConfig),
      ...repositoryPath(binding.fullPath),
      baseUrl: binding.connection.internalUrl,
      accessToken: credential.accessToken,
    } satisfies GiteaConfig,
  };
}

export async function detachGiteaRepository(input: {
  projectId: string;
  repositoryId: string;
}) {
  const repository = await requireAttachedGiteaRepository(input);
  await db
    .delete(integrationRepositoryTable)
    .where(eq(integrationRepositoryTable.id, repository.binding.id));

  const remaining = await db.query.integrationRepositoryTable.findFirst({
    where: and(
      eq(integrationRepositoryTable.integrationId, repository.integration.id),
      eq(integrationRepositoryTable.provider, "gitea"),
    ),
    columns: { id: true },
  });
  if (!remaining) {
    await db
      .delete(integrationTable)
      .where(eq(integrationTable.id, repository.integration.id));
  }
  return { success: true };
}

export async function getMaskedGiteaConnectionToken(connectionId: string) {
  const connection = await db.query.scmConnectionTable.findFirst({
    where: eq(scmConnectionTable.id, connectionId),
  });
  if (!connection) return "";
  return maskScmToken(
    decryptScmCredential(connection.credentialCiphertext).accessToken,
  );
}

export async function getGiteaAccessTokenForProject(
  projectId: string,
  baseUrl: string,
) {
  const normalized = normalizeGiteaBaseUrl(baseUrl);
  const connection = await db
    .select({ credentialCiphertext: scmConnectionTable.credentialCiphertext })
    .from(integrationRepositoryTable)
    .innerJoin(
      integrationTable,
      eq(integrationRepositoryTable.integrationId, integrationTable.id),
    )
    .innerJoin(
      scmConnectionTable,
      eq(integrationRepositoryTable.connectionId, scmConnectionTable.id),
    )
    .where(
      and(
        eq(integrationTable.projectId, projectId),
        eq(integrationRepositoryTable.provider, "gitea"),
        eq(scmConnectionTable.publicUrl, normalized),
      ),
    )
    .limit(1);

  const row = connection[0];
  if (!row) {
    throw new HTTPException(400, {
      message: "Personal access token is required",
    });
  }
  return decryptScmCredential(row.credentialCiphertext).accessToken;
}

/** Moves legacy plaintext Gitea credentials into the shared encrypted model. */
export async function migrateLegacyGiteaRepository(input: {
  integrationId: string;
  repositoryId: string;
  workspaceId: string;
  config: Record<string, unknown>;
}) {
  const accessToken =
    typeof input.config.accessToken === "string"
      ? input.config.accessToken.trim()
      : "";
  if (!accessToken) return;

  const baseUrl = normalizeGiteaBaseUrl(String(input.config.baseUrl ?? ""));
  let connection = await db.query.scmConnectionTable.findFirst({
    where: and(
      eq(scmConnectionTable.workspaceId, input.workspaceId),
      eq(scmConnectionTable.provider, "gitea"),
      eq(scmConnectionTable.publicUrl, baseUrl),
    ),
  });

  if (!connection) {
    [connection] = await db
      .insert(scmConnectionTable)
      .values({
        workspaceId: input.workspaceId,
        provider: "gitea",
        name: connectionName(baseUrl),
        authType: "token",
        publicUrl: baseUrl,
        internalUrl: baseUrl,
        credentialCiphertext: encryptScmCredential({
          type: "token",
          accessToken,
        }),
        status: "active",
        metadata: { migratedFromLegacyConfig: true },
      })
      .returning();
  }

  if (!connection) {
    throw new Error("Failed to migrate legacy Gitea connection");
  }

  const webhookSecret =
    typeof input.config.webhookSecret === "string"
      ? input.config.webhookSecret
      : randomBytes(32).toString("hex");

  await db
    .update(integrationRepositoryTable)
    .set({
      connectionId: connection.id,
      webhookSecretCiphertext: encryptScmSecret(webhookSecret),
      updatedAt: new Date(),
    })
    .where(eq(integrationRepositoryTable.id, input.repositoryId));

  const safeConfig = sanitizeGiteaConfig(input.config);
  await db
    .update(integrationTable)
    .set({ config: JSON.stringify(safeConfig), updatedAt: new Date() })
    .where(eq(integrationTable.id, input.integrationId));
}
