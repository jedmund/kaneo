import type { InferSelectModel } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import db from "../../../database";
import {
  columnTable,
  integrationRepositoryTable,
  integrationTable,
  taskTable,
} from "../../../database/schema";

export type TaskRow = InferSelectModel<typeof taskTable>;

export type UpdateTaskStatusResult =
  | { applied: false }
  | { applied: true; before: TaskRow; after: TaskRow };

const NON_COLUMN_STATUSES = new Set(["planned", "archived"]);

export async function findTaskByNumber(projectId: string, taskNumber: number) {
  return db.query.taskTable.findFirst({
    where: and(
      eq(taskTable.projectId, projectId),
      eq(taskTable.number, taskNumber),
    ),
  });
}

export async function findTaskById(taskId: string) {
  return db.query.taskTable.findFirst({
    where: eq(taskTable.id, taskId),
  });
}

export async function updateTaskStatus(
  taskId: string,
  newStatus: string,
): Promise<UpdateTaskStatusResult> {
  const task = await db.query.taskTable.findFirst({
    where: eq(taskTable.id, taskId),
  });

  if (!task) {
    return { applied: false };
  }

  let columnId: string | null = null;

  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, task.projectId),
      eq(columnTable.slug, newStatus),
    ),
  });

  if (column) {
    columnId = column.id;
  } else if (!NON_COLUMN_STATUSES.has(newStatus)) {
    console.warn(
      `[GitHub] Skipping status update for task ${taskId}: column "${newStatus}" not found in project ${task.projectId}`,
    );
    return { applied: false };
  }

  await db
    .update(taskTable)
    .set({ status: newStatus, columnId })
    .where(eq(taskTable.id, taskId));

  const after = await db.query.taskTable.findFirst({
    where: eq(taskTable.id, taskId),
  });

  if (!after) {
    return { applied: false };
  }

  return { applied: true, before: task, after };
}

export async function isTaskInFinalState(task: {
  projectId: string;
  status: string;
  columnId: string | null;
}): Promise<boolean> {
  if (task.columnId) {
    const columnById = await db.query.columnTable.findFirst({
      where: and(
        eq(columnTable.id, task.columnId),
        eq(columnTable.projectId, task.projectId),
      ),
    });

    if (columnById) {
      return columnById.isFinal;
    }
  }

  const columnByStatus = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, task.projectId),
      eq(columnTable.slug, task.status),
    ),
  });

  if (columnByStatus) {
    return columnByStatus.isFinal;
  }

  return task.status === "done";
}

export async function getIntegrationWithProject(integrationId: string) {
  return db.query.integrationTable.findFirst({
    where: eq(integrationTable.id, integrationId),
    with: {
      project: true,
    },
  });
}

export async function findIntegrationByRepo(owner: string, repo: string) {
  const integrations = await findAllIntegrationsByRepo(owner, repo);
  return integrations[0] || null;
}

export async function findAllIntegrationsByRepo(owner: string, repo: string) {
  const repositories = await db.query.integrationRepositoryTable.findMany({
    where: and(
      eq(integrationRepositoryTable.provider, "github"),
      eq(integrationRepositoryTable.isActive, true),
    ),
    with: {
      integration: { with: { project: true } },
    },
  });

  const fullPath = `${owner}/${repo}`.toLowerCase();

  return repositories
    .filter(
      (repository) =>
        repository.integration.isActive &&
        repository.fullPath.toLowerCase() === fullPath,
    )
    .map((repository) => ({
      ...repository.integration,
      repository,
    }));
}
