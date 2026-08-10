import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiteaRepositoryBrowserModal } from "./gitea-repository-browser-modal";

const browserMocks = vi.hoisted(() => ({
  listRepositories: vi.fn(),
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

vi.mock("@/fetchers/gitea-integration/list-gitea-repositories", () => ({
  default: browserMocks.listRepositories,
}));

function renderBrowser() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GiteaRepositoryBrowserModal
        accessToken=""
        baseUrl="https://gitea.example.com"
        excludedRepositories={["kizuna/kizuna-web"]}
        hasStoredCredential
        onOpenChange={vi.fn()}
        onSelectRepository={vi.fn()}
        open
        projectId="kaneo-project-1"
      />
    </QueryClientProvider>,
  );
}

describe("GiteaRepositoryBrowserModal", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    browserMocks.listRepositories.mockResolvedValue({
      repositories: [
        {
          full_name: "kizuna/kizuna-web",
          html_url: "https://gitea.example.com/kizuna/kizuna-web",
          id: 1,
          name: "kizuna-web",
          owner: { login: "kizuna" },
          private: true,
        },
        {
          full_name: "kizuna/kizuna-api",
          html_url: "https://gitea.example.com/kizuna/kizuna-api",
          id: 2,
          name: "kizuna-api",
          owner: { login: "kizuna" },
          private: true,
        },
      ],
    });
  });

  it("uses stored credentials and hides repositories already attached", async () => {
    renderBrowser();

    await waitFor(() =>
      expect(browserMocks.listRepositories).toHaveBeenCalledWith({
        baseUrl: "https://gitea.example.com",
        projectId: "kaneo-project-1",
      }),
    );
    expect(
      await screen.findByRole("button", { name: /kizuna\/kizuna-api/ }),
    ).toBeVisible();
    expect(screen.queryByText("kizuna/kizuna-web")).not.toBeInTheDocument();
  });
});
