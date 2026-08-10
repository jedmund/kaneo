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
import { GiteaIntegrationSettings } from "./gitea-integration-settings";

const giteaMocks = vi.hoisted(() => ({
  createIntegration: vi.fn(),
  detachRepository: vi.fn(),
  importIssues: vi.fn(),
  integrationQuery: vi.fn(),
  updateSettings: vi.fn(),
  verifyAccess: vi.fn(),
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

vi.mock("@/components/project/gitea-repository-browser-modal", () => ({
  GiteaRepositoryBrowserModal: ({
    accessToken,
    excludedRepositories,
    hasStoredCredential,
    onSelectRepository,
    open,
  }: {
    accessToken?: string;
    excludedRepositories: string[];
    hasStoredCredential: boolean;
    onSelectRepository: (repository: { owner: string; name: string }) => void;
    open: boolean;
  }) =>
    open ? (
      <div
        data-access-token={accessToken}
        data-has-stored-credential={String(hasStoredCredential)}
        data-testid="gitea-repository-browser"
      >
        <span>{excludedRepositories.join(",")}</span>
        <button
          onClick={() =>
            onSelectRepository({ owner: "kizuna", name: "kizuna-api" })
          }
          type="button"
        >
          Choose kizuna-api
        </button>
      </div>
    ) : null,
}));

vi.mock(
  "@/hooks/mutations/gitea-integration/use-create-gitea-integration",
  () => ({
    useCreateGiteaIntegration: () => ({
      isPending: false,
      mutateAsync: giteaMocks.createIntegration,
    }),
    useDetachGiteaRepository: () => ({
      isPending: false,
      mutateAsync: giteaMocks.detachRepository,
    }),
    useVerifyGiteaAccess: () => ({
      isPending: false,
      mutateAsync: giteaMocks.verifyAccess,
    }),
  }),
);

vi.mock("@/hooks/mutations/gitea-integration/use-import-gitea-issues", () => ({
  default: () => ({
    isPending: false,
    mutateAsync: giteaMocks.importIssues,
  }),
}));

vi.mock(
  "@/hooks/mutations/gitea-integration/use-update-gitea-integration",
  () => ({
    useUpdateGiteaIntegration: () => ({
      isPending: false,
      mutateAsync: giteaMocks.updateSettings,
    }),
  }),
);

vi.mock("@/hooks/queries/gitea-integration/use-get-gitea-integration", () => ({
  default: () => giteaMocks.integrationQuery(),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

function connectedIntegrationQuery() {
  return {
    data: {
      baseUrl: "https://gitea.example.com",
      commentTaskLinkOnGiteaIssue: true,
      isActive: true,
      maskedAccessToken: "gitea_••••cdef",
      repositories: [
        {
          fullPath: "kizuna/kizuna-web",
          id: "repository-1",
          webUrl: "https://gitea.example.com/kizuna/kizuna-web",
          webhookSecret: "whsec_secret",
          webhookUrl: "https://kaneo.example.com/webhooks/gitea/repository-1",
        },
      ],
      repositoryName: "kizuna-web",
      repositoryOwner: "kizuna",
    },
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  };
}

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GiteaIntegrationSettings projectId="kaneo-project-1" />
    </QueryClientProvider>,
  );
}

describe("GiteaIntegrationSettings", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    giteaMocks.integrationQuery.mockReturnValue(connectedIntegrationQuery());
    giteaMocks.createIntegration.mockResolvedValue(undefined);
    giteaMocks.verifyAccess.mockResolvedValue({
      hasRequiredPermissions: true,
      isInstalled: true,
      message: "Token can access the repository.",
      missingPermissions: [],
      repositoryExists: true,
      repositoryPrivate: true,
    });
  });

  it("reuses the stored token when attaching another repository", async () => {
    renderSettings();

    expect(
      screen.queryByLabelText("settings:giteaIntegration.baseUrlLabel"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "settings:giteaIntegration.disconnect",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:giteaIntegration.addRepository",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByLabelText("settings:giteaIntegration.baseUrlLabel"),
    ).toHaveValue("https://gitea.example.com");
    expect(
      within(dialog).getByLabelText("settings:giteaIntegration.tokenLabel"),
    ).toHaveValue("");
    expect(
      within(dialog).getByLabelText("settings:giteaIntegration.repoNameLabel"),
    ).toHaveValue("");

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "settings:giteaIntegration.browseRepositories",
      }),
    );
    const browser = screen.getByTestId("gitea-repository-browser");
    expect(browser).toHaveAttribute("data-access-token", "");
    expect(browser).toHaveAttribute("data-has-stored-credential", "true");
    expect(browser).toHaveTextContent("kizuna/kizuna-web");
    fireEvent.click(screen.getByText("Choose kizuna-api"));

    const addRepositoryButton = within(dialog).getByRole("button", {
      name: "settings:giteaIntegration.addRepository",
    });
    await waitFor(() => expect(addRepositoryButton).toBeEnabled());
    fireEvent.click(addRepositoryButton);

    await waitFor(() =>
      expect(giteaMocks.createIntegration).toHaveBeenCalledWith({
        data: {
          baseUrl: "https://gitea.example.com",
          repositoryName: "kizuna-api",
          repositoryOwner: "kizuna",
        },
        projectId: "kaneo-project-1",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("requires a token for the first Gitea repository", async () => {
    giteaMocks.integrationQuery.mockReturnValue({
      data: null,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    renderSettings();

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:giteaIntegration.addRepository",
      }),
    );
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(
      within(dialog).getByLabelText("settings:giteaIntegration.baseUrlLabel"),
      { target: { value: "https://gitea.example.com" } },
    );
    fireEvent.change(
      within(dialog).getByLabelText("settings:giteaIntegration.ownerLabel"),
      { target: { value: "kizuna" } },
    );
    fireEvent.change(
      within(dialog).getByLabelText("settings:giteaIntegration.repoNameLabel"),
      { target: { value: "kizuna-api" } },
    );

    const addRepositoryButton = within(dialog).getByRole("button", {
      name: "settings:giteaIntegration.addRepository",
    });
    expect(addRepositoryButton).toBeDisabled();

    fireEvent.change(
      within(dialog).getByLabelText("settings:giteaIntegration.tokenLabel"),
      { target: { value: "gitea-token" } },
    );
    await waitFor(() => expect(addRepositoryButton).toBeEnabled());
  });
});
