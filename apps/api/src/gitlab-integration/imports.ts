import { and, eq, max, notInArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  activityTable,
  columnTable,
  externalLinkTable,
  integrationRepositoryTable,
  labelTable,
  taskTable,
} from "../database/schema";
import { publishEvent } from "../events";
import {
  isTaskInFinalState,
  updateTaskStatus,
} from "../plugins/github/services/task-service";
import {
  extractIssuePriority,
  extractIssueStatus,
} from "../plugins/github/utils/extract-priority";
import { resolveTargetStatus } from "../plugins/github/utils/resolve-column";
import type {
  GitLabIssue,
  GitLabLabel,
  GitLabMergeRequest,
} from "../plugins/gitlab/client";
import { isKaneoGeneratedGitLabNote } from "../plugins/gitlab/notes";
import {
  extractGitLabTaskNumber,
  stripKaneoTaskMarker,
} from "../plugins/gitlab/webhook-events";
import { claimTaskNumber } from "../task/controllers/claim-task-numbers";
import {
  getGitLabClientForConnection,
  requireGitLabConnection,
} from "./connections";

export type GitLabImportResult = {
  imported: number;
  updated: number;
  skipped: number;
  mergeRequestsLinked: number;
  errors?: string[];
};

type ImportBinding = Awaited<ReturnType<typeof requireImportBinding>>;
type GitLabClient = Awaited<ReturnType<typeof getGitLabClientForConnection>>;

function normalizeLabelColor(color: string | undefined) {
  const normalized = color?.trim();
  if (!normalized) return "#6B7280";
  return normalized.startsWith("#") ? normalized : `#${normalized}`;
}

export function gitLabImportLabels(
  issue: Pick<GitLabIssue, "labels">,
  availableLabels: GitLabLabel[],
) {
  const colors = new Map(
    availableLabels.map((label) => [
      label.name,
      normalizeLabelColor(label.color),
    ]),
  );
  return issue.labels
    .filter(
      (name) => !name.startsWith("priority:") && !name.startsWith("status:"),
    )
    .map((name) => ({ name, color: colors.get(name) ?? "#6B7280" }));
}

async function requireImportBinding(projectId: string, repositoryId: string) {
  const binding = await db.query.integrationRepositoryTable.findFirst({
    where: and(
      eq(integrationRepositoryTable.id, repositoryId),
      eq(integrationRepositoryTable.provider, "gitlab"),
      eq(integrationRepositoryTable.isActive, true),
    ),
    with: {
      integration: { with: { project: true } },
      connection: true,
    },
  });
  if (
    !binding?.connection ||
    binding.integration.projectId !== projectId ||
    binding.integration.type !== "gitlab" ||
    !binding.integration.isActive
  ) {
    throw new HTTPException(404, {
      message: "Active GitLab repository not found for this project",
    });
  }
  return { ...binding, connection: binding.connection };
}

async function syncImportedLabels(
  taskId: string,
  workspaceId: string,
  labels: ReturnType<typeof gitLabImportLabels>,
) {
  const expectedNames = labels.map((label) => label.name);
  await db
    .delete(labelTable)
    .where(
      expectedNames.length > 0
        ? and(
            eq(labelTable.taskId, taskId),
            notInArray(labelTable.name, expectedNames),
          )
        : eq(labelTable.taskId, taskId),
    );

  for (const label of labels) {
    const workspaceLabel = await db.query.labelTable.findFirst({
      where: and(
        eq(labelTable.workspaceId, workspaceId),
        eq(labelTable.name, label.name),
      ),
    });
    await db
      .insert(labelTable)
      .values({
        name: label.name,
        color: workspaceLabel?.color ?? label.color,
        taskId,
        workspaceId,
      })
      .onConflictDoNothing({ target: [labelTable.taskId, labelTable.name] });
  }
}

async function importNotes(
  issueIid: number,
  taskId: string,
  binding: ImportBinding,
  client: GitLabClient,
) {
  const notes = await client.listIssueNotes(
    binding.providerRepositoryId,
    issueIid,
  );
  for (const note of notes) {
    if (note.system || isKaneoGeneratedGitLabNote(note.body)) continue;
    const externalUrl = `${binding.webUrl}/-/issues/${issueIid}#note_${note.id}`;
    await db
      .insert(activityTable)
      .values({
        taskId,
        type: "comment",
        content: note.body,
        externalUserName:
          note.author?.username ?? note.author?.name ?? "Unknown",
        externalUserAvatar: note.author?.avatar_url ?? null,
        externalSource: "gitlab",
        externalUrl,
        eventData: { externalCommentId: note.id },
      })
      .onConflictDoNothing({
        target: [
          activityTable.taskId,
          activityTable.externalSource,
          activityTable.externalUrl,
        ],
      });
  }
}

async function importIssue(
  issue: GitLabIssue,
  availableLabels: GitLabLabel[],
  binding: ImportBinding,
  client: GitLabClient,
) {
  const priority = extractIssuePriority(issue.labels) ?? "no-priority";
  const status = await resolveTargetStatus(
    binding.integration.projectId,
    "issue_opened",
    extractIssueStatus(issue.labels) ?? "to-do",
    "gitlab",
  );
  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, binding.integration.projectId),
      eq(columnTable.slug, status),
    ),
  });

  const result = await db.transaction(async (tx) => {
    const [existingLink] = await tx
      .select()
      .from(externalLinkTable)
      .where(
        and(
          eq(externalLinkTable.integrationRepositoryId, binding.id),
          eq(externalLinkTable.resourceType, "issue"),
          eq(externalLinkTable.externalId, String(issue.iid)),
        ),
      )
      .limit(1);

    if (existingLink) {
      const [task] = await tx
        .update(taskTable)
        .set({
          title: issue.title,
          description: stripKaneoTaskMarker(issue.description),
          status,
          columnId: column?.id ?? null,
          priority,
        })
        .where(eq(taskTable.id, existingLink.taskId))
        .returning();
      await tx
        .update(externalLinkTable)
        .set({
          title: issue.title,
          url: issue.web_url,
          metadata: JSON.stringify({
            state: issue.state,
            globalId: issue.id,
            createdFrom: "gitlab-import",
            author: issue.author?.username,
          }),
        })
        .where(eq(externalLinkTable.id, existingLink.id));
      return { task, kind: "updated" as const };
    }

    const [position] = await tx
      .select({ maximum: max(taskTable.position) })
      .from(taskTable)
      .where(
        and(
          eq(taskTable.projectId, binding.integration.projectId),
          column?.id
            ? eq(taskTable.columnId, column.id)
            : eq(taskTable.status, status),
        ),
      );
    const number = await claimTaskNumber(binding.integration.projectId, tx);
    const [task] = await tx
      .insert(taskTable)
      .values({
        projectId: binding.integration.projectId,
        userId: null,
        title: issue.title,
        description: stripKaneoTaskMarker(issue.description),
        status,
        columnId: column?.id ?? null,
        priority,
        number,
        position: (position?.maximum ?? 0) + 1,
      })
      .returning();
    if (!task) throw new Error("Failed to create task from GitLab import");

    await tx.insert(externalLinkTable).values({
      taskId: task.id,
      integrationId: binding.integration.id,
      integrationRepositoryId: binding.id,
      resourceType: "issue",
      externalId: String(issue.iid),
      url: issue.web_url,
      title: issue.title,
      metadata: JSON.stringify({
        state: issue.state,
        globalId: issue.id,
        createdFrom: "gitlab-import",
        author: issue.author?.username,
      }),
    });
    return { task, kind: "imported" as const };
  });

  if (!result.task) throw new Error("The linked Kaneo task no longer exists");
  await syncImportedLabels(
    result.task.id,
    binding.integration.project.workspaceId,
    gitLabImportLabels(issue, availableLabels),
  );
  await importNotes(issue.iid, result.task.id, binding, client);

  if (result.kind === "imported") {
    await publishEvent("task.created", {
      ...result.task,
      taskId: result.task.id,
      userId: "",
      type: "created",
      content: null,
      source: "gitlab-import",
    });
  }
  return result.kind;
}

async function linkMergeRequest(
  mergeRequest: GitLabMergeRequest,
  binding: ImportBinding,
) {
  const number = extractGitLabTaskNumber(
    binding.integration.project.slug,
    mergeRequest.source_branch,
    mergeRequest.title,
    mergeRequest.description,
  );
  if (!number) return false;
  const task = await db.query.taskTable.findFirst({
    where: and(
      eq(taskTable.projectId, binding.integration.projectId),
      eq(taskTable.number, number),
    ),
  });
  if (!task) return false;

  const metadata = JSON.stringify({
    state: mergeRequest.state,
    draft: mergeRequest.draft,
    merged: mergeRequest.state === "merged",
    globalId: mergeRequest.id,
    branch: mergeRequest.source_branch,
    targetBranch: mergeRequest.target_branch,
    mergedAt: mergeRequest.merged_at,
    closedAt: mergeRequest.closed_at,
    author: mergeRequest.author?.username,
    createdFrom: "gitlab-import",
  });
  const [existing] = await db
    .select({ id: externalLinkTable.id })
    .from(externalLinkTable)
    .where(
      and(
        eq(externalLinkTable.integrationRepositoryId, binding.id),
        eq(externalLinkTable.resourceType, "pull_request"),
        eq(externalLinkTable.externalId, String(mergeRequest.iid)),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(externalLinkTable)
      .set({
        taskId: task.id,
        title: mergeRequest.title,
        url: mergeRequest.web_url,
        metadata,
      })
      .where(eq(externalLinkTable.id, existing.id));
  } else {
    await db.insert(externalLinkTable).values({
      taskId: task.id,
      integrationId: binding.integration.id,
      integrationRepositoryId: binding.id,
      resourceType: "pull_request",
      externalId: String(mergeRequest.iid),
      title: mergeRequest.title,
      url: mergeRequest.web_url,
      metadata,
    });
  }

  if (!(await isTaskInFinalState(task))) {
    const reviewStatus = await resolveTargetStatus(
      task.projectId,
      "pr_opened",
      "in-review",
      "gitlab",
    );
    const statusResult = await updateTaskStatus(task.id, reviewStatus);
    if (
      statusResult.applied &&
      statusResult.before.status !== statusResult.after.status
    ) {
      await publishEvent("task.status_changed", {
        taskId: statusResult.after.id,
        projectId: statusResult.after.projectId,
        userId: null,
        oldStatus: statusResult.before.status,
        newStatus: statusResult.after.status,
        title: statusResult.after.title,
        assigneeId: statusResult.after.userId,
        type: "status_changed",
      });
    }
  }
  return true;
}

export async function importGitLabIssues(
  projectId: string,
  repositoryId: string,
): Promise<GitLabImportResult> {
  const binding = await requireImportBinding(projectId, repositoryId);
  const connection = await requireGitLabConnection(
    binding.integration.project.workspaceId,
    binding.connection.id,
  );
  const client = await getGitLabClientForConnection(connection);
  const [availableLabels, issues, mergeRequests] = await Promise.all([
    client.listLabels(binding.providerRepositoryId),
    client.listIssues(binding.providerRepositoryId, "opened"),
    client.listMergeRequests(binding.providerRepositoryId, "opened"),
  ]);

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let mergeRequestsLinked = 0;
  const errors: string[] = [];

  for (const issue of issues) {
    try {
      const kind = await importIssue(issue, availableLabels, binding, client);
      if (kind === "imported") imported += 1;
      else updated += 1;
    } catch (error) {
      skipped += 1;
      errors.push(
        `Issue #${issue.iid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const mergeRequest of mergeRequests) {
    try {
      if (await linkMergeRequest(mergeRequest, binding)) {
        mergeRequestsLinked += 1;
      }
    } catch (error) {
      errors.push(
        `Merge request !${mergeRequest.iid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    imported,
    updated,
    skipped,
    mergeRequestsLinked,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
