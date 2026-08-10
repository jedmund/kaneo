import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  integrationRepositoryTable,
  integrationTable,
  projectTable,
  scmConnectionTable,
} from "../database/schema";
import { GitLabApiError, type GitLabProject } from "../plugins/gitlab/client";
import { encryptScmSecret } from "../scm/secrets";
import { normalizeApiServerUrl } from "../utils/openapi-spec";
import {
  getGitLabClientForConnection,
  requireGitLabConnection,
} from "./connections";

type GitLabRepositoryRow = typeof integrationRepositoryTable.$inferSelect;

export type PublicGitLabRepository = {
  id: string;
  integrationId: string;
  connectionId: string;
  providerRepositoryId: string;
  fullPath: string;
  webUrl: string;
  defaultBranch: string | null;
  webhookConfigured: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export function toPublicGitLabRepository(
  repository: GitLabRepositoryRow,
): PublicGitLabRepository {
  if (!repository.connectionId) {
    throw new Error("GitLab repository is missing its connection");
  }
  return {
    id: repository.id,
    integrationId: repository.integrationId,
    connectionId: repository.connectionId,
    providerRepositoryId: repository.providerRepositoryId,
    fullPath: repository.fullPath,
    webUrl: repository.webUrl,
    defaultBranch: repository.defaultBranch,
    webhookConfigured: Boolean(repository.webhookId),
    isActive: repository.isActive,
    createdAt: repository.createdAt.toISOString(),
    updatedAt: repository.updatedAt.toISOString(),
  };
}

function webhookBaseUrl() {
  const configured = process.env.KANEO_API_URL || "http://localhost:1337";
  return normalizeApiServerUrl(configured).replace(/\/$/, "");
}

export function gitLabWebhookUrl(repositoryId: string) {
  return `${webhookBaseUrl()}/gitlab-integration/webhook/${repositoryId}`;
}

/** GitLab Standard Webhooks require a 32-byte base64 key with this prefix. */
export function generateGitLabSigningToken() {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

function throwRepositoryError(error: unknown): never {
  if (error instanceof HTTPException) throw error;
  if (error instanceof GitLabApiError) {
    const message =
      error.status === 403
        ? "GitLab Maintainer or Owner access is required to manage project webhooks"
        : `GitLab repository setup failed (${error.status})`;
    throw new HTTPException(400, { message });
  }
  if (error instanceof Error) {
    throw new HTTPException(400, { message: error.message });
  }
  throw new HTTPException(400, { message: "GitLab repository setup failed" });
}

async function requireProjectWorkspace(projectId: string) {
  const [project] = await db
    .select({ workspaceId: projectTable.workspaceId })
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .limit(1);
  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }
  return project.workspaceId;
}

async function getOrCreateGitLabIntegration(projectId: string) {
  const [integration] = await db
    .insert(integrationTable)
    .values({
      projectId,
      type: "gitlab",
      config: JSON.stringify({ multiRepository: true }),
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [integrationTable.projectId, integrationTable.type],
      set: { isActive: true },
    })
    .returning();
  if (!integration) {
    throw new HTTPException(500, {
      message: "Failed to create GitLab integration",
    });
  }
  return integration;
}

export async function listProjectGitLabRepositories(projectId: string) {
  const repositories = await db
    .select({ repository: integrationRepositoryTable })
    .from(integrationRepositoryTable)
    .innerJoin(
      integrationTable,
      eq(integrationRepositoryTable.integrationId, integrationTable.id),
    )
    .where(
      and(
        eq(integrationTable.projectId, projectId),
        eq(integrationTable.type, "gitlab"),
        eq(integrationRepositoryTable.provider, "gitlab"),
      ),
    )
    .orderBy(asc(integrationRepositoryTable.fullPath));
  return repositories.map(({ repository }) =>
    toPublicGitLabRepository(repository),
  );
}

export async function attachGitLabRepository(input: {
  projectId: string;
  connectionId: string;
  providerRepositoryId: number;
}) {
  const workspaceId = await requireProjectWorkspace(input.projectId);
  const connection = await requireGitLabConnection(
    workspaceId,
    input.connectionId,
  );
  const client = await getGitLabClientForConnection(connection);

  let project: GitLabProject;
  try {
    project = await client.getProject(input.providerRepositoryId);
  } catch (error) {
    throwRepositoryError(error);
  }
  if (project.archived || !project.issues_enabled) {
    throw new HTTPException(400, {
      message: "The GitLab project must be active with issues enabled",
    });
  }

  const integration = await getOrCreateGitLabIntegration(input.projectId);
  const signingToken = generateGitLabSigningToken();
  let repository: GitLabRepositoryRow | undefined;

  try {
    [repository] = await db
      .insert(integrationRepositoryTable)
      .values({
        integrationId: integration.id,
        connectionId: connection.id,
        provider: "gitlab",
        remoteOrigin: connection.publicUrl,
        providerRepositoryId: String(project.id),
        fullPath: project.path_with_namespace,
        webUrl: project.web_url,
        defaultBranch: project.default_branch,
        webhookSecretCiphertext: encryptScmSecret(signingToken),
        metadata: {
          visibility: project.visibility,
          issuesEnabled: project.issues_enabled,
          mergeRequestsEnabled: project.merge_requests_enabled,
        },
        isActive: true,
      })
      .returning();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new HTTPException(409, {
        message: "This GitLab repository is already attached",
      });
    }
    throw error;
  }

  if (!repository) {
    throw new HTTPException(500, {
      message: "Failed to attach GitLab repository",
    });
  }

  let hookId: number | undefined;
  try {
    const url = gitLabWebhookUrl(repository.id);
    const hook = await client.createProjectHook(project.id, {
      url,
      signingToken,
      enableSslVerification: url.startsWith("https://"),
    });
    hookId = hook.id;
    const [updated] = await db
      .update(integrationRepositoryTable)
      .set({ webhookId: String(hook.id) })
      .where(eq(integrationRepositoryTable.id, repository.id))
      .returning();
    if (!updated) throw new Error("Failed to save GitLab webhook ID");
    return toPublicGitLabRepository(updated);
  } catch (error) {
    if (hookId !== undefined) {
      try {
        await client.deleteProjectHook(project.id, hookId);
      } catch {
        // The local binding is still removed below; GitLab may retain an
        // orphaned hook whose signature is no longer accepted by Kaneo.
      }
    }
    await db
      .delete(integrationRepositoryTable)
      .where(eq(integrationRepositoryTable.id, repository.id));
    throwRepositoryError(error);
  }
}

export async function detachGitLabRepository(input: {
  projectId: string;
  repositoryId: string;
}) {
  const [binding] = await db
    .select({
      repository: integrationRepositoryTable,
      connection: scmConnectionTable,
    })
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
        eq(integrationRepositoryTable.id, input.repositoryId),
        eq(integrationRepositoryTable.provider, "gitlab"),
        eq(integrationTable.projectId, input.projectId),
        eq(integrationTable.type, "gitlab"),
      ),
    )
    .limit(1);

  if (!binding) {
    throw new HTTPException(404, { message: "GitLab repository not found" });
  }

  if (binding.repository.webhookId) {
    try {
      await (
        await getGitLabClientForConnection(binding.connection)
      ).deleteProjectHook(
        binding.repository.providerRepositoryId,
        binding.repository.webhookId,
      );
    } catch (error) {
      throwRepositoryError(error);
    }
  }

  await db
    .delete(integrationRepositoryTable)
    .where(eq(integrationRepositoryTable.id, binding.repository.id));
}
