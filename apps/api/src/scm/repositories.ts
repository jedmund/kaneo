import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  integrationRepositoryTable,
  integrationTable,
} from "../database/schema";

export type ScmProvider = "github" | "gitlab" | "gitea";

export type ProjectRepository = {
  id: string;
  integrationId: string;
  connectionId: string | null;
  projectId: string;
  provider: string;
  providerRepositoryId: string;
  fullPath: string;
  webUrl: string;
  defaultBranch: string | null;
  isActive: boolean;
};

const projectRepositorySelection = {
  id: integrationRepositoryTable.id,
  integrationId: integrationRepositoryTable.integrationId,
  connectionId: integrationRepositoryTable.connectionId,
  projectId: integrationTable.projectId,
  provider: integrationRepositoryTable.provider,
  providerRepositoryId: integrationRepositoryTable.providerRepositoryId,
  fullPath: integrationRepositoryTable.fullPath,
  webUrl: integrationRepositoryTable.webUrl,
  defaultBranch: integrationRepositoryTable.defaultBranch,
  isActive: integrationRepositoryTable.isActive,
};

export function normalizeScmOrigin(value: string): string {
  const parsed = new URL(value.trim());

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("SCM URL must use http or https");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "SCM URL must not contain credentials, a query, or a fragment",
    );
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export async function listProjectRepositories(
  projectId: string,
  options: { includeInactive?: boolean } = {},
): Promise<ProjectRepository[]> {
  const predicates = [
    eq(integrationTable.projectId, projectId),
    eq(integrationTable.isActive, true),
  ];

  if (!options.includeInactive) {
    predicates.push(eq(integrationRepositoryTable.isActive, true));
  }

  return db
    .select(projectRepositorySelection)
    .from(integrationRepositoryTable)
    .innerJoin(
      integrationTable,
      eq(integrationRepositoryTable.integrationId, integrationTable.id),
    )
    .where(and(...predicates))
    .orderBy(
      asc(integrationRepositoryTable.provider),
      asc(integrationRepositoryTable.fullPath),
    );
}

export async function getProjectRepository(
  projectId: string,
  integrationRepositoryId: string,
): Promise<ProjectRepository | undefined> {
  const [repository] = await db
    .select(projectRepositorySelection)
    .from(integrationRepositoryTable)
    .innerJoin(
      integrationTable,
      eq(integrationRepositoryTable.integrationId, integrationTable.id),
    )
    .where(
      and(
        eq(integrationRepositoryTable.id, integrationRepositoryId),
        eq(integrationRepositoryTable.isActive, true),
        eq(integrationTable.projectId, projectId),
        eq(integrationTable.isActive, true),
      ),
    )
    .limit(1);

  return repository;
}

export async function requireProjectRepository(
  projectId: string,
  integrationRepositoryId: string,
): Promise<ProjectRepository> {
  const repository = await getProjectRepository(
    projectId,
    integrationRepositoryId,
  );

  if (!repository) {
    throw new HTTPException(400, {
      message: "Repository is inactive or does not belong to this project",
    });
  }

  return repository;
}
