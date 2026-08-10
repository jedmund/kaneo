import { updateExternalLink } from "../../github/services/link-manager";
import type { PluginContext, TaskTitleChangedEvent } from "../../types";
import { requireGitLabContext } from "../context";
import {
  findGitLabIssueLink,
  parseGitLabIssueIid,
  parseGitLabLinkMetadata,
} from "../link";

export async function handleTaskTitleChanged(
  event: TaskTitleChangedEvent,
  context: PluginContext,
) {
  const link = await findGitLabIssueLink(event.taskId, context);
  if (!link) return;
  const metadata = parseGitLabLinkMetadata(link.metadata);
  if (
    metadata.lastSync?.title?.source === "gitlab" &&
    metadata.lastSync.title.value === event.newTitle
  ) {
    return;
  }
  const { client, projectId } = requireGitLabContext(context);
  await client.updateIssue(projectId, parseGitLabIssueIid(link.externalId), {
    title: event.newTitle,
  });
  await updateExternalLink(link.id, {
    title: event.newTitle,
    metadata: {
      ...metadata,
      lastSync: {
        ...metadata.lastSync,
        title: {
          timestamp: new Date().toISOString(),
          source: "kaneo",
          value: event.newTitle,
        },
      },
    },
  });
}
