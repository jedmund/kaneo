import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import {
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  GitBranch,
  Import,
  Link,
  Plus,
  Unlink,
  XCircle,
} from "lucide-react";
import React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod/v4";
import { GithubIcon } from "@/components/icons/github-icon";
import { RepositoryBrowserModal } from "@/components/project/repository-browser-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { VerifyGithubInstallationResponse } from "@/fetchers/github-integration/verify-github-installation";
import {
  useCreateGithubIntegration,
  useDetachGithubRepository,
  useVerifyGithubInstallation,
} from "@/hooks/mutations/github-integration/use-create-github-integration";
import useImportGithubIssues from "@/hooks/mutations/github-integration/use-import-github-issues";
import { useUpdateGithubIntegration } from "@/hooks/mutations/github-integration/use-update-github-integration";
import useGetGithubIntegration from "@/hooks/queries/github-integration/use-get-github-integration";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

type GithubIntegrationFormValues = {
  repositoryOwner: string;
  repositoryName: string;
};

export function GitHubIntegrationSettings({
  projectId,
}: {
  projectId: string;
}) {
  const { t } = useTranslation();
  const githubIntegrationSchema = React.useMemo(
    () =>
      z.object({
        repositoryOwner: z
          .string()
          .min(1, t("settings:githubIntegration.validation.ownerRequired"))
          .regex(
            /^[a-zA-Z0-9-]+$/,
            t("settings:githubIntegration.validation.ownerInvalid"),
          ),
        repositoryName: z
          .string()
          .min(1, t("settings:githubIntegration.validation.nameRequired"))
          .regex(
            /^[a-zA-Z0-9._-]+$/,
            t("settings:githubIntegration.validation.nameInvalid"),
          ),
      }),
    [t],
  );

  const { data: integration, isLoading } = useGetGithubIntegration(projectId);
  const { mutateAsync: createIntegration, isPending: isCreating } =
    useCreateGithubIntegration();
  const { mutateAsync: detachRepository, isPending: isDetaching } =
    useDetachGithubRepository();
  const { mutateAsync: verifyInstallation, isPending: isVerifying } =
    useVerifyGithubInstallation();
  const { mutateAsync: importIssues, isPending: isImporting } =
    useImportGithubIssues();
  const { mutateAsync: updateGithubSettings, isPending: isUpdatingSettings } =
    useUpdateGithubIntegration();

  const [verificationResult, setVerificationResult] =
    React.useState<VerifyGithubInstallationResponse | null>(null);
  const [addRepositoryDialogOpen, setAddRepositoryDialogOpen] =
    React.useState(false);
  const [showRepositoryBrowser, setShowRepositoryBrowser] =
    React.useState(false);
  const [importingRepositoryId, setImportingRepositoryId] = React.useState<
    string | null
  >(null);
  const [detachingRepositoryId, setDetachingRepositoryId] = React.useState<
    string | null
  >(null);

  const form = useForm<GithubIntegrationFormValues>({
    resolver: standardSchemaResolver(githubIntegrationSchema),
    defaultValues: {
      repositoryOwner: "",
      repositoryName: "",
    },
  });

  const resetAddRepositoryForm = React.useCallback(() => {
    form.reset({
      repositoryOwner: integration?.repositoryOwner ?? "",
      repositoryName: "",
    });
    setVerificationResult(null);
  }, [form, integration?.repositoryOwner]);

  const handleAddRepositoryDialogOpenChange = (open: boolean) => {
    setAddRepositoryDialogOpen(open);
    if (open) {
      resetAddRepositoryForm();
    } else {
      setShowRepositoryBrowser(false);
      setVerificationResult(null);
    }
  };

  const repositoryOwner = form.watch("repositoryOwner");
  const repositoryName = form.watch("repositoryName");

  const handleVerifyInstallation = React.useCallback(
    async (data: GithubIntegrationFormValues, showToast = true) => {
      try {
        const result = await verifyInstallation(data);
        setVerificationResult(result);

        if (showToast) {
          if (result.isInstalled && result.hasRequiredPermissions) {
            toast.success(t("settings:githubIntegration.toast.installedOk"));
          } else if (result.isInstalled) {
            toast.warning(
              t("settings:githubIntegration.toast.installedMissingPerms"),
            );
          } else if (result.repositoryExists) {
            toast.warning(
              t("settings:githubIntegration.toast.needsInstallOnRepo"),
            );
          } else {
            toast.error(t("settings:githubIntegration.toast.repoNotFound"));
          }
        }
      } catch (error) {
        if (showToast) {
          toast.error(
            error instanceof Error
              ? error.message
              : t("settings:githubIntegration.toast.verifyError"),
          );
        }
        setVerificationResult(null);
      }
    },
    [verifyInstallation, t],
  );

  React.useEffect(() => {
    if (
      !addRepositoryDialogOpen ||
      !repositoryOwner ||
      !repositoryName ||
      !form.formState.isValid
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      handleVerifyInstallation({ repositoryOwner, repositoryName }, false);
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [
    addRepositoryDialogOpen,
    repositoryOwner,
    repositoryName,
    form.formState.isValid,
    handleVerifyInstallation,
  ]);

  const handleRepositorySelect = (repository: {
    owner: string;
    name: string;
  }) => {
    form.setValue("repositoryOwner", repository.owner, {
      shouldValidate: true,
      shouldDirty: true,
      shouldTouch: true,
    });
    form.setValue("repositoryName", repository.name, {
      shouldValidate: true,
      shouldDirty: true,
      shouldTouch: true,
    });
    setShowRepositoryBrowser(false);

    setVerificationResult(null);
  };

  const onSubmit = async (data: GithubIntegrationFormValues) => {
    try {
      const verification = await verifyInstallation(data);

      if (!verification.isInstalled) {
        toast.error(t("settings:githubIntegration.toast.installAppFirst"));
        return;
      }

      if (!verification.hasRequiredPermissions) {
        toast.error(
          t("settings:githubIntegration.toast.missingPermsDetail", {
            list: verification.missingPermissions?.join(", ") || "issues",
          }),
        );
        return;
      }

      await createIntegration({
        projectId,
        data,
      });
      toast.success(t("settings:githubIntegration.toast.repositoryAttached"));
      setAddRepositoryDialogOpen(false);
      setVerificationResult(null);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:githubIntegration.toast.attachError"),
      );
    }
  };

  const handleImportIssues = async (repositoryId: string) => {
    setImportingRepositoryId(repositoryId);
    try {
      await importIssues({ projectId, repositoryId });
      toast.success(t("settings:githubIntegration.toast.issuesImported"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:githubIntegration.toast.importError"),
      );
    } finally {
      setImportingRepositoryId(null);
    }
  };

  const handleDetachRepository = async (repositoryId: string) => {
    setDetachingRepositoryId(repositoryId);
    try {
      await detachRepository({ projectId, repositoryId });
      toast.success(t("settings:githubIntegration.toast.removed"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:githubIntegration.toast.removeError"),
      );
    } finally {
      setDetachingRepositoryId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="space-y-4 border border-border rounded-md p-4 bg-sidebar">
          <div className="space-y-4">
            <div className="h-4 bg-muted rounded animate-pulse w-40" />
            <div className="h-4 bg-muted rounded animate-pulse w-full" />
            <div className="h-10 bg-muted rounded animate-pulse w-full" />
          </div>
        </div>
        <div className="space-y-4 border border-border rounded-md p-4 bg-sidebar">
          <div className="space-y-4">
            <div className="h-4 bg-muted rounded animate-pulse w-40" />
            <div className="h-10 bg-muted rounded animate-pulse w-full" />
            <div className="h-10 bg-muted rounded animate-pulse w-full" />
          </div>
        </div>
      </div>
    );
  }

  const isConnected = !!integration && integration.isActive;
  const repositories = integration?.repositories ?? [];

  return (
    <div className="space-y-4">
      <div className="space-y-4 border border-border rounded-md p-4 bg-sidebar">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">
              {t("settings:githubIntegration.connectionStatus")}
            </p>
            {isConnected ? (
              <p className="text-xs text-muted-foreground">
                {t("settings:githubIntegration.connectedActive")}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("settings:githubIntegration.notConnectedHint")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isConnected ? (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle className="w-3 h-3" />
                  {t("settings:githubIntegration.badgeConnected")}
                </Badge>
              </div>
            ) : (
              <Badge variant="outline" className="gap-1">
                <XCircle className="w-3 h-3" />
                {t("settings:githubIntegration.badgeNotConnected")}
              </Badge>
            )}
          </div>
        </div>

        <Separator />
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {t("settings:githubIntegration.repositoriesTitle")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("settings:githubIntegration.repositoriesHint")}
              </p>
            </div>
            <Button
              onClick={() => handleAddRepositoryDialogOpenChange(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus aria-hidden="true" className="size-4" />
              {t("settings:githubIntegration.addRepository")}
            </Button>
          </div>

          {repositories.length === 0 ? (
            <p className="rounded-md border border-border border-dashed bg-background/50 p-4 text-center text-muted-foreground text-sm">
              {t("settings:githubIntegration.noRepositories")}
            </p>
          ) : (
            <div className="space-y-2">
              {repositories.map((repository) => (
                <div
                  key={repository.id}
                  className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <a
                    aria-label={repository.fullPath}
                    className="inline-flex min-w-0 max-w-full items-center gap-1.5 font-medium text-sm transition-colors hover:text-primary"
                    href={repository.webUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <GithubIcon
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                    <span className="truncate font-medium">
                      {repository.fullPath}
                    </span>
                    <ExternalLink
                      aria-hidden="true"
                      className="size-3 shrink-0"
                    />
                  </a>
                  <div className="flex shrink-0 items-center justify-end gap-1">
                    <Button
                      disabled={isImporting || isDetaching}
                      loading={importingRepositoryId === repository.id}
                      onClick={() => handleImportIssues(repository.id)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Import aria-hidden="true" className="size-3" />
                      {t("settings:githubIntegration.importIssues")}
                    </Button>
                    <Button
                      aria-label={`${t("settings:githubIntegration.detach")} ${repository.fullPath}`}
                      disabled={isImporting || isDetaching}
                      loading={detachingRepositoryId === repository.id}
                      onClick={() => handleDetachRepository(repository.id)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Unlink aria-hidden="true" className="size-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {isConnected && integration && (
          <>
            <Separator />
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium">
                  {t("settings:githubIntegration.commentTaskLinkTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings:githubIntegration.commentTaskLinkHint")}
                </p>
              </div>
              <Switch
                checked={integration.commentTaskLinkOnGitHubIssue !== false}
                disabled={isUpdatingSettings}
                onCheckedChange={async (checked) => {
                  try {
                    await updateGithubSettings({
                      projectId,
                      json: { commentTaskLinkOnGitHubIssue: checked },
                    });
                    toast.success(
                      checked
                        ? t("settings:githubIntegration.toast.commentOnEnabled")
                        : t(
                            "settings:githubIntegration.toast.commentOnDisabled",
                          ),
                    );
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : t(
                            "settings:githubIntegration.toast.settingsUpdateError",
                          ),
                    );
                  }
                }}
              />
            </div>
          </>
        )}
      </div>

      <Dialog
        onOpenChange={handleAddRepositoryDialogOpenChange}
        open={addRepositoryDialogOpen}
      >
        <DialogPopup className="max-w-xl">
          <Form {...form}>
            <form className="contents" onSubmit={form.handleSubmit(onSubmit)}>
              <DialogHeader>
                <DialogTitle>
                  {t("settings:githubIntegration.addRepositoryTitle")}
                </DialogTitle>
                <DialogDescription>
                  {t("settings:githubIntegration.addRepositoryHint")}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-5">
                <Button
                  className="w-full justify-start"
                  onClick={() => setShowRepositoryBrowser(true)}
                  type="button"
                  variant="outline"
                >
                  <GitBranch aria-hidden="true" className="size-4" />
                  {t("settings:githubIntegration.browseRepositories")}
                </Button>

                <div className="relative flex items-center">
                  <Separator />
                  <span className="absolute left-1/2 -translate-x-1/2 bg-popover px-2 text-muted-foreground text-xs">
                    {t("settings:githubIntegration.manualEntry")}
                  </span>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="repositoryOwner"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {t("settings:githubIntegration.ownerLabel")}
                        </FormLabel>
                        <FormControl>
                          <Input
                            autoComplete="off"
                            disabled={isCreating}
                            placeholder={t(
                              "settings:githubIntegration.ownerPlaceholder",
                            )}
                            type="text"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="repositoryName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {t("settings:githubIntegration.repoNameLabel")}
                        </FormLabel>
                        <FormControl>
                          <Input
                            autoComplete="off"
                            disabled={isCreating}
                            placeholder={t(
                              "settings:githubIntegration.repoNamePlaceholder",
                            )}
                            type="text"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {verificationResult && (
                  <div
                    className={cn(
                      "flex items-start gap-3 rounded-md border p-3 text-sm",
                      verificationResult.isInstalled &&
                        verificationResult.hasRequiredPermissions
                        ? "border-success/25 bg-success/10"
                        : verificationResult.isInstalled ||
                            verificationResult.repositoryExists
                          ? "border-warning/25 bg-warning/10"
                          : "border-destructive/25 bg-destructive/10",
                    )}
                  >
                    {verificationResult.isInstalled &&
                    verificationResult.hasRequiredPermissions ? (
                      <CheckCircle className="mt-0.5 size-4 shrink-0 text-success-foreground" />
                    ) : verificationResult.isInstalled ||
                      verificationResult.repositoryExists ? (
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
                    ) : (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
                    )}
                    <div className="min-w-0 flex-1 space-y-2">
                      <p className="font-medium">
                        {verificationResult.message}
                      </p>
                      {verificationResult.isInstalled &&
                        !verificationResult.hasRequiredPermissions &&
                        verificationResult.missingPermissions && (
                          <p className="text-xs">
                            {t(
                              "settings:githubIntegration.missingPermissionsLabel",
                            )}{" "}
                            <strong>
                              {verificationResult.missingPermissions.join(", ")}
                            </strong>
                          </p>
                        )}
                      {verificationResult.settingsUrl &&
                        verificationResult.isInstalled &&
                        !verificationResult.hasRequiredPermissions && (
                          <Button
                            onClick={() =>
                              window.open(
                                verificationResult.settingsUrl,
                                "_blank",
                              )
                            }
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <ExternalLink
                              aria-hidden="true"
                              className="size-3"
                            />
                            {t("settings:githubIntegration.updatePermissions")}
                          </Button>
                        )}
                      {verificationResult.installationUrl &&
                        !verificationResult.isInstalled &&
                        verificationResult.repositoryExists && (
                          <Button
                            onClick={() =>
                              window.open(
                                verificationResult.installationUrl,
                                "_blank",
                              )
                            }
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <ExternalLink
                              aria-hidden="true"
                              className="size-3"
                            />
                            {t("settings:githubIntegration.installGithubApp")}
                          </Button>
                        )}
                    </div>
                  </div>
                )}
              </DialogPanel>
              <DialogFooter>
                <DialogClose
                  render={<Button type="button" variant="outline" />}
                >
                  {t("common:actions.cancel")}
                </DialogClose>
                <Button
                  disabled={
                    isCreating || isVerifying || !form.formState.isValid
                  }
                  loading={isCreating || isVerifying}
                  type="submit"
                >
                  <Link aria-hidden="true" className="size-4" />
                  {t("settings:githubIntegration.addRepository")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogPopup>
      </Dialog>

      <RepositoryBrowserModal
        excludedRepositories={repositories.map(
          (repository) => repository.fullPath,
        )}
        open={showRepositoryBrowser}
        onOpenChange={setShowRepositoryBrowser}
        onSelectRepository={handleRepositorySelect}
        selectedRepository={
          repositoryOwner && repositoryName
            ? `${repositoryOwner}/${repositoryName}`
            : undefined
        }
      />
    </div>
  );
}
