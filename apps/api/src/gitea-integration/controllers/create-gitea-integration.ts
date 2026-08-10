import { attachGiteaRepository } from "../repositories";
import getGiteaIntegration from "./get-gitea-integration";

async function createGiteaIntegration(input: {
  projectId: string;
  baseUrl: string;
  accessToken?: string;
  repositoryOwner: string;
  repositoryName: string;
  ownerUserId?: string;
}) {
  await attachGiteaRepository(input);
  return getGiteaIntegration(input.projectId, true);
}

export default createGiteaIntegration;
