import type { PluginContext, TaskCommentCreatedEvent } from "../../types";
import { requireGitLabContext } from "../context";
import { findGitLabIssueLink, parseGitLabIssueIid } from "../link";

export async function handleTaskCommentCreated(
  event: TaskCommentCreatedEvent,
  context: PluginContext,
) {
  const link = await findGitLabIssueLink(event.taskId, context);
  if (!link) return;
  const { client, projectId } = requireGitLabContext(context);
  await client.createIssueNote(
    projectId,
    parseGitLabIssueIid(link.externalId),
    event.comment,
  );
}
