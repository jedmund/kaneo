import type { PluginContext } from "../types";
import { createGitLabClient } from "./client";

export function requireGitLabContext(context: PluginContext) {
  if (
    context.repository?.provider !== "gitlab" ||
    !context.integrationRepositoryId ||
    !context.connection
  ) {
    throw new Error("GitLab repository connection is not configured");
  }

  const projectId = Number.parseInt(
    context.repository.providerRepositoryId,
    10,
  );
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    throw new Error("GitLab repository has an invalid project ID");
  }

  const credential = context.connection.credential;
  return {
    projectId,
    repository: context.repository,
    client: createGitLabClient({
      publicUrl: context.connection.publicUrl,
      internalUrl: context.connection.internalUrl,
      auth: { type: credential.type, accessToken: credential.accessToken },
    }),
  };
}
