import { and, eq } from "drizzle-orm";
import db from "../../database";
import {
  activityTable,
  columnTable,
  externalLinkTable,
  labelTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { claimTaskNumber } from "../../task/controllers/claim-task-numbers";
import {
  createExternalLink,
  createOrUpdateExternalLink,
  findExternalLink,
  updateExternalLink,
} from "../github/services/link-manager";
import {
  findTaskById,
  findTaskByNumber,
  isTaskInFinalState,
  updateTaskStatus,
} from "../github/services/task-service";
import { resolveTargetStatus } from "../github/utils/resolve-column";
import { parseGitLabLinkMetadata } from "./link";

export type GitLabWebhookBinding = {
  repository: {
    id: string;
    integrationId: string;
    providerRepositoryId: string;
    webUrl: string;
    fullPath: string;
  };
  integration: {
    id: string;
    projectId: string;
    project: { id: string; slug: string; workspaceId: string };
  };
  connection: {
    metadata: unknown;
  };
};

type GitLabUser = {
  id?: number;
  username?: string;
  name?: string;
  avatar_url?: string;
};

type GitLabProjectPayload = {
  id: number;
  web_url?: string;
  path_with_namespace?: string;
};

type GitLabLabelPayload = {
  id?: number;
  title: string;
  color?: string;
};

type GitLabIssueHook = {
  object_kind: "issue";
  user?: GitLabUser;
  project: GitLabProjectPayload;
  labels?: GitLabLabelPayload[];
  object_attributes: {
    id: number;
    iid: number;
    project_id: number;
    action?: "open" | "close" | "reopen" | "update";
    state: "opened" | "closed";
    title: string;
    description?: string | null;
    url: string;
  };
  changes?: Record<
    string,
    { previous?: unknown; current?: unknown } | undefined
  >;
};

type GitLabNoteHook = {
  object_kind: "note";
  user?: GitLabUser;
  project: GitLabProjectPayload;
  issue?: { id: number; iid: number };
  object_attributes: {
    id: number;
    note: string;
    noteable_type: string;
    noteable_iid?: number;
    url?: string;
    system?: boolean;
  };
};

type GitLabPushHook = {
  object_kind: "push";
  ref: string;
  checkout_sha?: string | null;
  project: GitLabProjectPayload;
  commits?: Array<{
    id: string;
    message: string;
    timestamp?: string;
    url?: string;
    author?: { name?: string };
  }>;
};

type GitLabMergeRequestHook = {
  object_kind: "merge_request";
  user?: GitLabUser;
  project: GitLabProjectPayload;
  object_attributes: {
    id: number;
    iid: number;
    action?: string;
    state: "opened" | "closed" | "merged" | "locked";
    title: string;
    description?: string | null;
    url: string;
    source_branch: string;
    target_branch: string;
    draft?: boolean;
    work_in_progress?: boolean;
    created_at?: string;
    updated_at?: string;
    merged_at?: string | null;
    closed_at?: string | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function gitLabObjectKind(payload: unknown) {
  if (!isRecord(payload) || typeof payload.object_kind !== "string") {
    return null;
  }
  return payload.object_kind;
}

function requirePayloadProjectId(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.project)) {
    throw new Error("GitLab webhook payload is missing its project");
  }
  const projectId = payload.project.id;
  if (typeof projectId !== "number" || !Number.isSafeInteger(projectId)) {
    throw new Error("GitLab webhook payload has an invalid project ID");
  }
  return projectId;
}

function requireBindingProject(
  payload: unknown,
  binding: GitLabWebhookBinding,
) {
  const projectId = requirePayloadProjectId(payload);
  if (String(projectId) !== binding.repository.providerRepositoryId) {
    throw new Error("GitLab webhook project does not match this repository");
  }
}

function managedValues(labels: GitLabLabelPayload[] | undefined) {
  const names = (labels ?? []).map((label) => label.title);
  return {
    priority: names.find((name) => name.startsWith("priority:"))?.slice(9),
    status: names.find((name) => name.startsWith("status:"))?.slice(7),
  };
}

function stripKaneoTaskMarker(description: string | null | undefined) {
  const value = description ?? "";
  return value
    .replace(/\n*---\n<sub>Task: [^<]+<\/sub>\s*$/u, "")
    .replace(/^<sub>Task: [^<]+<\/sub>\s*$/u, "")
    .trimEnd();
}

function connectionUsername(binding: GitLabWebhookBinding) {
  if (!isRecord(binding.connection.metadata)) return null;
  const username = binding.connection.metadata.gitlabUsername;
  return typeof username === "string" ? username : null;
}

async function publishStatusChange(
  result: Awaited<ReturnType<typeof updateTaskStatus>>,
) {
  if (result.applied && result.before.status !== result.after.status) {
    await publishEvent("task.status_changed", {
      taskId: result.after.id,
      projectId: result.after.projectId,
      userId: null,
      oldStatus: result.before.status,
      newStatus: result.after.status,
      title: result.after.title,
      assigneeId: result.after.userId,
      type: "status_changed",
    });
  }
}

async function publishPriorityChange(
  task: typeof taskTable.$inferSelect,
  priority: string,
) {
  const oldPriority = task.priority ?? "no-priority";
  if (oldPriority === priority) return;
  await db.update(taskTable).set({ priority }).where(eq(taskTable.id, task.id));
  await publishEvent("task.priority_changed", {
    taskId: task.id,
    projectId: task.projectId,
    userId: null,
    oldPriority,
    newPriority: priority,
    title: task.title,
    assigneeId: task.userId,
    type: "priority_changed",
  });
}

async function createTaskFromIssue(
  issue: GitLabIssueHook,
  binding: GitLabWebhookBinding,
) {
  const { priority, status } = managedValues(issue.labels);
  const projectId = binding.integration.projectId;
  const targetStatus = await resolveTargetStatus(
    projectId,
    "issue_opened",
    status || "to-do",
    "gitlab",
  );
  const targetColumn = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, projectId),
      eq(columnTable.slug, targetStatus),
    ),
  });
  const number = await claimTaskNumber(projectId);
  const [task] = await db
    .insert(taskTable)
    .values({
      projectId,
      userId: null,
      title: issue.object_attributes.title,
      description: stripKaneoTaskMarker(issue.object_attributes.description),
      status: targetStatus,
      columnId: targetColumn?.id ?? null,
      priority: priority ?? null,
      number,
    })
    .returning();
  if (!task) throw new Error("Failed to create task from GitLab issue");

  await createExternalLink({
    taskId: task.id,
    integrationId: binding.integration.id,
    integrationRepositoryId: binding.repository.id,
    resourceType: "issue",
    externalId: String(issue.object_attributes.iid),
    url: issue.object_attributes.url,
    title: issue.object_attributes.title,
    metadata: {
      state: issue.object_attributes.state,
      globalId: issue.object_attributes.id,
      createdFrom: "gitlab",
      author: issue.user?.username,
    },
  });
  return task;
}

async function findIssueLink(binding: GitLabWebhookBinding, issueIid: number) {
  return findExternalLink(
    binding.integration.id,
    "issue",
    String(issueIid),
    binding.repository.id,
  );
}

async function syncIssueLabels(
  taskId: string,
  labels: GitLabLabelPayload[] | undefined,
  changes?: { previous?: unknown; current?: unknown },
) {
  const task = await db.query.taskTable.findFirst({
    where: eq(taskTable.id, taskId),
    with: { project: true },
  });
  if (!task) return;
  const { priority, status } = managedValues(labels);
  if (priority) await publishPriorityChange(task, priority);
  if (status) {
    await publishStatusChange(await updateTaskStatus(task.id, status));
  }

  const externalLabels = (labels ?? []).filter(
    (label) =>
      !label.title.startsWith("priority:") &&
      !label.title.startsWith("status:"),
  );
  const existing = await db.query.labelTable.findMany({
    where: eq(labelTable.taskId, task.id),
  });
  for (const label of externalLabels) {
    if (existing.some((row) => row.name === label.title)) continue;
    await db
      .insert(labelTable)
      .values({
        name: label.title,
        color: label.color || "#6B7280",
        taskId: task.id,
        workspaceId: task.project.workspaceId,
      })
      .onConflictDoNothing({ target: [labelTable.taskId, labelTable.name] });
  }

  const labelNames = (value: unknown) =>
    Array.isArray(value)
      ? value.flatMap((entry) =>
          isRecord(entry) && typeof entry.title === "string"
            ? [entry.title]
            : [],
        )
      : [];
  const previous = new Set(labelNames(changes?.previous));
  const current = new Set(labelNames(changes?.current));
  for (const removed of previous) {
    if (current.has(removed)) continue;
    if (removed.startsWith("priority:")) {
      await publishPriorityChange(task, "no-priority");
      continue;
    }
    if (removed.startsWith("status:")) continue;
    await db
      .delete(labelTable)
      .where(and(eq(labelTable.taskId, task.id), eq(labelTable.name, removed)));
  }
}

export async function handleGitLabIssueHook(
  payload: GitLabIssueHook,
  binding: GitLabWebhookBinding,
) {
  requireBindingProject(payload, binding);
  const issue = payload.object_attributes;
  let link = await findIssueLink(binding, issue.iid);

  if (!link && issue.action === "open") {
    await createTaskFromIssue(payload, binding);
    link = await findIssueLink(binding, issue.iid);
  }
  if (!link) return;

  const task = await db.query.taskTable.findFirst({
    where: eq(taskTable.id, link.taskId),
  });
  if (!task) return;
  const metadata = parseGitLabLinkMetadata(link.metadata);
  let updatedMetadata = metadata;

  if (issue.action === "update") {
    const update: Partial<typeof taskTable.$inferInsert> = {};
    if (
      payload.changes?.title &&
      metadata.lastSync?.title?.value !== issue.title
    ) {
      update.title = issue.title;
    }
    const description = stripKaneoTaskMarker(issue.description);
    if (
      payload.changes?.description &&
      metadata.lastSync?.description?.value !== description
    ) {
      update.description = description;
    }
    if (Object.keys(update).length > 0) {
      await db.update(taskTable).set(update).where(eq(taskTable.id, task.id));
      updatedMetadata = {
        ...metadata,
        lastSync: {
          ...metadata.lastSync,
          ...(update.title !== undefined
            ? {
                title: {
                  timestamp: new Date().toISOString(),
                  source: "gitlab",
                  value: issue.title,
                },
              }
            : {}),
          ...(update.description !== undefined
            ? {
                description: {
                  timestamp: new Date().toISOString(),
                  source: "gitlab",
                  value: description,
                },
              }
            : {}),
        },
      };
      await updateExternalLink(link.id, {
        title: issue.title,
        metadata: updatedMetadata,
      });
    }
  }

  await syncIssueLabels(task.id, payload.labels, payload.changes?.labels);
  if (issue.action === "close") {
    const target = await resolveTargetStatus(
      task.projectId,
      "issue_closed",
      "done",
      "gitlab",
    );
    await publishStatusChange(await updateTaskStatus(task.id, target));
  } else if (issue.action === "reopen") {
    const target = await resolveTargetStatus(
      task.projectId,
      "issue_reopened",
      "to-do",
      "gitlab",
    );
    await publishStatusChange(await updateTaskStatus(task.id, target));
  }
  await updateExternalLink(link.id, {
    title: issue.title,
    url: issue.url,
    metadata: { ...updatedMetadata, state: issue.state },
  });
}

export async function handleGitLabNoteHook(
  payload: GitLabNoteHook,
  binding: GitLabWebhookBinding,
) {
  requireBindingProject(payload, binding);
  if (
    payload.object_attributes.system ||
    payload.object_attributes.noteable_type !== "Issue" ||
    payload.user?.username === connectionUsername(binding)
  ) {
    return;
  }
  const issueIid =
    payload.issue?.iid ?? payload.object_attributes.noteable_iid ?? null;
  if (!issueIid) return;
  const link = await findIssueLink(binding, issueIid);
  if (!link) return;
  const externalUrl =
    payload.object_attributes.url ??
    `${binding.repository.webUrl}/-/issues/${issueIid}#note_${payload.object_attributes.id}`;
  await db
    .insert(activityTable)
    .values({
      taskId: link.taskId,
      type: "comment",
      content: payload.object_attributes.note,
      externalUserName:
        payload.user?.username ?? payload.user?.name ?? "Unknown",
      externalUserAvatar: payload.user?.avatar_url ?? null,
      externalSource: "gitlab",
      externalUrl,
    })
    .onConflictDoNothing({
      target: [
        activityTable.taskId,
        activityTable.externalSource,
        activityTable.externalUrl,
      ],
    });
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractGitLabTaskNumber(
  projectSlug: string,
  ...values: Array<string | null | undefined>
) {
  const identifier = new RegExp(
    `(?:^|[^a-z0-9])${escapeRegex(projectSlug)}-(\\d+)(?:[^0-9]|$)`,
    "i",
  );
  for (const value of values) {
    const match = value?.match(identifier);
    if (!match?.[1]) continue;
    const number = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return null;
}

export async function handleGitLabPushHook(
  payload: GitLabPushHook,
  binding: GitLabWebhookBinding,
) {
  requireBindingProject(payload, binding);
  const branch = payload.ref.replace(/^refs\/heads\//, "");
  if (["main", "master", "develop", "staging", "production"].includes(branch)) {
    return;
  }
  const number = extractGitLabTaskNumber(
    binding.integration.project.slug,
    branch,
  );
  if (!number) return;
  const task = await findTaskByNumber(binding.integration.projectId, number);
  if (!task) return;
  const lastCommit = payload.commits?.at(-1);
  await createOrUpdateExternalLink({
    taskId: task.id,
    integrationId: binding.integration.id,
    integrationRepositoryId: binding.repository.id,
    resourceType: "branch",
    externalId: branch,
    url: `${binding.repository.webUrl}/-/tree/${encodeURIComponent(branch)}`,
    title: branch,
    metadata: {
      lastCommit: lastCommit
        ? {
            sha: lastCommit.id,
            message: lastCommit.message,
            author: lastCommit.author?.name,
            timestamp: lastCommit.timestamp,
            url: lastCommit.url,
          }
        : null,
      checkoutSha: payload.checkout_sha,
    },
  });
  if (!(await isTaskInFinalState(task))) {
    const target = await resolveTargetStatus(
      task.projectId,
      "branch_push",
      "in-progress",
      "gitlab",
    );
    await publishStatusChange(await updateTaskStatus(task.id, target));
  }
}

export async function handleGitLabMergeRequestHook(
  payload: GitLabMergeRequestHook,
  binding: GitLabWebhookBinding,
) {
  requireBindingProject(payload, binding);
  const mr = payload.object_attributes;
  let link = await findExternalLink(
    binding.integration.id,
    "pull_request",
    String(mr.iid),
    binding.repository.id,
  );
  let task = link ? await findTaskById(link.taskId) : null;
  if (!task) {
    const number = extractGitLabTaskNumber(
      binding.integration.project.slug,
      mr.source_branch,
      mr.title,
      mr.description,
    );
    if (!number) return;
    task = await findTaskByNumber(binding.integration.projectId, number);
    if (!task) return;
  }

  const state = mr.state;
  const draft = mr.draft ?? mr.work_in_progress ?? false;
  if (link) {
    await updateExternalLink(link.id, {
      title: mr.title,
      url: mr.url,
      metadata: {
        ...parseGitLabLinkMetadata(link.metadata),
        state,
        draft,
        merged: state === "merged",
        globalId: mr.id,
        branch: mr.source_branch,
        targetBranch: mr.target_branch,
        action: mr.action,
        mergedAt: mr.merged_at,
        closedAt: mr.closed_at,
        author: payload.user?.username,
      },
    });
  } else {
    await createExternalLink({
      taskId: task.id,
      integrationId: binding.integration.id,
      integrationRepositoryId: binding.repository.id,
      resourceType: "pull_request",
      externalId: String(mr.iid),
      url: mr.url,
      title: mr.title,
      metadata: {
        state,
        draft,
        merged: state === "merged",
        globalId: mr.id,
        branch: mr.source_branch,
        targetBranch: mr.target_branch,
        action: mr.action,
        mergedAt: mr.merged_at,
        closedAt: mr.closed_at,
        author: payload.user?.username,
      },
    });
    link = await findExternalLink(
      binding.integration.id,
      "pull_request",
      String(mr.iid),
      binding.repository.id,
    );
  }

  if (state === "opened" && !(await isTaskInFinalState(task))) {
    const target = await resolveTargetStatus(
      task.projectId,
      "pr_opened",
      "in-review",
      "gitlab",
    );
    await publishStatusChange(await updateTaskStatus(task.id, target));
  }

  if (state === "merged") {
    const links = await db.query.externalLinkTable.findMany({
      where: and(
        eq(externalLinkTable.taskId, task.id),
        eq(externalLinkTable.resourceType, "pull_request"),
      ),
    });
    const hasOpenMergeRequest = links.some((candidate) => {
      if (candidate.id === link?.id) return false;
      const candidateState = parseGitLabLinkMetadata(candidate.metadata).state;
      return candidateState === "open" || candidateState === "opened";
    });
    if (!hasOpenMergeRequest) {
      const target = await resolveTargetStatus(
        task.projectId,
        "pr_merged",
        "done",
        "gitlab",
      );
      await publishStatusChange(await updateTaskStatus(task.id, target));
    }
  }
}

export async function dispatchGitLabWebhook(
  payload: unknown,
  binding: GitLabWebhookBinding,
) {
  switch (gitLabObjectKind(payload)) {
    case "issue":
      return handleGitLabIssueHook(payload as GitLabIssueHook, binding);
    case "note":
      return handleGitLabNoteHook(payload as GitLabNoteHook, binding);
    case "push":
      return handleGitLabPushHook(payload as GitLabPushHook, binding);
    case "merge_request":
      return handleGitLabMergeRequestHook(
        payload as GitLabMergeRequestHook,
        binding,
      );
    default:
      return;
  }
}
