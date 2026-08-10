import { eq } from "drizzle-orm";
import db from "../../../database";
import { projectTable } from "../../../database/schema";
import type {
  PluginContext,
  ReconciledScmIssue,
  TaskCreatedEvent,
} from "../../types";
import type { GitHubConfig } from "../config";
import {
  createExternalLink,
  findExternalLinkByTaskAndType,
} from "../services/link-manager";
import {
  formatIssueBody,
  formatIssueTitle,
  getLabelsForIssue,
  hasScmSyncJobMarker,
} from "../utils/format";
import { getGithubApp, getInstallationIdForRepo } from "../utils/github-app";
import { addLabelsToIssue } from "../utils/labels";

async function requireGitHubClient(context: PluginContext) {
  const githubApp = getGithubApp();
  if (!githubApp) {
    throw new Error("GitHub app is not configured");
  }
  const config = context.config as GitHubConfig;
  let installationId = config.installationId;
  if (!installationId) {
    installationId = await getInstallationIdForRepo(
      config.repositoryOwner,
      config.repositoryName,
    );
  }
  const octokit = await githubApp.getInstallationOctokit(installationId);
  return { config, octokit };
}

export async function reconcileTaskCreated(
  event: TaskCreatedEvent,
  context: PluginContext,
): Promise<ReconciledScmIssue | null> {
  const syncJobId = event.scmSyncJobId;
  if (!syncJobId) {
    throw new Error("SCM sync job ID is required for GitHub reconciliation");
  }
  const { config, octokit } = await requireGitHubClient(context);
  const issuePages = octokit.paginate.iterator(
    octokit.rest.issues.listForRepo,
    {
      owner: config.repositoryOwner,
      repo: config.repositoryName,
      state: "all",
      per_page: 100,
    },
  );
  for await (const response of issuePages) {
    const issue = response.data.find(
      (candidate) =>
        !candidate.pull_request &&
        hasScmSyncJobMarker(candidate.body, syncJobId),
    );
    if (issue) {
      return {
        externalId: String(issue.number),
        url: issue.html_url,
        title: issue.title,
        metadata: { state: issue.state },
      };
    }
  }
  return null;
}

export async function handleTaskCreated(
  event: TaskCreatedEvent,
  context: PluginContext,
): Promise<void> {
  const { config, octokit } = await requireGitHubClient(context);
  const { repositoryOwner, repositoryName } = config;

  const existingLink = await findExternalLinkByTaskAndType(
    event.taskId,
    context.integrationId,
    "issue",
    context.integrationRepositoryId,
  );

  if (existingLink) {
    return;
  }

  const createdIssue = await octokit.rest.issues.create({
    owner: repositoryOwner,
    repo: repositoryName,
    title: formatIssueTitle(event.title),
    body: formatIssueBody(event.description, event.taskId, event.scmSyncJobId),
  });

  await createExternalLink({
    taskId: event.taskId,
    integrationId: context.integrationId,
    integrationRepositoryId: context.integrationRepositoryId,
    resourceType: "issue",
    externalId: createdIssue.data.number.toString(),
    url: createdIssue.data.html_url,
    title: createdIssue.data.title,
    metadata: {
      state: createdIssue.data.state,
      createdFrom: "kaneo",
    },
  });

  // The durable job's contract is to create and link exactly one issue.
  // Provider-side decoration stays best effort after the link is recorded so
  // a transient label/comment failure cannot duplicate the issue on retry.
  try {
    const labels = getLabelsForIssue(event.priority, event.status);
    await addLabelsToIssue(
      octokit,
      repositoryOwner,
      repositoryName,
      createdIssue.data.number,
      labels,
    );

    if (config.commentTaskLinkOnGitHubIssue !== false) {
      const project = await db.query.projectTable.findFirst({
        where: eq(projectTable.id, event.projectId),
      });

      if (project) {
        const clientUrl =
          process.env.KANEO_CLIENT_URL || "http://localhost:5173";
        const taskUrl = `${clientUrl}/dashboard/workspace/${project.workspaceId}/project/${event.projectId}/task/${event.taskId}`;
        const taskIdentifier = `${project.slug.toUpperCase()}-${event.number}`;

        await octokit.rest.issues.createComment({
          owner: repositoryOwner,
          repo: repositoryName,
          issue_number: createdIssue.data.number,
          body: `[${taskIdentifier}](${taskUrl})`,
        });
      }
    }
  } catch (error) {
    console.error("Failed to decorate newly created GitHub issue:", error);
  }
}
