import { and, eq } from "drizzle-orm";
import db from "../../database";
import { integrationTable } from "../../database/schema";
import {
  defaultGiteaConfig,
  type GiteaConfig,
} from "../../plugins/gitea/config";
import { normalizeApiServerUrl } from "../../utils/openapi-spec";
import {
  getMaskedGiteaConnectionToken,
  listAttachedGiteaRepositories,
} from "../repositories";

async function getGiteaIntegration(
  projectId: string,
  includeWebhookSecret = false,
) {
  const integration = await db.query.integrationTable.findFirst({
    where: and(
      eq(integrationTable.projectId, projectId),
      eq(integrationTable.type, "gitea"),
    ),
  });

  if (!integration) {
    return null;
  }

  const config = JSON.parse(integration.config) as GiteaConfig;

  const apiBase = normalizeApiServerUrl(
    process.env.KANEO_API_URL || "http://localhost:1337",
  );
  const repositories = await listAttachedGiteaRepositories(
    integration.id,
    apiBase,
    includeWebhookSecret,
  );
  const primaryRepository = repositories[0];
  const connection = await db.query.integrationRepositoryTable.findFirst({
    where: (table, { and, eq, isNotNull }) =>
      and(
        eq(table.integrationId, integration.id),
        eq(table.provider, "gitea"),
        isNotNull(table.connectionId),
      ),
    columns: { connectionId: true },
  });

  return {
    id: integration.id,
    projectId: integration.projectId,
    baseUrl: config.baseUrl,
    repositoryOwner: config.repositoryOwner,
    repositoryName: config.repositoryName,
    maskedAccessToken: connection?.connectionId
      ? await getMaskedGiteaConnectionToken(connection.connectionId)
      : "",
    webhookUrl: primaryRepository?.webhookUrl,
    webhookSecret: primaryRepository?.webhookSecret ?? "",
    branchPattern: config.branchPattern || defaultGiteaConfig.branchPattern,
    commentTaskLinkOnGiteaIssue: config.commentTaskLinkOnGiteaIssue !== false,
    isActive: integration.isActive,
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt,
    repositories,
  };
}

export default getGiteaIntegration;
