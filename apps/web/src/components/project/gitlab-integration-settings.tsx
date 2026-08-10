import { resolveApiBaseUrl } from "@kaneo/libs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  GitBranch,
  Import,
  KeyRound,
  Link,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unlink,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  attachGitLabRepository,
  beginGitLabOAuthConnection,
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

type SelectOption = { label: string; value: string };

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
  const [oauthName, setOauthName] = useState("");
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
  const [oauthPendingId, setOauthPendingId] = useState<string | null>(null);
  const oauthPopupRef = useRef<Window | null>(null);

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
  const oauthAvailability = connectionsQuery.data?.oauth;
  const repositories = repositoriesQuery.data?.repositories ?? [];
  const attachedProviderIds = useMemo(
    () =>
      new Set(
        repositories.map((repository) => repository.providerRepositoryId),
      ),
    [repositories],
  );
  const availableProjects = useMemo(
    () =>
      (projectsQuery.data?.projects ?? []).filter(
        (project) => !attachedProviderIds.has(String(project.id)),
      ),
    [attachedProviderIds, projectsQuery.data?.projects],
  );
  const connectionOptions = useMemo<SelectOption[]>(
    () =>
      connections.map((connection) => ({
        label: connection.name,
        value: connection.id,
      })),
    [connections],
  );
  const projectOptions = useMemo<SelectOption[]>(
    () =>
      availableProjects.map((project) => ({
        label: project.path_with_namespace,
        value: String(project.id),
      })),
    [availableProjects],
  );
  const selectedConnection = connectionOptions.find(
    (option) => option.value === selectedConnectionId,
  );
  const selectedProject = projectOptions.find(
    (option) => option.value === selectedProjectId,
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

  useEffect(() => {
    const apiOrigin = new URL(resolveApiBaseUrl(import.meta.env.VITE_API_URL))
      .origin;
    const handleMessage = (event: MessageEvent) => {
      if (
        event.origin !== apiOrigin ||
        event.source !== oauthPopupRef.current ||
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== "kaneo:gitlab-oauth" ||
        (event.data.status !== "success" && event.data.status !== "error")
      ) {
        return;
      }

      oauthPopupRef.current = null;
      setOauthPendingId(null);
      if (event.data.status === "success") {
        setOauthName("");
        void queryClient.invalidateQueries({
          queryKey: ["gitlab-connections"],
        });
        toast.success(t("settings:gitlabIntegration.toast.oauthConnected"));
      } else {
        toast.error(t("settings:gitlabIntegration.toast.oauthFailed"));
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [queryClient, t]);

  useEffect(() => {
    if (!oauthPendingId) return;
    const intervalId = window.setInterval(() => {
      if (oauthPopupRef.current?.closed) {
        oauthPopupRef.current = null;
        setOauthPendingId(null);
      }
    }, 500);
    return () => window.clearInterval(intervalId);
  }, [oauthPendingId]);

  const startOAuth = async (connection?: { id: string; name: string }) => {
    const connectionName = connection?.name ?? oauthName.trim();
    if (!workspaceId || !connectionName) return;
    const popup = window.open(
      "about:blank",
      "kaneo-gitlab-oauth",
      "popup,width=720,height=760",
    );
    if (!popup) {
      toast.error(t("settings:gitlabIntegration.toast.popupBlocked"));
      return;
    }

    oauthPopupRef.current = popup;
    setOauthPendingId(connection?.id ?? "new");
    try {
      const { authorizationUrl } = await beginGitLabOAuthConnection({
        workspaceId,
        name: connectionName,
        connectionId: connection?.id,
      });
      popup.location.replace(authorizationUrl);
      popup.focus();
    } catch (error) {
      popup.close();
      oauthPopupRef.current = null;
      setOauthPendingId(null);
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:gitlabIntegration.toast.oauthFailed"),
      );
    }
  };
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
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
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
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-4 rounded-md border border-border bg-sidebar p-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-medium text-sm">
            {t("settings:gitlabIntegration.connectionsTitle")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("settings:gitlabIntegration.connectionsHint")}
          </p>
        </div>

        {connections.length > 0 && (
          <div className="flex flex-col gap-2">
            {connections.map((connection) => (
              <div
                className="flex flex-col gap-3 rounded-md border border-border bg-background p-3"
                key={connection.id}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">
                        {connection.name}
                      </span>
                      <Badge
                        className="capitalize"
                        variant={
                          connection.status === "active" ? "success" : "warning"
                        }
                      >
                        {connection.status}
                      </Badge>
                      <Badge className="capitalize" variant="outline">
                        {connection.authType}
                      </Badge>
                    </div>
                    <a
                      aria-label={`${connection.name}: ${connection.publicUrl}`}
                      className="mt-1 inline-flex max-w-full items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
                      href={connection.publicUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <span className="truncate">{connection.publicUrl}</span>
                      <ExternalLink
                        aria-hidden="true"
                        className="size-3 shrink-0"
                      />
                    </a>
                    <p className="mt-1 text-muted-foreground text-xs">
                      {connection.gitlabUsername
                        ? `@${connection.gitlabUsername} · `
                        : ""}
                      {connection.credentialHint
                        ? `${connection.credentialHint} · `
                        : ""}
                      {connection.attachedRepositoryCount}{" "}
                      {t("settings:gitlabIntegration.repositoriesCount")}
                    </p>
                    {connection.statusMessage && (
                      <p className="mt-1 text-warning-foreground text-xs">
                        {connection.statusMessage}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
                    {connection.authType === "oauth" && (
                      <Button
                        disabled={oauthPendingId !== null}
                        loading={oauthPendingId === connection.id}
                        onClick={() => startOAuth(connection)}
                        size="sm"
                        variant="outline"
                      >
                        <RefreshCw aria-hidden="true" className="size-3" />
                        {t("settings:gitlabIntegration.reauthorizeOAuth")}
                      </Button>
                    )}
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
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Trash2 aria-hidden="true" className="size-3" />
                    </Button>
                  </div>
                </div>

                {connection.authType === "token" && (
                  <div className="grid gap-2 border-border border-t pt-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <Field>
                      <FieldLabel htmlFor={`gitlab-token-${connection.id}`}>
                        {t("settings:gitlabIntegration.newToken")}
                      </FieldLabel>
                      <Input
                        autoComplete="new-password"
                        id={`gitlab-token-${connection.id}`}
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
                    </Field>
                    <Button
                      disabled={
                        !rotationTokens[connection.id] ||
                        rotateConnection.isPending
                      }
                      loading={
                        rotateConnection.isPending &&
                        rotateConnection.variables?.connectionId ===
                          connection.id
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
                      <RefreshCw aria-hidden="true" className="size-4" />
                      {t("settings:gitlabIntegration.rotate")}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {oauthAvailability?.enabled && oauthAvailability.publicUrl && (
          <form
            className="flex flex-col gap-3 rounded-md border border-border bg-background p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void startOAuth();
            }}
          >
            <Field>
              <FieldLabel htmlFor="gitlab-oauth-connection-name">
                {t("settings:gitlabIntegration.oauthConnectionName")}
              </FieldLabel>
              <Input
                id="gitlab-oauth-connection-name"
                onChange={(event) => setOauthName(event.target.value)}
                placeholder={t(
                  "settings:gitlabIntegration.connectionNamePlaceholder",
                )}
                value={oauthName}
              />
              <FieldDescription>
                {t("settings:gitlabIntegration.oauthHint", {
                  url: oauthAvailability.publicUrl,
                })}
              </FieldDescription>
            </Field>
            <div className="flex justify-end">
              <Button
                disabled={!oauthName.trim() || oauthPendingId !== null}
                loading={oauthPendingId === "new"}
                type="submit"
              >
                <ShieldCheck aria-hidden="true" className="size-4" />
                {t("settings:gitlabIntegration.connectOAuth")}
              </Button>
            </div>
          </form>
        )}

        <form
          className="flex flex-col gap-3 rounded-md border border-border bg-background p-3"
          onSubmit={handleCreateConnection}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="gitlab-connection-name">
                {t("settings:gitlabIntegration.connectionName")}
              </FieldLabel>
              <Input
                id="gitlab-connection-name"
                onChange={(event) => setName(event.target.value)}
                placeholder={t(
                  "settings:gitlabIntegration.connectionNamePlaceholder",
                )}
                value={name}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="gitlab-url">
                {t("settings:gitlabIntegration.url")}
              </FieldLabel>
              <Input
                id="gitlab-url"
                onChange={(event) => setPublicUrl(event.target.value)}
                placeholder="https://gitlab.example.com"
                type="url"
                value={publicUrl}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="gitlab-token">
              {t("settings:gitlabIntegration.token")}
            </FieldLabel>
            <Input
              autoComplete="new-password"
              id="gitlab-token"
              onChange={(event) => setAccessToken(event.target.value)}
              placeholder={t("settings:gitlabIntegration.tokenPlaceholder")}
              type="password"
              value={accessToken}
            />
            <FieldDescription>
              {t("settings:gitlabIntegration.tokenHint")}
            </FieldDescription>
          </Field>
          <div className="flex justify-end">
            <Button
              disabled={!name.trim() || !publicUrl.trim() || !accessToken}
              loading={createConnection.isPending}
              type="submit"
            >
              <KeyRound aria-hidden="true" className="size-4" />
              {t("settings:gitlabIntegration.addConnection")}
            </Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-4 rounded-md border border-border bg-sidebar p-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-medium text-sm">
            {t("settings:gitlabIntegration.repositoriesTitle")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("settings:gitlabIntegration.repositoriesHint")}
          </p>
        </div>

        {repositories.length === 0 ? (
          <p className="rounded-md border border-border border-dashed bg-background/50 p-4 text-center text-muted-foreground text-sm">
            {t("settings:gitlabIntegration.noRepositories")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {repositories.map((repository) => (
              <div
                className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
                key={repository.id}
              >
                <div className="min-w-0">
                  <a
                    aria-label={repository.fullPath}
                    className="inline-flex max-w-full items-center gap-1.5 font-medium text-sm transition-colors hover:text-primary"
                    href={repository.webUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <GitBranch aria-hidden="true" className="size-4 shrink-0" />
                    <span className="truncate">{repository.fullPath}</span>
                    <ExternalLink
                      aria-hidden="true"
                      className="size-3 shrink-0"
                    />
                  </a>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
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
                <div className="flex shrink-0 items-center justify-end gap-1">
                  <Button
                    loading={importingRepositoryId === repository.id}
                    onClick={() => handleImport(repository.id)}
                    size="sm"
                    variant="outline"
                  >
                    <Import aria-hidden="true" className="size-3" />
                    {t("settings:gitlabIntegration.import")}
                  </Button>
                  <Button
                    aria-label={`${t("settings:gitlabIntegration.detach")} ${repository.fullPath}`}
                    disabled={detachRepository.isPending}
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
                    <Unlink aria-hidden="true" className="size-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {connections.length > 0 && (
          <div className="grid gap-3 rounded-md border border-border bg-background p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end">
            <Field>
              <FieldLabel>
                {t("settings:gitlabIntegration.connection")}
              </FieldLabel>
              <Select
                itemToStringValue={(option) => option.label}
                items={connectionOptions}
                onValueChange={(option) => {
                  setSelectedConnectionId(option?.value ?? "");
                  setSelectedProjectId("");
                }}
                value={selectedConnection}
              >
                <SelectTrigger>
                  <SelectValue>{selectedConnection?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {connectionOptions.map((option) => (
                    <SelectItem key={option.value} value={option}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{t("settings:gitlabIntegration.project")}</FieldLabel>
              <Select
                disabled={projectsQuery.isLoading}
                itemToStringValue={(option) => option.label}
                items={projectOptions}
                onValueChange={(option) =>
                  setSelectedProjectId(option?.value ?? "")
                }
                value={selectedProject}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      projectsQuery.isLoading
                        ? t("settings:gitlabIntegration.loadingProjects")
                        : t("settings:gitlabIntegration.selectProject")
                    }
                  >
                    {selectedProject?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {projectOptions.map((option) => (
                    <SelectItem key={option.value} value={option}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button
              disabled={!selectedProjectId}
              loading={attachRepository.isPending}
              onClick={handleAttach}
            >
              <Link aria-hidden="true" className="size-4" />
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
