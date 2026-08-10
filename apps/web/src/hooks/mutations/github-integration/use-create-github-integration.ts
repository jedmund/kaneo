import { useMutation, useQueryClient } from "@tanstack/react-query";
import createGithubIntegration, {
  type CreateGithubIntegrationRequest,
} from "@/fetchers/github-integration/create-github-integration";
import deleteGithubIntegration from "@/fetchers/github-integration/delete-github-integration";
import detachGithubRepository from "@/fetchers/github-integration/detach-github-repository";
import verifyGithubInstallation, {
  type VerifyGithubInstallationRequest,
} from "@/fetchers/github-integration/verify-github-installation";

export function useCreateGithubIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      data,
    }: {
      projectId: string;
      data: CreateGithubIntegrationRequest;
    }) => createGithubIntegration(projectId, data),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({
        queryKey: ["github-integration", projectId],
      });
    },
  });
}

export function useDeleteGithubIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (projectId: string) => deleteGithubIntegration(projectId),
    onSuccess: (_, projectId) => {
      queryClient.invalidateQueries({
        queryKey: ["github-integration", projectId],
      });
    },
  });
}

export function useDetachGithubRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      repositoryId,
    }: {
      projectId: string;
      repositoryId: string;
    }) => detachGithubRepository(projectId, repositoryId),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({
        queryKey: ["github-integration", projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["project-repositories", projectId],
      });
    },
  });
}

export function useVerifyGithubInstallation() {
  return useMutation({
    mutationFn: (data: VerifyGithubInstallationRequest) =>
      verifyGithubInstallation(data),
  });
}
