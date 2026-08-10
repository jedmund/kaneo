import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubIntegrationSettings } from "./github-integration-settings";

const githubMocks = vi.hoisted(() => ({
  createIntegration: vi.fn(),
  detachRepository: vi.fn(),
  importIssues: vi.fn(),
  updateSettings: vi.fn(),
  verifyInstallation: vi.fn(),
}));

vi.mock("@kaneo/libs", () => ({
  resolveApiBaseUrl: () => "http://localhost:1337",
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock("@/components/project/repository-browser-modal", () => ({
  RepositoryBrowserModal: ({
    excludedRepositories,
    onSelectRepository,
    open,
  }: {
    excludedRepositories: string[];
    onSelectRepository: (repository: { owner: string; name: string }) => void;
    open: boolean;
  }) =>
    open ? (
      <div data-testid="repository-browser">
        <span>{excludedRepositories.join(",")}</span>
        <button
          onClick={() =>
            onSelectRepository({ owner: "jedmund", name: "hensei-api" })
          }
          type="button"
        >
          Choose hensei-api
        </button>
      </div>
    ) : null,
}));

vi.mock(
  "@/hooks/mutations/github-integration/use-create-github-integration",
  () => ({
    useCreateGithubIntegration: () => ({
      isPending: false,
      mutateAsync: githubMocks.createIntegration,
    }),
    useDetachGithubRepository: () => ({
      isPending: false,
      mutateAsync: githubMocks.detachRepository,
    }),
    useVerifyGithubInstallation: () => ({
      isPending: false,
      mutateAsync: githubMocks.verifyInstallation,
    }),
  }),
);

vi.mock(
  "@/hooks/mutations/github-integration/use-import-github-issues",
  () => ({
    default: () => ({
      isPending: false,
      mutateAsync: githubMocks.importIssues,
    }),
  }),
);

vi.mock(
  "@/hooks/mutations/github-integration/use-update-github-integration",
  () => ({
    useUpdateGithubIntegration: () => ({
      isPending: false,
      mutateAsync: githubMocks.updateSettings,
    }),
  }),
);

vi.mock(
  "@/hooks/queries/github-integration/use-get-github-integration",
  () => ({
    default: () => ({
      data: {
        commentTaskLinkOnGitHubIssue: true,
        isActive: true,
        repositories: [
          {
            fullPath: "jedmund/hensei-web",
            id: "repository-1",
            webUrl: "https://github.com/jedmund/hensei-web",
          },
        ],
        repositoryName: "hensei-web",
        repositoryOwner: "jedmund",
      },
      isLoading: false,
    }),
  }),
);

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GitHubIntegrationSettings projectId="kaneo-project-1" />
    </QueryClientProvider>,
  );
}

describe("GitHubIntegrationSettings", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    githubMocks.createIntegration.mockResolvedValue(undefined);
    githubMocks.verifyInstallation.mockResolvedValue({
      hasRequiredPermissions: true,
      isInstalled: true,
      message: "GitHub App is ready.",
      missingPermissions: [],
      repositoryExists: true,
    });
  });

  it("keeps repository fields in a dialog and attaches a selected repository", async () => {
    renderSettings();

    expect(
      screen.queryByLabelText("settings:githubIntegration.ownerLabel"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "settings:githubIntegration.disconnect",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:githubIntegration.addRepository",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByLabelText("settings:githubIntegration.ownerLabel"),
    ).toHaveValue("jedmund");
    expect(
      within(dialog).getByLabelText("settings:githubIntegration.repoNameLabel"),
    ).toHaveValue("");

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "settings:githubIntegration.browseRepositories",
      }),
    );
    expect(screen.getByTestId("repository-browser")).toHaveTextContent(
      "jedmund/hensei-web",
    );
    fireEvent.click(screen.getByText("Choose hensei-api"));

    const addRepositoryButton = within(dialog).getByRole("button", {
      name: "settings:githubIntegration.addRepository",
    });
    await waitFor(() => expect(addRepositoryButton).toBeEnabled());
    fireEvent.click(addRepositoryButton);

    await waitFor(() =>
      expect(githubMocks.createIntegration).toHaveBeenCalledWith({
        data: {
          repositoryName: "hensei-api",
          repositoryOwner: "jedmund",
        },
        projectId: "kaneo-project-1",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
