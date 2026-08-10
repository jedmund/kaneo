import { client } from "@kaneo/libs";

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let message = body || `Request failed (${response.status})`;
    try {
      const parsed = JSON.parse(body) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      // Plain-text errors are returned as-is.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function listGitLabConnections(workspaceId: string) {
  const response = await client["gitlab-integration"].workspace[
    ":workspaceId"
  ].connections.$get({ param: { workspaceId } });
  return responseJson<{
    connections: Array<{
      id: string;
      workspaceId: string;
      name: string;
      authType: string;
      publicUrl: string;
      status: string;
      statusMessage: string | null;
      credentialHint: string | null;
      gitlabUsername: string | null;
      expiresAt: string | null;
      createdAt: string;
      updatedAt: string;
      attachedRepositoryCount: number;
    }>;
  }>(response);
}

export type GitLabConnection = Awaited<
  ReturnType<typeof listGitLabConnections>
>["connections"][number];

export async function createGitLabTokenConnection(input: {
  workspaceId: string;
  name: string;
  publicUrl: string;
  accessToken: string;
}) {
  const response = await client["gitlab-integration"].workspace[
    ":workspaceId"
  ].connections.token.$post({
    param: { workspaceId: input.workspaceId },
    json: {
      name: input.name,
      publicUrl: input.publicUrl,
      accessToken: input.accessToken,
    },
  });
  return responseJson<GitLabConnection>(response);
}

export async function rotateGitLabTokenConnection(input: {
  workspaceId: string;
  connectionId: string;
  accessToken: string;
}) {
  const response = await client["gitlab-integration"].workspace[
    ":workspaceId"
  ].connections[":connectionId"].token.$put({
    param: {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
    },
    json: { accessToken: input.accessToken },
  });
  return responseJson<GitLabConnection>(response);
}

export async function deleteGitLabConnection(input: {
  workspaceId: string;
  connectionId: string;
}) {
  const response = await client["gitlab-integration"].workspace[
    ":workspaceId"
  ].connections[":connectionId"].$delete({ param: input });
  return responseJson<{ success: boolean }>(response);
}

export async function listGitLabConnectionProjects(input: {
  workspaceId: string;
  connectionId: string;
}) {
  const response = await client["gitlab-integration"].workspace[
    ":workspaceId"
  ].connections[":connectionId"].projects.$get({ param: input });
  return responseJson<{
    projects: Array<{
      id: number;
      name: string;
      path_with_namespace: string;
      web_url: string;
      default_branch: string | null;
      visibility: "private" | "internal" | "public";
      archived: boolean;
      issues_enabled: boolean;
      merge_requests_enabled: boolean;
    }>;
  }>(response);
}

export async function listProjectGitLabRepositories(projectId: string) {
  const response = await client["gitlab-integration"].project[
    ":projectId"
  ].repositories.$get({ param: { projectId } });
  return responseJson<{
    repositories: Array<{
      id: string;
      integrationId: string;
      connectionId: string;
      providerRepositoryId: string;
      fullPath: string;
      webUrl: string;
      defaultBranch: string | null;
      webhookConfigured: boolean;
      isActive: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
  }>(response);
}

export type GitLabRepository = Awaited<
  ReturnType<typeof listProjectGitLabRepositories>
>["repositories"][number];

export async function attachGitLabRepository(input: {
  projectId: string;
  connectionId: string;
  providerRepositoryId: number;
}) {
  const response = await client["gitlab-integration"].project[
    ":projectId"
  ].repositories.$post({
    param: { projectId: input.projectId },
    json: {
      connectionId: input.connectionId,
      providerRepositoryId: input.providerRepositoryId,
    },
  });
  return responseJson<GitLabRepository>(response);
}

export async function detachGitLabRepository(input: {
  projectId: string;
  repositoryId: string;
}) {
  const response = await client["gitlab-integration"].project[
    ":projectId"
  ].repositories[":repositoryId"].$delete({ param: input });
  return responseJson<{ success: boolean }>(response);
}

export async function importGitLabRepositoryIssues(input: {
  projectId: string;
  repositoryId: string;
}) {
  const response = await client["gitlab-integration"].project[
    ":projectId"
  ].repositories[":repositoryId"]["import-issues"].$post({ param: input });
  return responseJson<{
    imported: number;
    updated: number;
    skipped: number;
    mergeRequestsLinked: number;
    errors?: string[];
  }>(response);
}
