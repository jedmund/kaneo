import { client } from "@kaneo/libs";

export async function listProjectRepositories(projectId: string) {
  const response = await client.scm.repositories.project[":projectId"].$get({
    param: { projectId },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

export type ProjectRepository = Awaited<
  ReturnType<typeof listProjectRepositories>
>[number];
