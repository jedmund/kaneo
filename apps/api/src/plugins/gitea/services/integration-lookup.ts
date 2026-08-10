import { and, eq } from "drizzle-orm";
import db from "../../../database";
import { integrationRepositoryTable } from "../../../database/schema";
import { decryptScmCredential } from "../../../scm/secrets";
import { normalizeGiteaBaseUrl } from "../config";

export async function findAllIntegrationsByGiteaRepo(
  baseUrl: string,
  owner: string,
  repo: string,
  repositoryOrIntegrationId?: string,
) {
  const normalized = normalizeGiteaBaseUrl(baseUrl);
  const conditions = [
    eq(integrationRepositoryTable.provider, "gitea"),
    eq(integrationRepositoryTable.isActive, true),
    eq(integrationRepositoryTable.remoteOrigin, normalized),
  ];

  const repositories = await db.query.integrationRepositoryTable.findMany({
    where: and(...conditions),
    with: {
      integration: { with: { project: true } },
      connection: true,
    },
  });

  const fullPath = `${owner}/${repo}`.toLowerCase();
  return repositories
    .filter((repository) => {
      const matches =
        repository.integration.isActive &&
        repository.fullPath.toLowerCase() === fullPath &&
        (!repositoryOrIntegrationId ||
          repository.id === repositoryOrIntegrationId ||
          repository.integration.id === repositoryOrIntegrationId);
      if (repositoryOrIntegrationId && !matches) {
        console.warn("[Gitea Webhook] Signed integration repository mismatch", {
          repositoryOrIntegrationId,
        });
      }
      return matches;
    })
    .map((repository) => {
      const path = repository.fullPath.split("/");
      const repositoryName = path.pop() ?? repository.fullPath;
      const repositoryOwner = path.join("/");
      const config = JSON.parse(repository.integration.config) as Record<
        string,
        unknown
      >;
      const credential = repository.connection
        ? decryptScmCredential(repository.connection.credentialCiphertext)
        : undefined;

      return {
        ...repository.integration,
        config: JSON.stringify({
          ...config,
          baseUrl:
            repository.connection?.internalUrl ?? repository.remoteOrigin,
          repositoryOwner,
          repositoryName,
          ...(credential?.type === "token"
            ? { accessToken: credential.accessToken }
            : {}),
        }),
        repository,
      };
    });
}

export function repoOwnerLogin(repo: {
  owner?: { login?: string; username?: string };
}): string {
  return repo.owner?.login ?? repo.owner?.username ?? "";
}
