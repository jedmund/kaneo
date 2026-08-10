import type { IntegrationPlugin } from "../types";
import { validateGitHubConfig } from "./config";
import { handleTaskCommentCreated } from "./events/task-comment-created";
import { handleTaskCreated, reconcileTaskCreated } from "./events/task-created";
import { handleTaskDescriptionChanged } from "./events/task-description-changed";
import { handleTaskPriorityChanged } from "./events/task-priority-changed";
import { handleTaskStatusChanged } from "./events/task-status-changed";
import { handleTaskTitleChanged } from "./events/task-title-changed";
import { setupWebhookHandlers } from "./webhook-handler";

export const githubPlugin: IntegrationPlugin = {
  type: "github",
  name: "GitHub",
  kind: "scm",
  onTaskCreated: handleTaskCreated,
  reconcileTaskCreated,
  onTaskStatusChanged: handleTaskStatusChanged,
  onTaskPriorityChanged: handleTaskPriorityChanged,
  onTaskTitleChanged: handleTaskTitleChanged,
  onTaskDescriptionChanged: handleTaskDescriptionChanged,
  onTaskCommentCreated: handleTaskCommentCreated,
  validateConfig: validateGitHubConfig,
};

export function initializeGitHubPlugin() {
  setupWebhookHandlers();
}
