import { client } from "@kaneo/libs";

async function importGiteaIssues(input: {
  projectId: string;
  repositoryId: string;
}) {
  const response = await client["gitea-integration"]["import-issues"].$post({
    json: input,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}

export default importGiteaIssues;
