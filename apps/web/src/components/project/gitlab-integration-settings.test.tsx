import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabIntegrationSettings } from "./gitlab-integration-settings";

const gitLabMocks = vi.hoisted(() => ({
  attachRepository: vi.fn(),
  beginOAuthConnection: vi.fn(),
  createTokenConnection: vi.fn(),
  deleteConnection: vi.fn(),
  detachRepository: vi.fn(),
  importRepositoryIssues: vi.fn(),
  listConnectionProjects: vi.fn(),
  listConnections: vi.fn(),
  listRepositories: vi.fn(),
  rotateTokenConnection: vi.fn(),
}));

vi.mock("@kaneo/libs", () => ({
  resolveApiBaseUrl: () => "http://localhost:1337",
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/fetchers/gitlab-integration", () => ({
  attachGitLabRepository: gitLabMocks.attachRepository,
  beginGitLabOAuthConnection: gitLabMocks.beginOAuthConnection,
  createGitLabTokenConnection: gitLabMocks.createTokenConnection,
  deleteGitLabConnection: gitLabMocks.deleteConnection,
  detachGitLabRepository: gitLabMocks.detachRepository,
  importGitLabRepositoryIssues: gitLabMocks.importRepositoryIssues,
  listGitLabConnectionProjects: gitLabMocks.listConnectionProjects,
  listGitLabConnections: gitLabMocks.listConnections,
  listProjectGitLabRepositories: gitLabMocks.listRepositories,
  rotateGitLabTokenConnection: gitLabMocks.rotateTokenConnection,
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ workspace: { id: "workspace-1" } }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GitLabIntegrationSettings projectId="kaneo-project-1" />
    </QueryClientProvider>,
  );
}

describe("GitLabIntegrationSettings", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    gitLabMocks.listConnections.mockResolvedValue({
      oauth: { enabled: false, publicUrl: null },
      connections: [
        {
          id: "connection-id",
          workspaceId: "workspace-1",
          name: "Atelier GitLab",
          authType: "oauth",
          publicUrl: "https://git.atelier.house",
          status: "active",
          statusMessage: null,
          credentialHint: null,
          gitlabUsername: "justin",
          expiresAt: null,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
          attachedRepositoryCount: 0,
        },
      ],
    });
    gitLabMocks.listRepositories.mockResolvedValue({ repositories: [] });
    gitLabMocks.listConnectionProjects.mockResolvedValue({
      projects: [
        {
          id: 23,
          name: "kaneo",
          path_with_namespace: "jedmund/kaneo",
          web_url: "https://git.atelier.house/jedmund/kaneo",
          default_branch: "main",
          visibility: "private",
          archived: false,
          issues_enabled: true,
          merge_requests_enabled: true,
        },
      ],
    });
  });

  it("shows connection and project labels instead of their stored IDs", async () => {
    renderSettings();

    await waitFor(() =>
      expect(screen.getAllByRole("combobox")).toHaveLength(2),
    );
    const [connectionTrigger, projectTrigger] = screen.getAllByRole("combobox");

    await waitFor(() =>
      expect(connectionTrigger).toHaveTextContent("Atelier GitLab"),
    );
    expect(connectionTrigger).not.toHaveTextContent("connection-id");

    await waitFor(() =>
      expect(gitLabMocks.listConnectionProjects).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        connectionId: "connection-id",
      }),
    );
    fireEvent.click(projectTrigger);
    fireEvent.click(
      await screen.findByRole("option", { name: "jedmund/kaneo" }),
    );

    await waitFor(() =>
      expect(projectTrigger).toHaveTextContent("jedmund/kaneo"),
    );
    expect(projectTrigger).not.toHaveTextContent("23");
  });
});
