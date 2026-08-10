import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  GitBranch,
  Import,
  KeyRound,
  Link,
  Loader2,
  RefreshCw,
  Trash2,
  Unlink,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  attachGitLabRepository,
  createGitLabTokenConnection,
  deleteGitLabConnection,
  detachGitLabRepository,
  importGitLabRepositoryIssues,
  listGitLabConnectionProjects,
  listGitLabConnections,
  listProjectGitLabRepositories,
  rotateGitLabTokenConnection,
} from "@/fetchers/gitlab-integration";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { toast } from "@/lib/toast";

type PendingRemoval =
  | { type: "connection"; id: string; label: string }
  | { type: "repository"; id: string; label: string }
  | null;

export function GitLabIntegrationSettings({
  projectId,
}: {
  projectId: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { workspace } = useWorkspacePermission();
  const workspaceId = workspace?.id ?? "";
  const [name, setName] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [rotationTokens, setRotationTokens] = useState<Record<string, string>>(
    {},
  );
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval>(null);
  const [importingRepositoryId, setImportingRepositoryId] = useState<
    string | null
  >(null);

  const connectionsQuery = useQuery({
    queryKey: ["gitlab-connections", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => listGitLabConnections(workspaceId),
  });
  const repositoriesQuery = useQuery({
    queryKey: ["gitlab-repositories", projectId],
    queryFn: () => listProjectGitLabRepositories(projectId),
  });
  const projectsQuery = useQuery({
    queryKey: ["gitlab-connection-projects", workspaceId, selectedConnectionId],
    enabled: Boolean(workspaceId && selectedConnectionId),
    queryFn: () =>
      listGitLabConnectionProjects({
        workspaceId,
        connectionId: selectedConnectionId,
      }),
  });

  const connections = connectionsQuery.data?.connections ?? [];
  const repositories = repositoriesQuery.data?.repositories ?? [];
  const attachedProviderIds = useMemo(
    () =>
      new Set(
        repositories.map((repository) => repository.providerRepositoryId),
      ),
    [repositories],
  );
  const availableProjects = (projectsQuery.data?.projects ?? []).filter(
    (project) => !attachedProviderIds.has(String(project.id)),
  );

  useEffect(() => {
    if (
      selectedConnectionId &&
      connections.some((connection) => connection.id === selectedConnectionId)
    ) {
      return;
    }
    setSelectedConnectionId(connections[0]?.id ?? "");
    setSelectedProjectId("");
  }, [connections, selectedConnectionId]);

  const refreshConnections = () =>
    queryClient.invalidateQueries({ queryKey: ["gitlab-connections"] });
  const refreshRepositories = () =>
    queryClient.invalidateQueries({ queryKey: ["gitlab-repositories"] });

  const createConnection = useMutation({
    mutationFn: createGitLabTokenConnection,
    onSuccess: async () => {
      setName("");
      setAccessToken("");
      await refreshConnections();
      toast.success(t("settings:gitlabIntegration.toast.connectionCreated"));
    },
    onError: (error) => toast.error(error.message),
  });
  const rotateConnection = useMutation({
    mutationFn: rotateGitLabTokenConnection,
    onSuccess: async (_, input) => {
      setRotationTokens((current) => ({
        ...current,
        [input.connectionId]: "",
      }));
      await refreshConnections();
      toast.success(t("settings:gitlabIntegration.toast.tokenRotated"));
    },
    onError: (error) => toast.error(error.message),
  });
  const removeConnection = useMutation({
    mutationFn: deleteGitLabConnection,
    onSuccess: async () => {
      await refreshConnections();
      toast.success(t("settings:gitlabIntegration.toast.connectionRemoved"));
    },
    onError: (error) => toast.error(error.message),
  });
  const attachRepository = useMutation({
    mutationFn: attachGitLabRepository,
    onSuccess: async () => {
      setSelectedProjectId("");
      await Promise.all([refreshConnections(), refreshRepositories()]);
      toast.success(t("settings:gitlabIntegration.toast.repositoryAttached"));
    },
    onError: (error) => toast.error(error.message),
  });
  const detachRepository = useMutation({
    mutationFn: detachGitLabRepository,
    onSuccess: async () => {
      await Promise.all([refreshConnections(), refreshRepositories()]);
      toast.success(t("settings:gitlabIntegration.toast.repositoryDetached"));
    },
    onError: (error) => toast.error(error.message),
  });

  const handleCreateConnection = (event: React.FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !name.trim() || !publicUrl.trim() || !accessToken)
      return;
    createConnection.mutate({
      workspaceId,
      name: name.trim(),
      publicUrl: publicUrl.trim(),
      accessToken,
    });
  };

  const handleAttach = () => {
    const providerRepositoryId = Number.parseInt(selectedProjectId, 10);
    if (!selectedConnectionId || !Number.isSafeInteger(providerRepositoryId)) {
      return;
    }
    attachRepository.mutate({
      projectId,
      connectionId: selectedConnectionId,
      providerRepositoryId,
    });
  };

  const handleImport = async (repositoryId: string) => {
    setImportingRepositoryId(repositoryId);
    try {
      const result = await importGitLabRepositoryIssues({
        projectId,
        repositoryId,
      });
      toast.success(
        t("settings:gitlabIntegration.toast.imported", {
          imported: result.imported,
          updated: result.updated,
          mergeRequests: result.mergeRequestsLinked,
        }),
        result.errors?.length
          ? { description: result.errors.join("\n") }
          : undefined,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:gitlabIntegration.toast.importFailed"),
      );
    } finally {
      setImportingRepositoryId(null);
    }
  };

  const confirmRemoval = async () => {
    if (!pendingRemoval || !workspaceId) return;
    if (pendingRemoval.type === "connection") {
      await removeConnection.mutateAsync({
        workspaceId,
        connectionId: pendingRemoval.id,
      });
    } else {
      await detachRepository.mutateAsync({
        projectId,
        repositoryId: pendingRemoval.id,
      });
    }
    setPendingRemoval(null);
  };

  if (
    !workspaceId ||
    connectionsQuery.isLoading ||
    repositoriesQuery.isLoading
  ) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("settings:gitlabIntegration.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="font-medium text-sm">
            {t("settings:gitlabIntegration.connectionsTitle")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("settings:gitlabIntegration.connectionsHint")}
          </p>
        </div>

        {connections.length > 0 && (
          <div className="space-y-2">
            {connections.map((connection) => (
              <div
                className="rounded-lg border border-border p-3"
                key={connection.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">
                        {connection.name}
                      </span>
                      <Badge
                        variant={
                          connection.status === "active" ? "success" : "warning"
                        }
                      >
                        {connection.status}
                      </Badge>
                      <Badge variant="outline">{connection.authType}</Badge>
                    </div>
                    <a
                      className="mt-1 inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
                      href={connection.publicUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {connection.publicUrl}
                      <ExternalLink className="size-3" />
                    </a>
                    <p className="mt-1 text-muted-foreground text-xs">
                      {connection.gitlabUsername
                        ? `@${connection.gitlabUsername} · `
                        : ""}
                      {connection.credentialHint ?? ""} ·{" "}
                      {connection.attachedRepositoryCount}{" "}
                      {t("settings:gitlabIntegration.repositoriesCount")}
                    </p>
                  </div>
                  <Button
                    aria-label={t(
                      "settings:gitlabIntegration.removeConnection",
                    )}
                    disabled={connection.attachedRepositoryCount > 0}
                    onClick={() =>
                      setPendingRemoval({
                        type: "connection",
                        id: connection.id,
                        label: connection.name,
                      })
                    }
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                {connection.authType === "token" && (
                  <div className="mt-3 flex gap-2">
                    <Input
                      aria-label={t("settings:gitlabIntegration.newToken")}
                      autoComplete="new-password"
                      onChange={(event) =>
                        setRotationTokens((current) => ({
                          ...current,
                          [connection.id]: event.target.value,
                        }))
                      }
                      placeholder={t("settings:gitlabIntegration.newToken")}
                      type="password"
                      value={rotationTokens[connection.id] ?? ""}
                    />
                    <Button
                      disabled={
                        !rotationTokens[connection.id] ||
                        rotateConnection.isPending
                      }
                      onClick={() =>
                        rotateConnection.mutate({
                          workspaceId,
                          connectionId: connection.id,
                          accessToken: rotationTokens[connection.id] ?? "",
                        })
                      }
                      variant="outline"
                    >
                      <RefreshCw className="size-4" />
                      {t("settings:gitlabIntegration.rotate")}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <form
          className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-2"
          onSubmit={handleCreateConnection}
        >
          <div className="space-y-1.5">
            <Label htmlFor="gitlab-connection-name">
              {t("settings:gitlabIntegration.connectionName")}
            </Label>
            <Input
              id="gitlab-connection-name"
              onChange={(event) => setName(event.target.value)}
              placeholder={t(
                "settings:gitlabIntegration.connectionNamePlaceholder",
              )}
              value={name}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gitlab-url">
              {t("settings:gitlabIntegration.url")}
            </Label>
            <Input
              id="gitlab-url"
              onChange={(event) => setPublicUrl(event.target.value)}
              placeholder="https://gitlab.example.com"
              type="url"
              value={publicUrl}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="gitlab-token">
              {t("settings:gitlabIntegration.token")}
            </Label>
            <Input
              autoComplete="new-password"
              id="gitlab-token"
              onChange={(event) => setAccessToken(event.target.value)}
              placeholder={t("settings:gitlabIntegration.tokenPlaceholder")}
              type="password"
              value={accessToken}
            />
            <p className="text-muted-foreground text-xs">
              {t("settings:gitlabIntegration.tokenHint")}
            </p>
          </div>
          <div className="sm:col-span-2">
            <Button
              disabled={
                createConnection.isPending ||
                !name.trim() ||
                !publicUrl.trim() ||
                !accessToken
              }
              type="submit"
            >
              <KeyRound className="size-4" />
              {t("settings:gitlabIntegration.addConnection")}
            </Button>
          </div>
        </form>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="font-medium text-sm">
            {t("settings:gitlabIntegration.repositoriesTitle")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("settings:gitlabIntegration.repositoriesHint")}
          </p>
        </div>

        {repositories.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-muted-foreground text-sm">
            {t("settings:gitlabIntegration.noRepositories")}
          </p>
        ) : (
          <div className="space-y-2">
            {repositories.map((repository) => (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                key={repository.id}
              >
                <div className="min-w-0">
                  <a
                    className="inline-flex items-center gap-1 font-medium text-sm hover:underline"
                    href={repository.webUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <GitBranch className="size-4" />
                    {repository.fullPath}
                    <ExternalLink className="size-3" />
                  </a>
                  <div className="mt-1 flex gap-2">
                    <Badge
                      variant={
                        repository.webhookConfigured ? "success" : "warning"
                      }
                    >
                      {repository.webhookConfigured
                        ? t("settings:gitlabIntegration.webhookReady")
                        : t("settings:gitlabIntegration.webhookMissing")}
                    </Badge>
                    {repository.defaultBranch && (
                      <span className="text-muted-foreground text-xs">
                        {repository.defaultBranch}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    disabled={importingRepositoryId === repository.id}
                    onClick={() => handleImport(repository.id)}
                    size="sm"
                    variant="outline"
                  >
                    {importingRepositoryId === repository.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Import className="size-4" />
                    )}
                    {t("settings:gitlabIntegration.import")}
                  </Button>
                  <Button
                    aria-label={t("settings:gitlabIntegration.detach")}
                    onClick={() =>
                      setPendingRemoval({
                        type: "repository",
                        id: repository.id,
                        label: repository.fullPath,
                      })
                    }
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Unlink className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {connections.length > 0 && (
          <div className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label>{t("settings:gitlabIntegration.connection")}</Label>
              <Select
                onValueChange={(value) => {
                  setSelectedConnectionId(value ?? "");
                  setSelectedProjectId("");
                }}
                value={selectedConnectionId}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("settings:gitlabIntegration.project")}</Label>
              <Select
                disabled={projectsQuery.isLoading}
                onValueChange={(value) => setSelectedProjectId(value ?? "")}
                value={selectedProjectId}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      projectsQuery.isLoading
                        ? t("settings:gitlabIntegration.loadingProjects")
                        : t("settings:gitlabIntegration.selectProject")
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableProjects.map((project) => (
                    <SelectItem key={project.id} value={String(project.id)}>
                      {project.path_with_namespace}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              disabled={!selectedProjectId || attachRepository.isPending}
              onClick={handleAttach}
            >
              <Link className="size-4" />
              {t("settings:gitlabIntegration.attach")}
            </Button>
          </div>
        )}
      </section>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        open={pendingRemoval !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingRemoval?.type === "connection"
                ? t("settings:gitlabIntegration.removeConnectionTitle")
                : t("settings:gitlabIntegration.detachTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:gitlabIntegration.removeDescription", {
                name: pendingRemoval?.label ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("common:actions.cancel")}
            </AlertDialogClose>
            <Button
              disabled={
                removeConnection.isPending || detachRepository.isPending
              }
              onClick={confirmRemoval}
              variant="destructive"
            >
              {pendingRemoval?.type === "connection"
                ? t("common:actions.delete")
                : t("settings:gitlabIntegration.detach")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
