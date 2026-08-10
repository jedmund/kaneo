import { and, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  scmSyncJobTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { processScmSyncJob } from "../../plugins/registry";
import { requireProjectRepository } from "../../scm/repositories";
import { assertValidTaskStatus } from "../validate-task-fields";
import { claimTaskNumber } from "./claim-task-numbers";

async function createTask({
  projectId,
  currentUserId,
  userId,
  title,
  status,
  startDate,
  dueDate,
  description,
  priority,
  integrationRepositoryId,
}: {
  projectId: string;
  currentUserId: string;
  userId?: string;
  title: string;
  status: string;
  startDate?: Date;
  dueDate?: Date;
  description?: string;
  priority?: string;
  integrationRepositoryId?: string;
}) {
  const resolvedStatus = status || "to-do";
  const resolvedPriority = priority || "no-priority";

  await assertValidTaskStatus(resolvedStatus, projectId);

  if (integrationRepositoryId) {
    await requireProjectRepository(projectId, integrationRepositoryId);
  }

  const [assignee] = await db
    .select({ name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, userId ?? ""));

  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, projectId),
      eq(columnTable.slug, resolvedStatus),
    ),
  });

  const [maxPositionResult] = await db
    .select({ maxPosition: max(taskTable.position) })
    .from(taskTable)
    .where(
      and(
        eq(taskTable.projectId, projectId),
        column?.id
          ? eq(taskTable.columnId, column.id)
          : eq(taskTable.status, resolvedStatus),
      ),
    );

  const nextPosition = (maxPositionResult?.maxPosition ?? 0) + 1;

  const result = await db.transaction(async (tx) => {
    const taskNumber = await claimTaskNumber(projectId, tx);

    const [task] = await tx
      .insert(taskTable)
      .values({
        projectId,
        userId: userId || null,
        title: title || "",
        status: resolvedStatus,
        columnId: column?.id ?? null,
        startDate: startDate || null,
        dueDate: dueDate || null,
        description: description || "",
        priority: resolvedPriority,
        number: taskNumber,
        position: nextPosition,
      })
      .returning();

    if (!task) return { task: undefined, syncJob: undefined };

    const [syncJob] = integrationRepositoryId
      ? await tx
          .insert(scmSyncJobTable)
          .values({
            taskId: task.id,
            integrationRepositoryId,
            operation: "create_issue",
            dedupeKey: `task:${task.id}:create_issue`,
            payload: {
              taskId: task.id,
              projectId: task.projectId,
              userId: task.userId ?? "",
              title: task.title,
              description: task.description,
              priority: task.priority,
              status: task.status,
              number: task.number,
              integrationRepositoryId,
            },
          })
          .returning()
      : [];

    return { task, syncJob };
  });

  const createdTask = result.task;

  if (!createdTask) {
    throw new HTTPException(500, {
      message: "Failed to create task",
    });
  }

  await publishEvent("task.created", {
    ...createdTask,
    taskId: createdTask.id,
    userId: createdTask.userId ?? "",
    currentUserId: currentUserId,
    type: "created",
    content: null,
  });

  if (result.syncJob) {
    await processScmSyncJob(result.syncJob.id);
  }

  const syncJob = result.syncJob
    ? await db.query.scmSyncJobTable.findFirst({
        where: eq(scmSyncJobTable.id, result.syncJob.id),
      })
    : undefined;

  return {
    ...createdTask,
    assigneeName: assignee?.name,
    scmSync: syncJob
      ? {
          id: syncJob.id,
          status: syncJob.status,
          lastError: syncJob.lastError,
        }
      : null,
  };
}

export default createTask;
