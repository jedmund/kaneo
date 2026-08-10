import type { PluginContext, TaskStatusChangedEvent } from "../../types";
import { requireGitLabContext } from "../context";
import { replaceManagedLabel } from "../labels";
import {
  findGitLabIssueLink,
  parseGitLabIssueIid,
  parseGitLabLinkMetadata,
  updateGitLabLinkMetadata,
} from "../link";

export async function handleTaskStatusChanged(
  event: TaskStatusChangedEvent,
  context: PluginContext,
) {
  const link = await findGitLabIssueLink(event.taskId, context);
  if (!link) return;
  const issueIid = parseGitLabIssueIid(link.externalId);
  const { client, projectId } = requireGitLabContext(context);
  await replaceManagedLabel({
    client,
    projectId,
    issueIid,
    prefix: "status:",
    label: `status:${event.newStatus}`,
  });

  const metadata = parseGitLabLinkMetadata(link.metadata);
  let state = metadata.state;
  if (event.newStatus === "done" && state !== "closed") {
    await client.updateIssue(projectId, issueIid, { state_event: "close" });
    state = "closed";
  } else if (
    event.oldStatus === "done" &&
    event.newStatus !== "done" &&
    state === "closed"
  ) {
    await client.updateIssue(projectId, issueIid, { state_event: "reopen" });
    state = "opened";
  }
  await updateGitLabLinkMetadata(link, {
    state,
    lastOutboundStateSyncAt: Date.now(),
  });
}
