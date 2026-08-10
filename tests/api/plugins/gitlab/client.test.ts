import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitLabClient,
  gitlabFetch,
  gitlabOAuthFetch,
  normalizeGitLabUrl,
  resolveGitLabInternalUrl,
} from "../../../../apps/api/src/plugins/gitlab/client";

const savedEnvironment = {
  GITLAB_PUBLIC_URL: process.env.GITLAB_PUBLIC_URL,
  GITLAB_INTERNAL_URL: process.env.GITLAB_INTERNAL_URL,
  KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS:
    process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GitLab URL routing", () => {
  it("normalizes origins and rejects URL path injection", () => {
    expect(normalizeGitLabUrl("https://gitlab.example/subpath/")).toBe(
      "https://gitlab.example/subpath",
    );
    expect(() => normalizeGitLabUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => normalizeGitLabUrl("https://user:pass@example.test")).toThrow(
      /credentials/,
    );
    expect(() => normalizeGitLabUrl("https://example.test?next=/api")).toThrow(
      /query/,
    );
  });

  it("uses the internal origin only for the configured public instance", () => {
    process.env.GITLAB_PUBLIC_URL = "https://git.atelier.house";
    process.env.GITLAB_INTERNAL_URL = "http://gitlab";

    expect(resolveGitLabInternalUrl("https://git.atelier.house/")).toBe(
      "http://gitlab",
    );
    expect(resolveGitLabInternalUrl("https://other.example")).toBe(
      "https://other.example",
    );
  });

  it("rejects caller-controlled private and mismatched internal routes", async () => {
    await expect(
      gitlabFetch(
        {
          publicUrl: "http://127.0.0.1",
          auth: { type: "token", accessToken: "token" },
        },
        "/user",
      ),
    ).rejects.toThrow(/non-routable/);

    process.env.GITLAB_PUBLIC_URL = "https://git.atelier.house";
    process.env.GITLAB_INTERNAL_URL = "http://gitlab";
    await expect(
      gitlabFetch(
        {
          publicUrl: "https://other.example",
          internalUrl: "http://gitlab",
          auth: { type: "token", accessToken: "token" },
        },
        "/user",
      ),
    ).rejects.toThrow(/server-configured/);
  });

  it("calls the configured internal API with token authentication", async () => {
    process.env.GITLAB_PUBLIC_URL = "https://git.atelier.house";
    process.env.GITLAB_INTERNAL_URL = "http://gitlab";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 1, username: "bot", name: "Bot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createGitLabClient({
      publicUrl: "https://git.atelier.house",
      internalUrl: "http://gitlab",
      auth: { type: "token", accessToken: "glpat-secret" },
    });
    await expect(client.getCurrentUser()).resolves.toEqual({
      id: 1,
      username: "bot",
      name: "Bot",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://gitlab/api/v4/user",
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({ "PRIVATE-TOKEN": "glpat-secret" }),
      }),
    );
  });

  it("posts OAuth exchanges through the configured internal origin", async () => {
    process.env.GITLAB_PUBLIC_URL = "https://git.atelier.house";
    process.env.GITLAB_INTERNAL_URL = "http://gitlab";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 7200,
        }),
        { status: 200 },
      ),
    );
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_secret: "secret",
    });

    await expect(
      gitlabOAuthFetch(
        {
          publicUrl: "https://git.atelier.house",
          internalUrl: "http://gitlab",
        },
        "/oauth/token",
        form,
      ),
    ).resolves.toMatchObject({ access_token: "access" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gitlab/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: form,
        redirect: "manual",
      }),
    );
  });

  it("does not expose OAuth response bodies in errors", async () => {
    process.env.GITLAB_PUBLIC_URL = "https://git.atelier.house";
    process.env.GITLAB_INTERNAL_URL = "http://gitlab";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('sensitive error containing token "oauth-secret"', {
        status: 401,
      }),
    );

    await expect(
      gitlabOAuthFetch(
        {
          publicUrl: "https://git.atelier.house",
          internalUrl: "http://gitlab",
        },
        "/oauth/token",
        new URLSearchParams(),
      ),
    ).rejects.not.toThrow(/oauth-secret/);
  });

  it("keeps the timeout active while consuming the response body", async () => {
    process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS = "true";
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = init?.signal;
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    });

    const request = gitlabFetch(
      {
        publicUrl: "https://gitlab.example",
        auth: { type: "token", accessToken: "token" },
      },
      "/user",
    );
    const rejection = expect(request).rejects.toMatchObject({
      name: "GitLabApiError",
      status: 408,
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
  });
});

describe("GitLab pagination", () => {
  it("follows x-next-page until all projects are loaded", async () => {
    process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS = "true";
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      path_with_namespace: `group/project-${index + 1}`,
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(firstPage), {
          status: 200,
          headers: { "x-next-page": "2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 101, path_with_namespace: "group/project-101" },
          ]),
          { status: 200, headers: { "x-next-page": "" } },
        ),
      );

    const client = createGitLabClient({
      publicUrl: "https://gitlab.example",
      auth: { type: "token", accessToken: "token" },
    });
    const projects = await client.listMaintainedProjects();

    expect(projects).toHaveLength(101);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("page=1&per_page=100");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("page=2&per_page=100");
  });
});
