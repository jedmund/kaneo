import { updateExternalLink } from "../../github/services/link-manager";
import { formatIssueBody } from "../../github/utils/format";
import type { PluginContext, TaskDescriptionChangedEvent } from "../../types";
import { requireGitLabContext } from "../context";
import {
  findGitLabIssueLink,
  parseGitLabIssueIid,
  parseGitLabLinkMetadata,
} from "../link";

export async function handleTaskDescriptionChanged(
  event: TaskDescriptionChangedEvent,
  context: PluginContext,
) {
  const link = await findGitLabIssueLink(event.taskId, context);
  if (!link) return;
  const metadata = parseGitLabLinkMetadata(link.metadata);
  const value = event.newDescription ?? "";
  if (
    metadata.lastSync?.description?.source === "gitlab" &&
    metadata.lastSync.description.value === value
  ) {
    return;
  }
  const { client, projectId } = requireGitLabContext(context);
  await client.updateIssue(projectId, parseGitLabIssueIid(link.externalId), {
    description: formatIssueBody(event.newDescription, event.taskId),
  });
  await updateExternalLink(link.id, {
    metadata: {
      ...metadata,
      lastSync: {
        ...metadata.lastSync,
        description: {
          timestamp: new Date().toISOString(),
          source: "kaneo",
          value,
        },
      },
    },
  });
}
