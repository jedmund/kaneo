import {
  createExternalLink,
  findExternalLinkByTaskAndType,
} from "../../github/services/link-manager";
import {
  formatIssueBody,
  formatIssueTitle,
  getLabelsForIssue,
  hasScmSyncJobMarker,
} from "../../github/utils/format";
import type {
  PluginContext,
  ReconciledScmIssue,
  TaskCreatedEvent,
} from "../../types";
import type { GiteaConfig } from "../config";
import { createGiteaClient } from "../utils/gitea-api";
import { addLabelsToIssueGitea } from "../utils/labels";

function requireGiteaClient(context: PluginContext) {
  const config = context.config as GiteaConfig;
  if (!config.baseUrl || !config.accessToken) {
    throw new Error("Gitea connection is not configured");
  }
  return { config, client: createGiteaClient(config) };
}

export async function reconcileTaskCreated(
  event: TaskCreatedEvent,
  context: PluginContext,
): Promise<ReconciledScmIssue | null> {
  if (!event.scmSyncJobId) {
    throw new Error("SCM sync job ID is required for Gitea reconciliation");
  }
  const { config, client } = requireGiteaClient(context);
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const issues = await client.listIssues(
      config.repositoryOwner,
      config.repositoryName,
      page,
      "all",
    );
    const issue = issues.find(
      (candidate) =>
        !candidate.pull_request &&
        hasScmSyncJobMarker(candidate.body, event.scmSyncJobId ?? ""),
    );
    if (issue) {
      return {
        externalId: String(issue.number),
        url: issue.html_url,
        title: issue.title,
        metadata: { state: issue.state },
      };
    }
    if (issues.length < pageSize) return null;
  }
}

export async function handleTaskCreated(
  event: TaskCreatedEvent,
  context: PluginContext,
): Promise<void> {
  const { config, client } = requireGiteaClient(context);

  const { repositoryOwner, repositoryName } = config;

  const existingLink = await findExternalLinkByTaskAndType(
    event.taskId,
    context.integrationId,
    "issue",
    context.integrationRepositoryId,
  );

  if (existingLink) {
    return;
  }

  const createdIssue = await client.createIssue(
    repositoryOwner,
    repositoryName,
    {
      title: formatIssueTitle(event.title),
      body: formatIssueBody(
        event.description,
        event.taskId,
        event.scmSyncJobId,
      ),
    },
  );

  await createExternalLink({
    taskId: event.taskId,
    integrationId: context.integrationId,
    integrationRepositoryId: context.integrationRepositoryId,
    resourceType: "issue",
    externalId: createdIssue.number.toString(),
    url: createdIssue.html_url,
    title: createdIssue.title,
    metadata: {
      state: createdIssue.state,
      createdFrom: "kaneo",
      lastOutboundStateSyncAt: Date.now(),
    },
  });

  try {
    const labels = getLabelsForIssue(event.priority, event.status);
    await addLabelsToIssueGitea(config, createdIssue.number, labels);
  } catch (error) {
    console.error("Failed to decorate newly created Gitea issue:", error);
  }
}
