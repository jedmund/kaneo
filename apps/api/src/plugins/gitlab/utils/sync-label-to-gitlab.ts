import { eq } from "drizzle-orm";
import db from "../../../database";
import { externalLinkTable } from "../../../database/schema";
import { getValidGitLabCredential } from "../../../gitlab-integration/oauth";
import { createGitLabClient } from "../client";

const namedColorToHex: Record<string, string> = {
  red: "EF4444",
  orange: "F97316",
  amber: "F59E0B",
  yellow: "EAB308",
  lime: "84CC16",
  green: "22C55E",
  emerald: "10B981",
  teal: "14B8A6",
  cyan: "06B6D4",
  sky: "0EA5E9",
  blue: "3B82F6",
  indigo: "6366F1",
  violet: "8B5CF6",
  purple: "A855F7",
  fuchsia: "D946EF",
  pink: "EC4899",
  rose: "F43F5E",
  gray: "6B7280",
  slate: "64748B",
  zinc: "71717A",
  neutral: "737373",
  stone: "78716C",
};

export function toGitLabLabelColor(color: string) {
  const lower = color.trim().toLowerCase().replace(/^#/, "");
  const named = namedColorToHex[lower];
  if (named) return `#${named}`;
  if (/^[0-9a-f]{6}$/i.test(lower)) return `#${lower.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/i.test(lower)) {
    const [red, green, blue] = lower.split("");
    return `#${red}${red}${green}${green}${blue}${blue}`.toUpperCase();
  }
  return "#6B7280";
}

async function getGitLabIssueContext(taskId: string) {
  const links = await db.query.externalLinkTable.findMany({
    where: eq(externalLinkTable.taskId, taskId),
    with: {
      integration: true,
      integrationRepository: { with: { connection: true } },
    },
  });
  const link = links.find(
    (candidate) =>
      candidate.resourceType === "issue" &&
      candidate.integration?.type === "gitlab" &&
      candidate.integrationRepository?.provider === "gitlab" &&
      candidate.integrationRepository.connection,
  );
  const repository = link?.integrationRepository;
  const connection = repository?.connection;
  if (!link || !repository || !connection) return null;

  const projectId = Number.parseInt(repository.providerRepositoryId, 10);
  const issueIid = Number.parseInt(link.externalId, 10);
  if (
    !Number.isSafeInteger(projectId) ||
    projectId < 1 ||
    !Number.isSafeInteger(issueIid) ||
    issueIid < 1
  ) {
    console.warn("Invalid GitLab issue binding for label sync", {
      externalLinkId: link.id,
      repositoryId: repository.id,
      taskId,
    });
    return null;
  }

  const credential = await getValidGitLabCredential(connection);
  return {
    client: createGitLabClient({
      publicUrl: connection.publicUrl,
      internalUrl: connection.internalUrl,
      auth: { type: credential.type, accessToken: credential.accessToken },
    }),
    projectId,
    issueIid,
  };
}

export async function syncLabelToGitLab(
  taskId: string,
  labelName: string,
  labelColor: string,
) {
  const context = await getGitLabIssueContext(taskId);
  if (!context) return;
  const color = toGitLabLabelColor(labelColor);
  const labels = await context.client.listLabels(context.projectId);
  let label = labels.find((candidate) => candidate.name === labelName);

  if (!label) {
    label = await context.client.createLabel(context.projectId, {
      name: labelName,
      color,
    });
  } else if (toGitLabLabelColor(label.color) !== color) {
    label = await context.client.updateLabel(context.projectId, labelName, {
      color,
    });
  }

  const issue = await context.client.getIssue(
    context.projectId,
    context.issueIid,
  );
  if (issue.labels.includes(label.name)) return;
  await context.client.updateIssue(context.projectId, context.issueIid, {
    labels: [...issue.labels, label.name],
  });
}

export async function removeLabelFromGitLab(taskId: string, labelName: string) {
  const context = await getGitLabIssueContext(taskId);
  if (!context) return;
  const issue = await context.client.getIssue(
    context.projectId,
    context.issueIid,
  );
  if (!issue.labels.includes(labelName)) return;
  await context.client.updateIssue(context.projectId, context.issueIid, {
    labels: issue.labels.filter((name) => name !== labelName),
  });
}
