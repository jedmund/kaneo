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
import { requireGitLabContext } from "../context";
import { decorateGitLabIssue } from "../labels";

export async function handleTaskCreated(
  event: TaskCreatedEvent,
  context: PluginContext,
) {
  const { client, projectId } = requireGitLabContext(context);
  const existing = await findExternalLinkByTaskAndType(
    event.taskId,
    context.integrationId,
    "issue",
    context.integrationRepositoryId,
  );
  if (existing) return;

  const issue = await client.createIssue(projectId, {
    title: formatIssueTitle(event.title),
    description: formatIssueBody(
      event.description,
      event.taskId,
      event.scmSyncJobId,
    ),
  });

  await createExternalLink({
    taskId: event.taskId,
    integrationId: context.integrationId,
    integrationRepositoryId: context.integrationRepositoryId,
    resourceType: "issue",
    externalId: String(issue.iid),
    url: issue.web_url,
    title: issue.title,
    metadata: {
      state: issue.state,
      globalId: issue.id,
      createdFrom: "kaneo",
      lastOutboundStateSyncAt: Date.now(),
    },
  });

  try {
    await decorateGitLabIssue({
      client,
      projectId,
      issueIid: issue.iid,
      labels: getLabelsForIssue(event.priority, event.status),
    });
  } catch (error) {
    console.error("Failed to decorate newly created GitLab issue:", error);
  }
}

export async function reconcileTaskCreated(
  event: TaskCreatedEvent,
  context: PluginContext,
): Promise<ReconciledScmIssue | null> {
  const syncJobId = event.scmSyncJobId;
  if (!syncJobId) {
    throw new Error("SCM sync job ID is required for GitLab reconciliation");
  }
  const { client, projectId } = requireGitLabContext(context);
  const issue = (await client.listIssues(projectId, "all")).find((candidate) =>
    hasScmSyncJobMarker(candidate.description, syncJobId),
  );
  if (!issue) return null;

  return {
    externalId: String(issue.iid),
    url: issue.web_url,
    title: issue.title,
    metadata: {
      state: issue.state,
      globalId: issue.id,
      createdFrom: "kaneo",
      recoveredFromSyncJob: syncJobId,
      lastOutboundStateSyncAt: Date.now(),
    },
  };
}
