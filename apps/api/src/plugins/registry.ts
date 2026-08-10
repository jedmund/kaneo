import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import db from "../database";
import {
  externalLinkTable,
  integrationTable,
  scmSyncJobTable,
} from "../database/schema";
import { subscribeToEvent } from "../events";
import { getValidGitLabCredential } from "../gitlab-integration/oauth";
import { decryptScmCredential } from "../scm/secrets";
import type {
  IntegrationPlugin,
  PluginContext,
  TaskAssigneeChangedEvent,
  TaskCommentCreatedEvent,
  TaskCreatedEvent,
  TaskDeletedEvent,
  TaskDescriptionChangedEvent,
  TaskDueDateChangedEvent,
  TaskMovedEvent,
  TaskPriorityChangedEvent,
  TaskStatusChangedEvent,
  TaskTitleChangedEvent,
  TaskUnassignedEvent,
} from "./types";

const plugins = new Map<string, IntegrationPlugin>();
let eventSubscriptionsInitialized = false;

export function registerPlugin(plugin: IntegrationPlugin): void {
  if (plugins.has(plugin.type)) {
    throw new Error(`Plugin ${plugin.type} already registered`);
  }
  plugins.set(plugin.type, plugin);
  console.log(`✓ Registered plugin: ${plugin.name}`);
}

export function initializeEventSubscriptions(): void {
  if (eventSubscriptionsInitialized) {
    return;
  }

  subscribeToEvent<{
    taskId: string;
    userId: string;
    title: string;
    description: string;
    priority: string;
    status: string;
    number: number;
    projectId: string;
  }>("task.created", async (data) => {
    await broadcastTaskCreated({
      taskId: data.taskId,
      projectId: data.projectId,
      userId: data.userId,
      title: data.title,
      description: data.description,
      priority: data.priority,
      status: data.status,
      number: data.number,
    });
  });

  subscribeToEvent<{
    taskId: string;
    userId: string | null;
    oldStatus: string;
    newStatus: string;
    title: string;
    projectId: string;
  }>("task.status_changed", async (data) => {
    await broadcastTaskStatusChanged({
      taskId: data.taskId,
      projectId: data.projectId,
      userId: data.userId,
      oldStatus: data.oldStatus,
      newStatus: data.newStatus,
      title: data.title,
    });
  });

  subscribeToEvent<{
    taskId: string;
    userId: string | null;
    oldPriority: string;
    newPriority: string;
    title: string;
    projectId: string;
  }>("task.priority_changed", async (data) => {
    await broadcastTaskPriorityChanged({
      taskId: data.taskId,
      projectId: data.projectId,
      userId: data.userId,
      oldPriority: data.oldPriority,
      newPriority: data.newPriority,
      title: data.title,
    });
  });

  subscribeToEvent<{
    taskId: string;
    userId: string | null;
    oldTitle: string;
    newTitle: string;
    projectId: string;
  }>("task.title_changed", async (data) => {
    await broadcastTaskTitleChanged({
      taskId: data.taskId,
      projectId: data.projectId,
      userId: data.userId,
      oldTitle: data.oldTitle,
      newTitle: data.newTitle,
    });
  });

  subscribeToEvent<{
    taskId: string;
    userId: string | null;
    oldDescription: string | null;
    newDescription: string | null;
    projectId: string;
  }>("task.description_changed", async (data) => {
    await broadcastTaskDescriptionChanged({
      taskId: data.taskId,
      projectId: data.projectId,
      userId: data.userId,
      oldDescription: data.oldDescription,
      newDescription: data.newDescription,
    });
  });

  subscribeToEvent<{
    taskId: string;
    userId: string;
    comment: string;
    projectId: string;
  }>("comment.created", async (data) => {
    await broadcastTaskCommentCreated({
      taskId: data.taskId,
      projectId: data.projectId,
      userId: data.userId,
      comment: data.comment,
    });
  });

  subscribeToEvent<{
    taskId: string;
    userId: string | null;
    title: string;
    projectId: string;
  }>("task.deleted", async (data) => {
    await broadcastTaskDeleted({
      taskId: data.taskId,
      projectId: data.projectId,
      userId: data.userId,
      title: data.title,
    });
  });

  subscribeToEvent<{
    taskId: string;
    userId: string | null;
    fromProjectId: string;
    fromProjectName: string;
    toProjectId: string;
    toProjectName: string;
    oldStatus: string;
    newStatus: string;
  }>("task.moved", async (data) => {
    await broadcastTaskMoved({
      taskId: data.taskId,
      projectId: data.toProjectId,
      userId: data.userId,
      fromProjectId: data.fromProjectId,
      fromProjectName: data.fromProjectName,
      toProjectId: data.toProjectId,
      toProjectName: data.toProjectName,
      oldStatus: data.oldStatus,
      newStatus: data.newStatus,
    });
  });

  subscribeToEvent<{
    taskId: string;
    userId: string | null;
    oldDueDate: Date | null;
    newDueDate: Date | null;
    title: string;
    projectId: string;
  }>("task.due_date_changed", async (data) => {
    await broadcastTaskDueDateChanged({
      taskId: data.taskId,
      projectId: data.projectId,
      userId: data.userId,
      title: data.title,
      oldDueDate: data.oldDueDate,
      newDueDate: data.newDueDate,
    });
  });

  subscribeToEvent<{
    taskId: string;
    userId: string | null;
    oldAssignee: string | null;
    newAssignee: string | undefined;
    newAssigneeId: string;
    title: string;
    projectId: string;
  }>("task.assignee_changed", async (data) => {
    await broadcastTaskAssigneeChanged({
      taskId: data.taskId,
      projectId: data.projectId,
      userId: data.userId,
      title: data.title,
      oldAssignee: data.oldAssignee,
      newAssignee: data.newAssignee,
      newAssigneeId: data.newAssigneeId,
    });
  });

  subscribeToEvent<{
    taskId: string;
    userId: string | null;
    title: string;
    projectId: string;
  }>("task.unassigned", async (data) => {
    await broadcastTaskUnassigned({
      taskId: data.taskId,
      projectId: data.projectId,
      userId: data.userId,
      title: data.title,
    });
  });

  eventSubscriptionsInitialized = true;
  console.log("✓ Plugin event subscriptions initialized");
}

export function getPlugin(type: string): IntegrationPlugin | undefined {
  return plugins.get(type);
}

export function listPlugins(): IntegrationPlugin[] {
  return Array.from(plugins.values());
}

async function getActiveIntegrations(projectId: string, taskId?: string) {
  if (!taskId) {
    return db.query.integrationTable.findMany({
      where: and(
        eq(integrationTable.projectId, projectId),
        eq(integrationTable.isActive, true),
      ),
      with: {
        project: true,
      },
    });
  }

  const links = await db.query.externalLinkTable.findMany({
    where: eq(externalLinkTable.taskId, taskId),
    with: {
      integrationRepository: { with: { connection: true } },
    },
  });
  const linkedIntegrationIds = Array.from(
    new Set(links.map((link) => link.integrationId)),
  );
  const integrations = await db.query.integrationTable.findMany({
    where: and(
      eq(integrationTable.isActive, true),
      linkedIntegrationIds.length > 0
        ? or(
            eq(integrationTable.projectId, projectId),
            inArray(integrationTable.id, linkedIntegrationIds),
          )
        : eq(integrationTable.projectId, projectId),
    ),
    with: {
      project: true,
    },
  });

  return integrations.flatMap((integration) => {
    const plugin = getPlugin(integration.type);
    if (plugin?.kind !== "scm") {
      return integration.projectId === projectId ? [integration] : [];
    }

    const repositories = new Map<
      string,
      NonNullable<(typeof links)[number]["integrationRepository"]>
    >();
    let hasLegacyLink = false;

    for (const link of links) {
      if (link.integrationId !== integration.id) continue;
      if (link.integrationRepository) {
        repositories.set(
          link.integrationRepository.id,
          link.integrationRepository,
        );
      } else {
        hasLegacyLink = true;
      }
    }

    if (repositories.size > 0) {
      return Array.from(repositories.values()).map((repository) => ({
        ...integration,
        repository,
      }));
    }

    // Compatibility for a link created before migration 0038. Startup
    // backfill normally removes this path, but a partially migrated database
    // must keep syncing its legacy primary repository.
    return hasLegacyLink ? [integration] : [];
  });
}

async function createContext(integration: {
  id: string;
  projectId: string;
  config: string;
  repository?: {
    id: string;
    connectionId: string | null;
    provider: string;
    providerRepositoryId: string;
    fullPath: string;
    remoteOrigin: string;
    webUrl: string;
    defaultBranch: string | null;
    metadata: unknown;
    connection?: {
      id: string;
      provider: string;
      authType: string;
      publicUrl: string;
      internalUrl: string;
      credentialCiphertext: string;
    } | null;
  };
}): Promise<PluginContext> {
  const config = JSON.parse(integration.config) as Record<string, unknown>;
  const repository = integration.repository;

  if (
    repository?.connection &&
    repository.connection.provider !== repository.provider
  ) {
    throw new Error("SCM repository and connection providers do not match");
  }

  if (repository) {
    const pathParts = repository.fullPath.split("/");
    const repositoryName = pathParts.pop() ?? repository.fullPath;
    const repositoryOwner = pathParts.join("/");
    const metadata =
      typeof repository.metadata === "object" && repository.metadata !== null
        ? (repository.metadata as Record<string, unknown>)
        : {};

    Object.assign(config, {
      repositoryId: repository.providerRepositoryId,
      repositoryOwner,
      repositoryName,
      ...(repository.provider === "gitea"
        ? { baseUrl: repository.remoteOrigin }
        : {}),
      ...(metadata.installationId !== undefined
        ? { installationId: metadata.installationId }
        : {}),
    });
  }

  const connectionCredential = repository?.connection
    ? repository.provider === "gitlab"
      ? await getValidGitLabCredential(repository.connection)
      : decryptScmCredential(repository.connection.credentialCiphertext)
    : undefined;

  return {
    integrationId: integration.id,
    integrationRepositoryId: repository?.id,
    projectId: integration.projectId,
    config,
    repository,
    ...(repository?.connection && connectionCredential
      ? {
          connection: {
            id: repository.connection.id,
            authType: repository.connection.authType,
            publicUrl: repository.connection.publicUrl,
            internalUrl: repository.connection.internalUrl,
            credential: connectionCredential,
          },
        }
      : {}),
  };
}

export async function broadcastTaskCreated(
  event: TaskCreatedEvent,
): Promise<void> {
  const integrations = await getActiveIntegrations(event.projectId);

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskCreated) continue;

    // SCM creation is exclusively driven through processScmSyncJob. Other
    // integrations still receive Kaneo-only and imported task events.
    if (plugin.kind === "scm") continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskCreated(event, context);
    } catch (error) {
      console.error(`Plugin ${plugin.type} error on task.created:`, error);
    }
  }
}

function syncRetryDelay(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempts - 1));
}

async function findTaskIssueLink(taskId: string, repositoryId: string) {
  return db.query.externalLinkTable.findFirst({
    where: and(
      eq(externalLinkTable.taskId, taskId),
      eq(externalLinkTable.integrationRepositoryId, repositoryId),
      eq(externalLinkTable.resourceType, "issue"),
    ),
  });
}

async function recordReconciledIssue(input: {
  taskId: string;
  integrationId: string;
  repositoryId: string;
  syncJobId: string;
  issue: {
    externalId: string;
    url: string;
    title: string | null;
    metadata?: Record<string, unknown>;
  };
}) {
  await db
    .insert(externalLinkTable)
    .values({
      taskId: input.taskId,
      integrationId: input.integrationId,
      integrationRepositoryId: input.repositoryId,
      resourceType: "issue",
      externalId: input.issue.externalId,
      url: input.issue.url,
      title: input.issue.title,
      metadata: JSON.stringify({
        ...input.issue.metadata,
        createdFrom: "kaneo",
        reconciledFromScmSyncJob: input.syncJobId,
      }),
    })
    .onConflictDoNothing({
      target: [
        externalLinkTable.integrationRepositoryId,
        externalLinkTable.resourceType,
        externalLinkTable.externalId,
      ],
    });

  const link = await db.query.externalLinkTable.findFirst({
    where: and(
      eq(externalLinkTable.integrationRepositoryId, input.repositoryId),
      eq(externalLinkTable.resourceType, "issue"),
      eq(externalLinkTable.externalId, input.issue.externalId),
    ),
  });
  if (!link) {
    throw new Error("Failed to record reconciled SCM issue");
  }
  if (link.taskId !== input.taskId) {
    throw new Error("Reconciled SCM issue is already linked to another task");
  }
}

export async function processScmSyncJob(jobId: string): Promise<boolean> {
  const now = new Date();
  const [claimed] = await db
    .update(scmSyncJobTable)
    .set({
      status: "processing",
      attempts: sql`${scmSyncJobTable.attempts} + 1`,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(scmSyncJobTable.id, jobId),
        inArray(scmSyncJobTable.status, ["pending", "failed"]),
        // Use the database clock so a defaultNow() value with microsecond
        // precision cannot compare later than JavaScript's millisecond clock.
        lte(scmSyncJobTable.nextAttemptAt, sql`CURRENT_TIMESTAMP`),
      ),
    )
    .returning();

  if (!claimed) return false;

  try {
    const job = await db.query.scmSyncJobTable.findFirst({
      where: eq(scmSyncJobTable.id, jobId),
      with: {
        integrationRepository: {
          with: { integration: true, connection: true },
        },
      },
    });

    const repository = job?.integrationRepository;
    const integration = repository?.integration;
    if (!job || !repository || !integration) {
      throw new Error("SCM sync job target no longer exists");
    }

    if (job.operation !== "create_issue") {
      throw new Error(`Unsupported SCM sync operation: ${job.operation}`);
    }

    if (!repository.isActive || !integration.isActive) {
      throw new Error("SCM sync job target is inactive");
    }

    const plugin = getPlugin(integration.type);
    if (plugin?.kind !== "scm" || !plugin.onTaskCreated) {
      throw new Error(`SCM plugin ${integration.type} is not available`);
    }

    const event: TaskCreatedEvent = {
      ...(job.payload as TaskCreatedEvent),
      taskId: job.taskId,
      projectId: integration.projectId,
      integrationRepositoryId: repository.id,
      scmSyncJobId: job.id,
      scmSyncAttempt: job.attempts,
    };
    const context = await createContext({ ...integration, repository });
    let issueLink = await findTaskIssueLink(job.taskId, repository.id);

    if (!issueLink && job.attempts > 1) {
      if (!plugin.reconcileTaskCreated) {
        throw new Error(
          `SCM plugin ${integration.type} cannot safely retry issue creation`,
        );
      }
      const reconciledIssue = await plugin.reconcileTaskCreated(event, context);
      if (reconciledIssue) {
        await recordReconciledIssue({
          taskId: job.taskId,
          integrationId: integration.id,
          repositoryId: repository.id,
          syncJobId: job.id,
          issue: reconciledIssue,
        });
        issueLink = await findTaskIssueLink(job.taskId, repository.id);
      }
    }

    if (!issueLink) {
      await plugin.onTaskCreated(event, context);
    }

    await db
      .update(scmSyncJobTable)
      .set({ status: "completed", completedAt: new Date(), lastError: null })
      .where(eq(scmSyncJobTable.id, job.id));
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 2_000) : String(error);
    await db
      .update(scmSyncJobTable)
      .set({
        status: "failed",
        lastError: message,
        nextAttemptAt: new Date(Date.now() + syncRetryDelay(claimed.attempts)),
      })
      .where(eq(scmSyncJobTable.id, claimed.id));
    console.error(`SCM sync job ${claimed.id} failed:`, error);
    return false;
  }
}

export async function retryScmSyncJobs(): Promise<void> {
  const now = new Date();
  const staleProcessing = new Date(now.getTime() - 10 * 60 * 1000);

  await db
    .update(scmSyncJobTable)
    .set({
      status: "failed",
      lastError: "Previous processing attempt did not finish",
      nextAttemptAt: now,
    })
    .where(
      and(
        eq(scmSyncJobTable.status, "processing"),
        lt(scmSyncJobTable.updatedAt, staleProcessing),
      ),
    );

  const jobs = await db
    .select({ id: scmSyncJobTable.id })
    .from(scmSyncJobTable)
    .where(
      and(
        or(
          eq(scmSyncJobTable.status, "pending"),
          eq(scmSyncJobTable.status, "failed"),
        ),
        lte(scmSyncJobTable.nextAttemptAt, now),
      ),
    )
    .limit(25);

  await Promise.allSettled(jobs.map((job) => processScmSyncJob(job.id)));
}

export async function broadcastTaskStatusChanged(
  event: TaskStatusChangedEvent,
): Promise<void> {
  const integrations = await getActiveIntegrations(
    event.projectId,
    event.taskId,
  );

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskStatusChanged) continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskStatusChanged(event, context);
    } catch (error) {
      console.error(
        `Plugin ${plugin.type} error on task.status_changed:`,
        error,
      );
    }
  }
}

export async function broadcastTaskPriorityChanged(
  event: TaskPriorityChangedEvent,
): Promise<void> {
  const integrations = await getActiveIntegrations(
    event.projectId,
    event.taskId,
  );

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskPriorityChanged) continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskPriorityChanged(event, context);
    } catch (error) {
      console.error(
        `Plugin ${plugin.type} error on task.priority_changed:`,
        error,
      );
    }
  }
}

export async function broadcastTaskTitleChanged(
  event: TaskTitleChangedEvent,
): Promise<void> {
  const integrations = await getActiveIntegrations(
    event.projectId,
    event.taskId,
  );

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskTitleChanged) continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskTitleChanged(event, context);
    } catch (error) {
      console.error(
        `Plugin ${plugin.type} error on task.title_changed:`,
        error,
      );
    }
  }
}

export async function broadcastTaskDescriptionChanged(
  event: TaskDescriptionChangedEvent,
): Promise<void> {
  const integrations = await getActiveIntegrations(
    event.projectId,
    event.taskId,
  );

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskDescriptionChanged) continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskDescriptionChanged(event, context);
    } catch (error) {
      console.error(
        `Plugin ${plugin.type} error on task.description_changed:`,
        error,
      );
    }
  }
}

export async function broadcastTaskCommentCreated(
  event: TaskCommentCreatedEvent,
): Promise<void> {
  const integrations = await getActiveIntegrations(
    event.projectId,
    event.taskId,
  );

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskCommentCreated) continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskCommentCreated(event, context);
    } catch (error) {
      console.error(`Plugin ${plugin.type} error on comment.created:`, error);
    }
  }
}

export async function broadcastTaskDeleted(
  event: TaskDeletedEvent,
): Promise<void> {
  const integrations = await getActiveIntegrations(
    event.projectId,
    event.taskId,
  );

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskDeleted) continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskDeleted(event, context);
    } catch (error) {
      console.error(`Plugin ${plugin.type} error on task.deleted:`, error);
    }
  }
}

export async function broadcastTaskMoved(event: TaskMovedEvent): Promise<void> {
  const integrations = await getActiveIntegrations(
    event.projectId,
    event.taskId,
  );

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskMoved) continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskMoved(event, context);
    } catch (error) {
      console.error(`Plugin ${plugin.type} error on task.moved:`, error);
    }
  }
}

export async function broadcastTaskDueDateChanged(
  event: TaskDueDateChangedEvent,
): Promise<void> {
  const integrations = await getActiveIntegrations(
    event.projectId,
    event.taskId,
  );

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskDueDateChanged) continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskDueDateChanged(event, context);
    } catch (error) {
      console.error(
        `Plugin ${plugin.type} error on task.due_date_changed:`,
        error,
      );
    }
  }
}

export async function broadcastTaskAssigneeChanged(
  event: TaskAssigneeChangedEvent,
): Promise<void> {
  const integrations = await getActiveIntegrations(
    event.projectId,
    event.taskId,
  );

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskAssigneeChanged) continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskAssigneeChanged(event, context);
    } catch (error) {
      console.error(
        `Plugin ${plugin.type} error on task.assignee_changed:`,
        error,
      );
    }
  }
}

export async function broadcastTaskUnassigned(
  event: TaskUnassignedEvent,
): Promise<void> {
  const integrations = await getActiveIntegrations(
    event.projectId,
    event.taskId,
  );

  for (const integration of integrations) {
    const plugin = getPlugin(integration.type);
    if (!plugin?.onTaskUnassigned) continue;

    const context = await createContext(integration);

    try {
      await plugin.onTaskUnassigned(event, context);
    } catch (error) {
      console.error(`Plugin ${plugin.type} error on task.unassigned:`, error);
    }
  }
}
