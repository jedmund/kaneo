import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  externalLinkTable,
  scmSyncJobTable,
  taskTable,
} from "../../database/schema";
import { processScmSyncJob } from "../../plugins/registry";
import { requireProjectRepository } from "../../scm/repositories";

export async function targetTaskRepository({
  taskId,
  integrationRepositoryId,
}: {
  taskId: string;
  integrationRepositoryId: string;
}) {
  const task = await db.query.taskTable.findFirst({
    where: eq(taskTable.id, taskId),
  });
  if (!task) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  await requireProjectRepository(task.projectId, integrationRepositoryId);

  const issueLink = await db.query.externalLinkTable.findFirst({
    where: and(
      eq(externalLinkTable.taskId, taskId),
      eq(externalLinkTable.resourceType, "issue"),
    ),
  });
  if (issueLink) {
    if (issueLink.integrationRepositoryId !== integrationRepositoryId) {
      throw new HTTPException(409, {
        message: "Task is already linked to an issue in another repository",
      });
    }
    return { status: "completed", externalLinkId: issueLink.id };
  }

  const dedupeKey = `task:${task.id}:create_issue`;
  const [createdJob] = await db
    .insert(scmSyncJobTable)
    .values({
      taskId: task.id,
      integrationRepositoryId,
      operation: "create_issue",
      dedupeKey,
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
    .onConflictDoNothing({ target: scmSyncJobTable.dedupeKey })
    .returning();

  const job =
    createdJob ??
    (await db.query.scmSyncJobTable.findFirst({
      where: eq(scmSyncJobTable.dedupeKey, dedupeKey),
    }));

  if (!job) {
    throw new HTTPException(500, { message: "Failed to queue issue creation" });
  }
  if (job.integrationRepositoryId !== integrationRepositoryId) {
    throw new HTTPException(409, {
      message: "Task already targets another repository",
    });
  }

  if (job.status === "pending" || job.status === "failed") {
    await processScmSyncJob(job.id);
  }

  const refreshed = await db.query.scmSyncJobTable.findFirst({
    where: eq(scmSyncJobTable.id, job.id),
  });

  return {
    id: job.id,
    status: refreshed?.status ?? job.status,
    lastError: refreshed?.lastError ?? job.lastError,
  };
}
