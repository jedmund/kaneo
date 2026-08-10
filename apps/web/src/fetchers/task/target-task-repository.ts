import { client } from "@kaneo/libs";

export async function targetTaskRepository({
  taskId,
  integrationRepositoryId,
}: {
  taskId: string;
  integrationRepositoryId: string;
}) {
  const response = await client.task[":id"]["scm-target"].$post({
    param: { id: taskId },
    json: { integrationRepositoryId },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}
