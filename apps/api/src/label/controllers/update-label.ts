import { and, eq, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable } from "../../database/schema";
import {
  removeLabelFromGitea,
  syncLabelToGitea,
} from "../../plugins/gitea/utils/sync-label-to-gitea";
import {
  removeLabelFromGitHub,
  syncLabelToGitHub,
} from "../../plugins/github/utils/sync-label-to-github";
import {
  removeLabelFromGitLab,
  syncLabelToGitLab,
} from "../../plugins/gitlab/utils/sync-label-to-gitlab";

async function updateLabel(id: string, name: string, color: string) {
  const result = await db.transaction(async (tx) => {
    const label = await tx.query.labelTable.findFirst({
      where: (label, { eq }) => eq(label.id, id),
    });

    if (!label) {
      throw new HTTPException(404, {
        message: "Label not found",
      });
    }

    const [updatedLabel] = await tx
      .update(labelTable)
      .set({ name, color })
      .where(eq(labelTable.id, id))
      .returning();

    // If this is a workspace-level label, cascade the changes to all
    // task-level copies so existing label assignments reflect the new color/name
    if (!label.taskId && label.workspaceId) {
      const affectedLabels = await tx
        .select({ taskId: labelTable.taskId })
        .from(labelTable)
        .where(
          and(
            eq(labelTable.workspaceId, label.workspaceId),
            eq(labelTable.name, label.name),
            isNotNull(labelTable.taskId),
          ),
        );
      await tx
        .update(labelTable)
        .set({ name, color })
        .where(
          and(
            eq(labelTable.workspaceId, label.workspaceId),
            eq(labelTable.name, label.name),
            isNotNull(labelTable.taskId),
          ),
        );

      return {
        updatedLabel,
        previousName: label.name,
        taskIds: affectedLabels.flatMap(({ taskId }) =>
          taskId ? [taskId] : [],
        ),
      };
    }

    return {
      updatedLabel,
      previousName: label.name,
      taskIds: label.taskId ? [label.taskId] : [],
    };
  });

  for (const taskId of result.taskIds) {
    if (result.previousName !== name) {
      removeLabelFromGitHub(taskId, result.previousName).catch((error) => {
        console.error("Failed to remove renamed label from GitHub:", error);
      });
      removeLabelFromGitea(taskId, result.previousName).catch((error) => {
        console.error("Failed to remove renamed label from Gitea:", error);
      });
      removeLabelFromGitLab(taskId, result.previousName).catch((error) => {
        console.error("Failed to remove renamed label from GitLab:", error);
      });
    }
    syncLabelToGitHub(taskId, name, color).catch((error) => {
      console.error("Failed to update label in GitHub:", error);
    });
    syncLabelToGitea(taskId, name, color).catch((error) => {
      console.error("Failed to update label in Gitea:", error);
    });
    syncLabelToGitLab(taskId, name, color).catch((error) => {
      console.error("Failed to update label in GitLab:", error);
    });
  }

  return result.updatedLabel;
}

export default updateLabel;
