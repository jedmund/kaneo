import { client } from "@kaneo/libs";

export default async function detachGiteaRepository(
  projectId: string,
  repositoryId: string,
) {
  const response = await client["gitea-integration"].project[
    ":projectId"
  ].repositories[":repositoryId"].$delete({
    param: { projectId, repositoryId },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}
