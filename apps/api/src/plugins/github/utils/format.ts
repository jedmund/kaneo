export function formatIssueTitle(taskTitle: string): string {
  return taskTitle;
}

export function formatIssueBody(
  taskDescription: string | null,
  taskId: string,
  scmSyncJobId?: string,
): string {
  const description = taskDescription || "";
  const markers = [
    `<sub>Task: ${taskId}</sub>`,
    ...(scmSyncJobId ? [`<!-- kaneo-scm-sync-job: ${scmSyncJobId} -->`] : []),
  ].join("\n");

  if (!description.trim()) {
    return markers;
  }

  return `${description}

---
${markers}`;
}

export function hasScmSyncJobMarker(
  issueBody: string | null | undefined,
  scmSyncJobId: string,
): boolean {
  return (
    issueBody?.includes(`<!-- kaneo-scm-sync-job: ${scmSyncJobId} -->`) ?? false
  );
}

export function formatSyncComment(taskId: string): string {
  return `Task: ${taskId}`;
}

export function getLabelsForIssue(
  priority: string | null,
  status: string,
): string[] {
  const labels: string[] = [];

  if (priority && priority !== "no-priority") {
    labels.push(`priority:${priority}`);
  }

  labels.push(`status:${status}`);

  return labels;
}

export function formatTaskDescriptionFromIssue(
  issueBody: string | null,
): string {
  return issueBody || "";
}
