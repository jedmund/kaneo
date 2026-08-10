import { client } from "@kaneo/libs";

export default async function detachGithubRepository(
  projectId: string,
  repositoryId: string,
) {
  const response = await client["github-integration"].project[
    ":projectId"
  ].repositories[":repositoryId"].$delete({
    param: { projectId, repositoryId },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}
