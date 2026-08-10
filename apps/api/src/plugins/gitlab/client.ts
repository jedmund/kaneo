import { assertPublicDestination } from "../../utils/assert-public-destination";

const GITLAB_FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGES = 1_000;

export type GitLabAuth =
  | { type: "token"; accessToken: string }
  | { type: "oauth"; accessToken: string };

export type GitLabProject = {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch: string | null;
  visibility: "private" | "internal" | "public";
  archived: boolean;
  issues_enabled: boolean;
  merge_requests_enabled: boolean;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
};

export type GitLabLabel = {
  id: number;
  name: string;
  color: string;
  description?: string | null;
};

export type GitLabIssue = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  web_url: string;
  labels: string[];
  author?: { id: number; username: string; name: string; avatar_url?: string };
};

export type GitLabNote = {
  id: number;
  body: string;
  system: boolean;
  created_at: string;
  author?: { id: number; username: string; name: string; avatar_url?: string };
};

export type GitLabMergeRequest = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: "opened" | "closed" | "merged" | "locked";
  draft: boolean;
  web_url: string;
  source_branch: string;
  target_branch: string;
  merged_at?: string | null;
  closed_at?: string | null;
  author?: { id: number; username: string; name: string; avatar_url?: string };
};

export type GitLabProjectHook = {
  id: number;
  project_id: number;
  url: string;
  push_events: boolean;
  issues_events: boolean;
  merge_requests_events: boolean;
  note_events: boolean;
  enable_ssl_verification: boolean;
  signing_token_present?: boolean;
};

export class GitLabApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

export function normalizeGitLabUrl(value: string): string {
  const parsed = new URL(value.trim().replace(/\/+$/, ""));
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("GitLab URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "GitLab URL must not contain credentials, a query, or a fragment",
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function gitLabInstanceUrl(baseUrl: string, path: string): string {
  return `${normalizeGitLabUrl(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

function configuredGitLabOrigins() {
  const configuredPublic = process.env.GITLAB_PUBLIC_URL?.trim();
  const configuredInternal = process.env.GITLAB_INTERNAL_URL?.trim();
  return {
    publicUrl: configuredPublic
      ? normalizeGitLabUrl(configuredPublic)
      : undefined,
    internalUrl: configuredInternal
      ? normalizeGitLabUrl(configuredInternal)
      : undefined,
  };
}

/** Resolve a public instance URL to the optional server-owned network route. */
export function resolveGitLabInternalUrl(publicUrl: string): string {
  const normalized = normalizeGitLabUrl(publicUrl);
  const configured = configuredGitLabOrigins();
  if (
    configured.publicUrl === normalized &&
    configured.internalUrl !== undefined
  ) {
    return configured.internalUrl;
  }
  return normalized;
}

async function assertAllowedNetworkRoute(
  publicUrl: string,
  internalUrl: string,
): Promise<void> {
  if (publicUrl === internalUrl) {
    await assertPublicDestination(publicUrl, "GitLab");
    return;
  }

  const configured = configuredGitLabOrigins();
  if (
    configured.publicUrl !== publicUrl ||
    configured.internalUrl !== internalUrl
  ) {
    throw new Error(
      "GitLab internal URL must match the server-configured public/internal origin pair",
    );
  }
}

async function fetchGitLabOrigin(
  publicUrlValue: string,
  internalUrlValue: string | undefined,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; text: string }> {
  const publicUrl = normalizeGitLabUrl(publicUrlValue);
  const internalUrl = normalizeGitLabUrl(
    internalUrlValue ?? resolveGitLabInternalUrl(publicUrl),
  );
  await assertAllowedNetworkRoute(publicUrl, internalUrl);

  const requestPath = path.startsWith("/") ? path : `/${path}`;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, GITLAB_FETCH_TIMEOUT_MS);

  if (init?.signal) {
    if (init.signal.aborted) controller.abort();
    else {
      init.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  try {
    const response = await fetch(gitLabInstanceUrl(internalUrl, requestPath), {
      ...init,
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      throw new GitLabApiError(
        "GitLab request was redirected",
        response.status,
      );
    }
    // Keep the abort timer alive until the response stream is fully consumed.
    // fetch() resolves as soon as headers arrive, while response.text() can
    // still stall indefinitely on a slow or malicious peer.
    const text = await response.text();
    return { response, text };
  } catch (error) {
    if (error instanceof GitLabApiError) throw error;
    if (error instanceof Error && error.name === "AbortError" && timedOut) {
      throw new GitLabApiError(
        `GitLab request timed out after ${GITLAB_FETCH_TIMEOUT_MS}ms`,
        408,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Call a server-owned GitLab OAuth endpoint without exposing its internal URL. */
export async function gitlabOAuthFetch<T>(
  options: { publicUrl: string; internalUrl?: string },
  path: "/oauth/token" | "/oauth/revoke",
  form: URLSearchParams,
): Promise<T | undefined> {
  const { response, text: responseText } = await fetchGitLabOrigin(
    options.publicUrl,
    options.internalUrl,
    path,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
  );

  if (!response.ok) {
    throw new GitLabApiError(
      `GitLab OAuth request failed (${response.status})`,
      response.status,
    );
  }
  if (!responseText) return undefined;
  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new GitLabApiError(
      "GitLab OAuth endpoint returned invalid JSON",
      response.status,
    );
  }
}

function authHeaders(auth: GitLabAuth): HeadersInit {
  return auth.type === "oauth"
    ? { Authorization: `Bearer ${auth.accessToken}` }
    : { "PRIVATE-TOKEN": auth.accessToken };
}

export type GitLabRequestOptions = {
  publicUrl: string;
  internalUrl?: string;
  auth: GitLabAuth;
};

type GitLabResponse<T> = { data: T | undefined; headers: Headers };

export async function gitlabFetch<T>(
  options: GitLabRequestOptions,
  path: string,
  init?: RequestInit,
): Promise<GitLabResponse<T>> {
  const publicUrl = normalizeGitLabUrl(options.publicUrl);
  const internalUrl = normalizeGitLabUrl(
    options.internalUrl ?? resolveGitLabInternalUrl(publicUrl),
  );
  const apiPath = path.startsWith("/") ? path : `/${path}`;
  const { response, text } = await fetchGitLabOrigin(
    publicUrl,
    internalUrl,
    `/api/v4${apiPath}`,
    {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...authHeaders(options.auth),
        ...init?.headers,
      },
    },
  );

  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as {
        message?: unknown;
        error?: unknown;
      };
      detail = String(parsed.message ?? parsed.error ?? text);
    } catch {
      // Keep the original response text.
    }
    throw new GitLabApiError(
      `GitLab API error ${response.status}: ${detail}`,
      response.status,
      text,
    );
  }

  if (response.status === 204 || text === "") {
    return { data: undefined, headers: response.headers };
  }

  try {
    return { data: JSON.parse(text) as T, headers: response.headers };
  } catch {
    throw new GitLabApiError(
      "GitLab API returned invalid JSON",
      response.status,
      text,
    );
  }
}

function queryPath(
  path: string,
  params: Record<string, string | number | boolean>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  return `${path}?${query.toString()}`;
}

export function createGitLabClient(options: GitLabRequestOptions) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await gitlabFetch<T>(options, path, init);
    if (response.data === undefined) {
      throw new GitLabApiError("GitLab response was empty", 500);
    }
    return response.data;
  }

  async function requestAll<T>(
    path: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<T[]> {
    const values: T[] = [];
    let page = 1;
    const perPage = 100;

    while (page <= MAX_PAGES) {
      const response = await gitlabFetch<T[]>(
        options,
        queryPath(path, { ...params, page, per_page: perPage }),
      );
      const batch = response.data ?? [];
      values.push(...batch);

      const nextPage = response.headers.get("x-next-page")?.trim();
      if (nextPage) {
        const parsed = Number.parseInt(nextPage, 10);
        if (!Number.isFinite(parsed) || parsed <= page) {
          throw new GitLabApiError(
            "GitLab returned invalid pagination headers",
            500,
          );
        }
        page = parsed;
      } else if (batch.length === perPage) {
        page += 1;
      } else {
        return values;
      }
    }

    throw new GitLabApiError(
      "GitLab pagination exceeded the safety limit",
      500,
    );
  }

  const projectPath = (projectId: string | number) =>
    `/projects/${encodeURIComponent(String(projectId))}`;

  return {
    async getCurrentUser() {
      return request<{ id: number; username: string; name: string }>("/user");
    },

    async listMaintainedProjects() {
      return requestAll<GitLabProject>("/projects", {
        membership: true,
        min_access_level: 40,
        active: true,
        with_issues_enabled: true,
        order_by: "path",
        sort: "asc",
      });
    },

    async getProject(projectId: string | number) {
      return request<GitLabProject>(projectPath(projectId));
    },

    async listIssues(projectId: string | number, state = "opened") {
      return requestAll<GitLabIssue>(`${projectPath(projectId)}/issues`, {
        state,
        // GitLab does not accept `iid` as an Issues API order field. Use a
        // stable field supported by both the Issues and Merge Requests APIs.
        order_by: "created_at",
        sort: "asc",
      });
    },

    async getIssue(projectId: string | number, issueIid: number) {
      return request<GitLabIssue>(
        `${projectPath(projectId)}/issues/${issueIid}`,
      );
    },

    async createIssue(
      projectId: string | number,
      input: { title: string; description?: string | null; labels?: string[] },
    ) {
      return request<GitLabIssue>(`${projectPath(projectId)}/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          description: input.description ?? "",
          ...(input.labels ? { labels: input.labels.join(",") } : {}),
        }),
      });
    },

    async updateIssue(
      projectId: string | number,
      issueIid: number,
      input: {
        title?: string;
        description?: string | null;
        state_event?: "close" | "reopen";
        labels?: string[];
      },
    ) {
      return request<GitLabIssue>(
        `${projectPath(projectId)}/issues/${issueIid}`,
        {
          method: "PUT",
          body: JSON.stringify({
            ...input,
            ...(input.labels ? { labels: input.labels.join(",") } : {}),
          }),
        },
      );
    },

    async listIssueNotes(projectId: string | number, issueIid: number) {
      return requestAll<GitLabNote>(
        `${projectPath(projectId)}/issues/${issueIid}/notes`,
        { order_by: "created_at", sort: "asc" },
      );
    },

    async createIssueNote(
      projectId: string | number,
      issueIid: number,
      body: string,
    ) {
      return request<GitLabNote>(
        `${projectPath(projectId)}/issues/${issueIid}/notes`,
        { method: "POST", body: JSON.stringify({ body }) },
      );
    },

    async listLabels(projectId: string | number) {
      return requestAll<GitLabLabel>(`${projectPath(projectId)}/labels`, {
        include_ancestor_groups: true,
      });
    },

    async createLabel(
      projectId: string | number,
      input: { name: string; color: string; description?: string },
    ) {
      return request<GitLabLabel>(`${projectPath(projectId)}/labels`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    async updateLabel(
      projectId: string | number,
      currentName: string,
      input: { new_name?: string; color?: string; description?: string },
    ) {
      return request<GitLabLabel>(`${projectPath(projectId)}/labels`, {
        method: "PUT",
        body: JSON.stringify({ name: currentName, ...input }),
      });
    },

    async listMergeRequests(projectId: string | number, state = "opened") {
      return requestAll<GitLabMergeRequest>(
        `${projectPath(projectId)}/merge_requests`,
        { state, order_by: "created_at", sort: "asc" },
      );
    },

    async listProjectHooks(projectId: string | number) {
      return requestAll<GitLabProjectHook>(`${projectPath(projectId)}/hooks`);
    },

    async createProjectHook(
      projectId: string | number,
      input: {
        url: string;
        signingToken: string;
        enableSslVerification?: boolean;
      },
    ) {
      return request<GitLabProjectHook>(`${projectPath(projectId)}/hooks`, {
        method: "POST",
        body: JSON.stringify({
          url: input.url,
          name: "Kaneo",
          description: "Kaneo issue and merge request synchronization",
          signing_token: input.signingToken,
          push_events: true,
          issues_events: true,
          merge_requests_events: true,
          note_events: true,
          enable_ssl_verification: input.enableSslVerification ?? true,
        }),
      });
    },

    async deleteProjectHook(
      projectId: string | number,
      hookId: string | number,
    ) {
      await gitlabFetch(options, `${projectPath(projectId)}/hooks/${hookId}`, {
        method: "DELETE",
      });
    },
  };
}
