import {
  findExternalLinkByTaskAndType,
  updateExternalLink,
} from "../github/services/link-manager";
import type { PluginContext } from "../types";

export type GitLabLinkMetadata = {
  state?: string;
  globalId?: number;
  createdFrom?: "kaneo" | "gitlab";
  lastOutboundStateSyncAt?: number;
  lastSync?: {
    title?: { timestamp: string; source: string; value: string };
    description?: { timestamp: string; source: string; value: string };
  };
  [key: string]: unknown;
};

export function parseGitLabLinkMetadata(value: string | null) {
  if (!value) return {} as GitLabLinkMetadata;
  try {
    return JSON.parse(value) as GitLabLinkMetadata;
  } catch {
    return {} as GitLabLinkMetadata;
  }
}

export async function findGitLabIssueLink(
  taskId: string,
  context: PluginContext,
) {
  return findExternalLinkByTaskAndType(
    taskId,
    context.integrationId,
    "issue",
    context.integrationRepositoryId,
  );
}

export function parseGitLabIssueIid(externalId: string) {
  if (!/^\d+$/.test(externalId)) {
    throw new Error("GitLab issue link has an invalid IID");
  }
  const issueIid = Number.parseInt(externalId, 10);
  if (!Number.isSafeInteger(issueIid) || issueIid < 1) {
    throw new Error("GitLab issue link has an invalid IID");
  }
  return issueIid;
}

export async function updateGitLabLinkMetadata(
  link: { id: string; metadata: string | null },
  patch: GitLabLinkMetadata,
) {
  await updateExternalLink(link.id, {
    metadata: { ...parseGitLabLinkMetadata(link.metadata), ...patch },
  });
}
