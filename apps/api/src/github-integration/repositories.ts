import { and, asc, eq, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  integrationRepositoryTable,
  integrationTable,
  projectTable,
} from "../database/schema";
import { defaultGitHubConfig } from "../plugins/github/config";
import { getGithubApp } from "../plugins/github/utils/github-app";

const GITHUB_ORIGIN = "https://github.com";

type GitHubRepositoryMetadata = {
  installationId?: number;
  private?: boolean;
};

function metadataFor(row: { metadata: unknown }): GitHubRepositoryMetadata {
  return typeof row.metadata === "object" && row.metadata !== null
    ? (row.metadata as GitHubRepositoryMetadata)
    : {};
}

export function serializeGitHubRepository(row: {
  id: string;
  providerRepositoryId: string;
  fullPath: string;
  webUrl: string;
  defaultBranch: string | null;
  isActive: boolean;
  metadata: unknown;
}) {
  const metadata = metadataFor(row);

  return {
    id: row.id,
    providerRepositoryId: row.providerRepositoryId,
    fullPath: row.fullPath,
    webUrl: row.webUrl,
    defaultBranch: row.defaultBranch,
    installationId: metadata.installationId ?? null,
    private: metadata.private ?? false,
    isActive: row.isActive,
  };
}

export async function listAttachedGitHubRepositories(integrationId: string) {
  const repositories = await db.query.integrationRepositoryTable.findMany({
    where: and(
      eq(integrationRepositoryTable.integrationId, integrationId),
      eq(integrationRepositoryTable.provider, "github"),
    ),
    orderBy: asc(integrationRepositoryTable.fullPath),
  });

  return repositories.map(serializeGitHubRepository);
}

export async function attachGitHubRepository(input: {
  projectId: string;
  repositoryOwner: string;
  repositoryName: string;
}) {
  const githubApp = getGithubApp();
  if (!githubApp) {
    throw new HTTPException(500, { message: "GitHub app not configured" });
  }

  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, input.projectId),
  });
  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  let installationId: number;
  try {
    const { data: installation } =
      await githubApp.octokit.rest.apps.getRepoInstallation({
        owner: input.repositoryOwner,
        repo: input.repositoryName,
      });
    installationId = installation.id;
  } catch {
    throw new HTTPException(400, {
      message: "GitHub App is not installed on this repository",
    });
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);
  const { data: remoteRepository } = await octokit.rest.repos.get({
    owner: input.repositoryOwner,
    repo: input.repositoryName,
  });

  const existingBinding = await db.query.integrationRepositoryTable.findFirst({
    where: and(
      eq(integrationRepositoryTable.provider, "github"),
      eq(integrationRepositoryTable.remoteOrigin, GITHUB_ORIGIN),
      or(
        eq(
          integrationRepositoryTable.providerRepositoryId,
          remoteRepository.id.toString(),
        ),
        eq(integrationRepositoryTable.fullPath, remoteRepository.full_name),
      ),
    ),
    with: { integration: true },
  });

  if (
    existingBinding &&
    existingBinding.integration.projectId !== input.projectId
  ) {
    throw new HTTPException(409, {
      message: `Repository ${remoteRepository.full_name} is already linked to another project`,
    });
  }

  let integration = await db.query.integrationTable.findFirst({
    where: and(
      eq(integrationTable.projectId, input.projectId),
      eq(integrationTable.type, "github"),
    ),
  });

  if (!integration) {
    const [created] = await db
      .insert(integrationTable)
      .values({
        projectId: input.projectId,
        type: "github",
        config: JSON.stringify({
          repositoryOwner: remoteRepository.owner.login,
          repositoryName: remoteRepository.name,
          installationId,
          ...defaultGitHubConfig,
        }),
        isActive: true,
      })
      .returning();
    integration = created;
  } else if (!integration.isActive) {
    const [reactivated] = await db
      .update(integrationTable)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(integrationTable.id, integration.id))
      .returning();
    integration = reactivated;
  }

  if (!integration) {
    throw new HTTPException(500, {
      message: "Failed to create GitHub integration",
    });
  }

  const values = {
    integrationId: integration.id,
    provider: "github",
    remoteOrigin: GITHUB_ORIGIN,
    providerRepositoryId: remoteRepository.id.toString(),
    fullPath: remoteRepository.full_name,
    webUrl: remoteRepository.html_url,
    defaultBranch: remoteRepository.default_branch,
    metadata: {
      installationId,
      private: remoteRepository.private,
    },
    isActive: true,
  } as const;

  if (existingBinding) {
    await db
      .update(integrationRepositoryTable)
      .set({
        ...values,
        updatedAt: new Date(),
      })
      .where(eq(integrationRepositoryTable.id, existingBinding.id));
  } else {
    await db.insert(integrationRepositoryTable).values(values);
  }

  return integration.id;
}

export async function detachGitHubRepository(input: {
  projectId: string;
  repositoryId: string;
}) {
  const binding = await db.query.integrationRepositoryTable.findFirst({
    where: and(
      eq(integrationRepositoryTable.id, input.repositoryId),
      eq(integrationRepositoryTable.provider, "github"),
    ),
    with: { integration: true },
  });

  if (!binding || binding.integration.projectId !== input.projectId) {
    throw new HTTPException(404, { message: "GitHub repository not found" });
  }

  await db
    .delete(integrationRepositoryTable)
    .where(eq(integrationRepositoryTable.id, binding.id));

  const remaining = await db.query.integrationRepositoryTable.findFirst({
    where: and(
      eq(integrationRepositoryTable.integrationId, binding.integrationId),
      eq(integrationRepositoryTable.provider, "github"),
    ),
    columns: { id: true },
  });

  if (!remaining) {
    await db
      .delete(integrationTable)
      .where(eq(integrationTable.id, binding.integrationId));
  }

  return { success: true };
}

export async function requireAttachedGitHubRepository(input: {
  projectId: string;
  repositoryId: string;
}) {
  const binding = await db.query.integrationRepositoryTable.findFirst({
    where: and(
      eq(integrationRepositoryTable.id, input.repositoryId),
      eq(integrationRepositoryTable.provider, "github"),
      eq(integrationRepositoryTable.isActive, true),
    ),
    with: { integration: true },
  });

  if (
    !binding?.integration.isActive ||
    binding.integration.projectId !== input.projectId
  ) {
    throw new HTTPException(400, {
      message:
        "GitHub repository is inactive or does not belong to this project",
    });
  }

  const metadata = metadataFor(binding);
  if (!metadata.installationId) {
    throw new HTTPException(400, {
      message: "GitHub installation ID is not configured for this repository",
    });
  }

  const path = binding.fullPath.split("/");
  const repositoryName = path.pop();
  const repositoryOwner = path.join("/");
  if (!repositoryOwner || !repositoryName) {
    throw new HTTPException(500, { message: "Invalid GitHub repository path" });
  }

  return {
    binding,
    integration: binding.integration,
    installationId: metadata.installationId,
    repositoryOwner,
    repositoryName,
  };
}
