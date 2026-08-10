import { attachGitHubRepository } from "../repositories";
import getGithubIntegration from "./get-github-integration";

async function createGithubIntegration({
  projectId,
  repositoryOwner,
  repositoryName,
}: {
  projectId: string;
  repositoryOwner: string;
  repositoryName: string;
}) {
  await attachGitHubRepository({
    projectId,
    repositoryOwner,
    repositoryName,
  });

  return getGithubIntegration(projectId);
}

export default createGithubIntegration;
