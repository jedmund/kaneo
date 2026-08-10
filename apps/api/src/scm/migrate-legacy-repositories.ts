import { and, eq, isNull } from "drizzle-orm";
import db from "../database";
import {
  externalLinkTable,
  integrationRepositoryTable,
} from "../database/schema";
import { normalizeScmOrigin } from "./repositories";

type LegacyIntegration = {
  id: string;
  type: string;
  config: string;
  isActive: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LegacyRepository = {
  integrationId: string;
  provider: "github" | "gitea";
  remoteOrigin: string;
  providerRepositoryId: string;
  fullPath: string;
  webUrl: string;
  metadata: { legacyConfig: true };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export function legacyRepositoryFromIntegration(
  integration: LegacyIntegration,
): LegacyRepository | undefined {
  if (integration.type !== "github" && integration.type !== "gitea") {
    return;
  }

  const config = JSON.parse(integration.config) as Record<string, unknown>;
  const owner =
    typeof config.repositoryOwner === "string"
      ? config.repositoryOwner.trim()
      : "";
  const name =
    typeof config.repositoryName === "string"
      ? config.repositoryName.trim()
      : "";

  if (!owner || !name) {
    return;
  }

  const fullPath = `${owner}/${name}`;
  const remoteOrigin = normalizeScmOrigin(
    integration.type === "github"
      ? "https://github.com"
      : String(config.baseUrl ?? ""),
  );

  return {
    integrationId: integration.id,
    provider: integration.type,
    remoteOrigin,
    providerRepositoryId:
      typeof config.repositoryId === "string" && config.repositoryId
        ? config.repositoryId
        : fullPath.toLowerCase(),
    fullPath,
    webUrl: `${remoteOrigin}/${fullPath}`,
    metadata: { legacyConfig: true },
    isActive: integration.isActive ?? true,
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt,
  };
}

/**
 * Complements migration 0038 for installations that still had rows in the old
 * github_integration table. That legacy table is converted during startup,
 * after Drizzle migrations have already run.
 */
export async function migrateLegacyScmRepositories(): Promise<void> {
  const integrations = await db.query.integrationTable.findMany({
    where: (table, { inArray }) => inArray(table.type, ["github", "gitea"]),
  });

  let migrated = 0;

  for (const integration of integrations) {
    try {
      const values = legacyRepositoryFromIntegration(integration);
      if (!values) continue;

      const [repository] = await db
        .insert(integrationRepositoryTable)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: integrationRepositoryTable.id });

      const resolvedRepository =
        repository ??
        (await db.query.integrationRepositoryTable.findFirst({
          where: and(
            eq(integrationRepositoryTable.integrationId, integration.id),
            eq(integrationRepositoryTable.fullPath, values.fullPath),
          ),
          columns: { id: true },
        }));

      if (!resolvedRepository) continue;

      await db
        .update(externalLinkTable)
        .set({ integrationRepositoryId: resolvedRepository.id })
        .where(
          and(
            eq(externalLinkTable.integrationId, integration.id),
            isNull(externalLinkTable.integrationRepositoryId),
          ),
        );

      if (repository) migrated += 1;
    } catch (error) {
      console.warn(
        `Could not migrate ${integration.type} repository for integration ${integration.id}:`,
        error,
      );
    }
  }

  if (migrated > 0) {
    console.log(`✓ Migrated ${migrated} legacy SCM repositories`);
  }
}
