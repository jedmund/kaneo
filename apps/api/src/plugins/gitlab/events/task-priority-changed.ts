import type { PluginContext, TaskPriorityChangedEvent } from "../../types";
import { requireGitLabContext } from "../context";
import { replaceManagedLabel } from "../labels";
import { findGitLabIssueLink, parseGitLabIssueIid } from "../link";

export async function handleTaskPriorityChanged(
  event: TaskPriorityChangedEvent,
  context: PluginContext,
) {
  const link = await findGitLabIssueLink(event.taskId, context);
  if (!link) return;
  const { client, projectId } = requireGitLabContext(context);
  await replaceManagedLabel({
    client,
    projectId,
    issueIid: parseGitLabIssueIid(link.externalId),
    prefix: "priority:",
    label:
      event.newPriority && event.newPriority !== "no-priority"
        ? `priority:${event.newPriority}`
        : undefined,
  });
}
