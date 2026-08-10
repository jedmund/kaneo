import {
  createExternalLink,
  findExternalLinkByTaskAndType,
} from "../../github/services/link-manager";
import {
  formatIssueBody,
  formatIssueTitle,
  getLabelsForIssue,
} from "../../github/utils/format";
import type { PluginContext, TaskCreatedEvent } from "../../types";
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
    description: formatIssueBody(event.description, event.taskId),
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
