import { useQuery } from "@tanstack/react-query";
import { listProjectRepositories } from "@/fetchers/scm/list-project-repositories";

export function useProjectRepositories(projectId: string) {
  return useQuery({
    queryKey: ["project-repositories", projectId],
    queryFn: () => listProjectRepositories(projectId),
    enabled: Boolean(projectId),
  });
}
