import { useMutation, useQueryClient } from "@tanstack/react-query";
import { targetTaskRepository } from "@/fetchers/task/target-task-repository";

export function useTargetTaskRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: targetTaskRepository,
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["external-links", variables.taskId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["task", variables.taskId],
      });
    },
  });
}
