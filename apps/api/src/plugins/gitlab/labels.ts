import { type createGitLabClient, GitLabApiError } from "./client";

type GitLabClient = ReturnType<typeof createGitLabClient>;

const labelColors: Record<string, string> = {
  "priority:low": "#0EA5E9",
  "priority:medium": "#EAB308",
  "priority:high": "#F97316",
  "priority:urgent": "#EF4444",
  "status:backlog": "#6B7280",
  "status:todo": "#3B82F6",
  "status:in-progress": "#F59E0B",
  "status:in-review": "#8B5CF6",
  "status:done": "#10B981",
};

function fallbackColor(label: string) {
  let hash = 0;
  for (const character of label) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `#${(hash & 0xffffff).toString(16).padStart(6, "0")}`;
}

async function ensureLabels(
  client: GitLabClient,
  projectId: number,
  labels: string[],
) {
  const existing = new Set(
    (await client.listLabels(projectId)).map((label) => label.name),
  );
  for (const label of labels) {
    if (existing.has(label)) continue;
    try {
      await client.createLabel(projectId, {
        name: label,
        color: labelColors[label] ?? fallbackColor(label),
        description: "Managed by Kaneo",
      });
      existing.add(label);
    } catch (error) {
      if (!(error instanceof GitLabApiError) || error.status !== 409) {
        throw error;
      }
    }
  }
}

export async function replaceManagedLabel(input: {
  client: GitLabClient;
  projectId: number;
  issueIid: number;
  prefix: "priority:" | "status:";
  label?: string;
}) {
  if (input.label) {
    await ensureLabels(input.client, input.projectId, [input.label]);
  }
  const issue = await input.client.getIssue(input.projectId, input.issueIid);
  const labels = issue.labels.filter(
    (label) => !label.startsWith(input.prefix),
  );
  if (input.label) labels.push(input.label);
  await input.client.updateIssue(input.projectId, input.issueIid, { labels });
}

export async function decorateGitLabIssue(input: {
  client: GitLabClient;
  projectId: number;
  issueIid: number;
  labels: string[];
}) {
  await ensureLabels(input.client, input.projectId, input.labels);
  const issue = await input.client.getIssue(input.projectId, input.issueIid);
  const managedPrefixes = ["priority:", "status:"];
  const labels = issue.labels.filter(
    (label) => !managedPrefixes.some((prefix) => label.startsWith(prefix)),
  );
  labels.push(...input.labels);
  await input.client.updateIssue(input.projectId, input.issueIid, { labels });
}
