import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const github = vi.hoisted(() => ({
  getInstallationOctokit: vi.fn(),
  getRepoInstallation: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock("../../apps/api/src/plugins/github/utils/github-app", () => ({
  getGithubApp: () => ({
    getInstallationOctokit: github.getInstallationOctokit,
    octokit: {
      rest: { apps: { getRepoInstallation: github.getRepoInstallation } },
    },
  }),
}));

import { handleIssueOpened } from "../../apps/api/src/plugins/github/webhooks/issue-opened";

describe("API integration: GitHub webhook repository installations", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    github.getInstallationOctokit.mockReset();
    github.getRepoInstallation.mockReset();
    github.createComment.mockReset();
    github.getInstallationOctokit.mockResolvedValue({
      rest: { issues: { createComment: github.createComment } },
    });
    github.createComment.mockResolvedValue({});
  });

  it("decorates an additional repository with its own installation", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "github",
        config: JSON.stringify({
          repositoryOwner: "first-owner",
          repositoryName: "first-repository",
          installationId: 111,
          commentTaskLinkOnGitHubIssue: true,
        }),
      })
      .returning();
    await db.insert(schema.integrationRepositoryTable).values({
      integrationId: integration.id,
      provider: "github",
      remoteOrigin: "https://github.com",
      providerRepositoryId: "2222",
      fullPath: "second-owner/second-repository",
      webUrl: "https://github.com/second-owner/second-repository",
      metadata: { installationId: 222 },
    });

    await handleIssueOpened({
      action: "opened",
      issue: {
        number: 17,
        title: "Issue in the second repository",
        body: "Description",
        html_url: "https://github.com/second-owner/second-repository/issues/17",
        labels: [],
        user: { login: "developer" },
      },
      repository: {
        owner: { login: "second-owner" },
        name: "second-repository",
        full_name: "second-owner/second-repository",
      },
    });

    expect(github.getInstallationOctokit).toHaveBeenCalledWith(222);
    expect(github.getInstallationOctokit).not.toHaveBeenCalledWith(111);
    expect(github.getRepoInstallation).not.toHaveBeenCalled();
    expect(github.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "second-owner",
        repo: "second-repository",
        issue_number: 17,
      }),
    );
  });
});
