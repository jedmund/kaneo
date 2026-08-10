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
import { GiteaRepositoryBrowserModal } from "@/components/project/gitea-repository-browser-modal";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { VerifyGiteaAccessResponse } from "@/fetchers/gitea-integration/verify-gitea-access";
import {
  useCreateGiteaIntegration,
  useDetachGiteaRepository,
  useVerifyGiteaAccess,
} from "@/hooks/mutations/gitea-integration/use-create-gitea-integration";
import useImportGiteaIssues from "@/hooks/mutations/gitea-integration/use-import-gitea-issues";
import { useUpdateGiteaIntegration } from "@/hooks/mutations/gitea-integration/use-update-gitea-integration";
import useGetGiteaIntegration from "@/hooks/queries/gitea-integration/use-get-gitea-integration";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

type GiteaIntegrationFormValues = {
  baseUrl: string;
  accessToken: string;
  repositoryOwner: string;
  repositoryName: string;
};

type GiteaVerificationSnapshot = {
  baseUrl: string;
  accessToken: string;
  repositoryOwner: string;
  repositoryName: string;
};

type GiteaVerificationState = {
  result: VerifyGiteaAccessResponse;
  verified: GiteaVerificationSnapshot;
};

function createVerificationSnapshot(
  values: GiteaIntegrationFormValues,
): GiteaVerificationSnapshot {
  return {
    baseUrl: values.baseUrl.trim(),
    accessToken: values.accessToken.trim(),
    repositoryOwner: values.repositoryOwner.trim(),
    repositoryName: values.repositoryName.trim(),
  };
}

function normalizeBaseUrlForComparison(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function GiteaIntegrationSettings({ projectId }: { projectId: string }) {
  const { t } = useTranslation();

  const giteaIntegrationSchema = React.useMemo(
    () =>
      z.object({
        baseUrl: z
          .string()
          .min(1, t("settings:giteaIntegration.validation.baseUrlRequired"))
          .refine((s) => {
            try {
              new URL(s);
              return true;
            } catch {
              return false;
            }
          }, t("settings:giteaIntegration.validation.baseUrlInvalid")),
        accessToken: z.string(),
        repositoryOwner: z
          .string()
          .min(1, t("settings:giteaIntegration.validation.ownerRequired"))
          .regex(
            /^[a-zA-Z0-9_.-]+$/,
            t("settings:giteaIntegration.validation.ownerInvalid"),
          ),
        repositoryName: z
          .string()
          .min(1, t("settings:giteaIntegration.validation.nameRequired"))
          .regex(
            /^[a-zA-Z0-9._-]+$/,
            t("settings:giteaIntegration.validation.nameInvalid"),
          ),
      }),
    [t],
  );

  const {
    data: integration,
    isLoading,
    error: integrationError,
    refetch: refetchIntegration,
  } = useGetGiteaIntegration(projectId);
  const { mutateAsync: createIntegration, isPending: isCreating } =
    useCreateGiteaIntegration();
  const { mutateAsync: detachRepository, isPending: isDetaching } =
    useDetachGiteaRepository();
  const { mutateAsync: verifyAccess, isPending: isVerifying } =
    useVerifyGiteaAccess();
  const { mutateAsync: importIssues, isPending: isImporting } =
    useImportGiteaIssues();
  const { mutateAsync: updateGiteaSettings, isPending: isUpdatingSettings } =
    useUpdateGiteaIntegration();

  const [verificationResult, setVerificationResult] =
    React.useState<GiteaVerificationState | null>(null);
  const [addRepositoryDialogOpen, setAddRepositoryDialogOpen] =
    React.useState(false);
  const [showRepositoryBrowser, setShowRepositoryBrowser] =
    React.useState(false);
  const [shownWebhookSecret, setShownWebhookSecret] = React.useState<
    string | null
  >(null);
  const [importingRepositoryId, setImportingRepositoryId] = React.useState<
    string | null
  >(null);
  const [detachingRepositoryId, setDetachingRepositoryId] = React.useState<
    string | null
  >(null);

  const form = useForm<GiteaIntegrationFormValues>({
    resolver: standardSchemaResolver(giteaIntegrationSchema),
    defaultValues: {
      baseUrl: "",
      accessToken: "",
      repositoryOwner: "",
      repositoryName: "",
    },
  });

  const resetAddRepositoryForm = React.useCallback(() => {
    form.reset({
      baseUrl: integration?.baseUrl ?? "",
      accessToken: "",
      repositoryOwner: integration?.repositoryOwner ?? "",
      repositoryName: "",
    });
    setVerificationResult(null);
  }, [form, integration?.baseUrl, integration?.repositoryOwner]);

  const handleAddRepositoryDialogOpenChange = (open: boolean) => {
    setAddRepositoryDialogOpen(open);
    if (open) {
      resetAddRepositoryForm();
    } else {
      setShowRepositoryBrowser(false);
      setVerificationResult(null);
    }
  };

  const runVerify = React.useCallback(
    async (data: GiteaIntegrationFormValues, showToast = true) => {
      const token = data.accessToken.trim();
      if (!token) {
        if (showToast) {
          toast.error(t("settings:giteaIntegration.toast.tokenRequiredVerify"));
        }
        setVerificationResult(null);
        return;
      }
      try {
        const snapshot = createVerificationSnapshot(data);
        const result = await verifyAccess({
          projectId,
          baseUrl: snapshot.baseUrl,
          accessToken: snapshot.accessToken,
          repositoryOwner: snapshot.repositoryOwner,
          repositoryName: snapshot.repositoryName,
        });
        setVerificationResult({
          result,
          verified: snapshot,
        });
        if (showToast) {
          if (result.isInstalled && result.hasRequiredPermissions) {
            toast.success(t("settings:giteaIntegration.toast.verifyOk"));
          } else if (!result.repositoryExists) {
            toast.error(t("settings:giteaIntegration.toast.repoNotFound"));
          } else {
            toast.warning(t("settings:giteaIntegration.toast.verifyWarning"));
          }
        }
      } catch (error) {
        if (showToast) {
          toast.error(
            error instanceof Error
              ? error.message
              : t("settings:giteaIntegration.toast.verifyError"),
          );
        }
        setVerificationResult(null);
      }
    },
    [verifyAccess, projectId, t],
  );

  const baseUrl = form.watch("baseUrl");
  const accessToken = form.watch("accessToken");
  const repositoryOwner = form.watch("repositoryOwner");
  const repositoryName = form.watch("repositoryName");
  const currentVerificationSnapshot = React.useMemo(
    () =>
      createVerificationSnapshot({
        baseUrl,
        accessToken,
        repositoryOwner,
        repositoryName,
      }),
    [baseUrl, accessToken, repositoryOwner, repositoryName],
  );
  const canUseStoredCredential = Boolean(
    integration?.baseUrl &&
      normalizeBaseUrlForComparison(baseUrl) ===
        normalizeBaseUrlForComparison(integration.baseUrl),
  );

  React.useEffect(() => {
    setVerificationResult((current) => {
      if (!current) {
        return current;
      }

      const stillMatches =
        current.verified.baseUrl === currentVerificationSnapshot.baseUrl &&
        current.verified.accessToken ===
          currentVerificationSnapshot.accessToken &&
        current.verified.repositoryOwner ===
          currentVerificationSnapshot.repositoryOwner &&
        current.verified.repositoryName ===
          currentVerificationSnapshot.repositoryName;

      return stillMatches ? current : null;
    });
  }, [currentVerificationSnapshot]);

  React.useEffect(() => {
    if (
      !addRepositoryDialogOpen ||
      !baseUrl ||
      !repositoryOwner ||
      !repositoryName ||
      !form.formState.isValid
    ) {
      return;
    }
    if (!accessToken.trim()) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      runVerify(form.getValues(), false);
    }, 400);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    addRepositoryDialogOpen,
    baseUrl,
    repositoryOwner,
    repositoryName,
    accessToken,
    form.formState.isValid,
    runVerify,
    form.getValues,
  ]);

  const onSubmit = async (data: GiteaIntegrationFormValues) => {
    try {
      if (!data.accessToken.trim() && !canUseStoredCredential) {
        toast.error(t("settings:giteaIntegration.toast.tokenRequired"));
        return;
      }

      const snapshot = createVerificationSnapshot(data);
      const hasMatchingVerification =
        verificationResult?.result.isInstalled &&
        verificationResult.result.hasRequiredPermissions &&
        verificationResult.verified.baseUrl === snapshot.baseUrl &&
        verificationResult.verified.accessToken === snapshot.accessToken &&
        verificationResult.verified.repositoryOwner ===
          snapshot.repositoryOwner &&
        verificationResult.verified.repositoryName === snapshot.repositoryName;

      if (data.accessToken.trim() && !hasMatchingVerification) {
        const verification = await verifyAccess({
          projectId,
          baseUrl: snapshot.baseUrl,
          accessToken: snapshot.accessToken,
          repositoryOwner: snapshot.repositoryOwner,
          repositoryName: snapshot.repositoryName,
        });

        if (!verification.isInstalled || !verification.hasRequiredPermissions) {
          toast.error(t("settings:giteaIntegration.toast.verifyFirst"));
          return;
        }
      }

      await createIntegration({
        projectId,
        data: {
          baseUrl: data.baseUrl,
          ...(data.accessToken.trim()
            ? { accessToken: data.accessToken.trim() }
            : {}),
          repositoryOwner: data.repositoryOwner,
          repositoryName: data.repositoryName,
        },
      });
      toast.success(t("settings:giteaIntegration.toast.repositoryAttached"));
      setAddRepositoryDialogOpen(false);
      setVerificationResult(null);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:giteaIntegration.toast.attachError"),
      );
    }
  };

  const handleImportIssues = async (repositoryId: string) => {
    setImportingRepositoryId(repositoryId);
    try {
      await importIssues({ projectId, repositoryId });
      toast.success(t("settings:giteaIntegration.toast.issuesImported"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:giteaIntegration.toast.importError"),
      );
    } finally {
      setImportingRepositoryId(null);
    }
  };

  const handleDetachRepository = async (repositoryId: string) => {
    setDetachingRepositoryId(repositoryId);
    try {
      await detachRepository({ projectId, repositoryId });
      toast.success(t("settings:giteaIntegration.toast.removed"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:giteaIntegration.toast.removeError"),
      );
    } finally {
      setDetachingRepositoryId(null);
    }
  };

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

  const handleCopyWebhookSecret = React.useCallback(
    async (secret: string) => {
      if (!secret) {
        return;
      }

      try {
        await navigator.clipboard.writeText(secret);
        toast.success(t("settings:giteaIntegration.toast.secretCopied"));
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("settings:giteaIntegration.toast.unableToCopySecret"),
        );
      }
    },
    [t],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-10 bg-muted rounded animate-pulse w-full" />
      </div>
    );
  }

  if (integrationError) {
    return (
      <div className="space-y-4 border border-destructive/25 rounded-md p-4 bg-sidebar">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">
              {t("common:error.title")}
            </p>
            <p className="text-sm text-muted-foreground">
              {integrationError instanceof Error
                ? integrationError.message
                : t("settings:giteaIntegration.toast.updateError")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => refetchIntegration()}
          >
            {t("settings:giteaIntegration.retry")}
          </Button>
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
              {t("settings:giteaIntegration.connectionStatus")}
            </p>
            {isConnected ? (
              <p className="text-xs text-muted-foreground">
                {t("settings:giteaIntegration.connectedActive")}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("settings:giteaIntegration.notConnectedHint")}
              </p>
            )}
          </div>
          {isConnected ? (
            <Badge variant="secondary" className="gap-1">
              <CheckCircle className="w-3 h-3" />
              {t("settings:giteaIntegration.badgeConnected")}
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <XCircle className="w-3 h-3" />
              {t("settings:giteaIntegration.badgeNotConnected")}
            </Badge>
          )}
        </div>

        <Separator />
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {t("settings:giteaIntegration.repositoriesTitle")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("settings:giteaIntegration.repositoriesHint")}
              </p>
            </div>
            <Button
              onClick={() => handleAddRepositoryDialogOpenChange(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus aria-hidden="true" className="size-4" />
              {t("settings:giteaIntegration.addRepository")}
            </Button>
          </div>

          {repositories.length === 0 ? (
            <p className="rounded-md border border-border border-dashed bg-background/50 p-4 text-center text-muted-foreground text-sm">
              {t("settings:giteaIntegration.noRepositories")}
            </p>
          ) : (
            <div className="space-y-2">
              {repositories.map((repository) => (
                <div
                  key={repository.id}
                  className="space-y-3 rounded-md border border-border bg-background p-3"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <a
                      aria-label={repository.fullPath}
                      className="inline-flex min-w-0 max-w-full items-center gap-1.5 font-medium text-sm transition-colors hover:text-primary"
                      href={repository.webUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <GitBranch
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
                    <div className="flex shrink-0 justify-end gap-1">
                      <Button
                        disabled={isImporting || isDetaching}
                        loading={importingRepositoryId === repository.id}
                        onClick={() => handleImportIssues(repository.id)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Import aria-hidden="true" className="size-3" />
                        {t("settings:giteaIntegration.importIssues")}
                      </Button>
                      <Button
                        aria-label={`${t("settings:giteaIntegration.detach")} ${repository.fullPath}`}
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
                  <div className="space-y-2 text-xs">
                    <code className="block break-all rounded bg-muted px-2 py-1 text-[11px]">
                      {repository.webhookUrl}
                    </code>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                      <code className="block flex-1 break-all rounded bg-muted px-2 py-1 text-[11px]">
                        {shownWebhookSecret === repository.id
                          ? repository.webhookSecret
                          : "••••••••••••••••••••••••••••••••"}
                      </code>
                      <div className="flex shrink-0 gap-1 self-end sm:self-start">
                        <Button
                          onClick={() =>
                            setShownWebhookSecret((current) =>
                              current === repository.id ? null : repository.id,
                            )
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {shownWebhookSecret === repository.id
                            ? t("settings:giteaIntegration.webhookHide")
                            : t("settings:giteaIntegration.webhookShow")}
                        </Button>
                        <Button
                          onClick={() =>
                            handleCopyWebhookSecret(repository.webhookSecret)
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {t("settings:giteaIntegration.webhookCopy")}
                        </Button>
                      </div>
                    </div>
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
                  {t("settings:giteaIntegration.commentTaskLinkTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings:giteaIntegration.commentTaskLinkHint")}
                </p>
              </div>
              <Switch
                checked={integration.commentTaskLinkOnGiteaIssue ?? true}
                disabled={isUpdatingSettings}
                onCheckedChange={async (checked) => {
                  try {
                    await updateGiteaSettings({
                      projectId,
                      json: { commentTaskLinkOnGiteaIssue: checked },
                    });
                    toast.success(
                      checked
                        ? t("settings:giteaIntegration.toast.commentOnEnabled")
                        : t(
                            "settings:giteaIntegration.toast.commentOnDisabled",
                          ),
                    );
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : t(
                            "settings:giteaIntegration.toast.settingsUpdateError",
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
                  {t("settings:giteaIntegration.addRepositoryTitle")}
                </DialogTitle>
                <DialogDescription>
                  {t("settings:giteaIntegration.addRepositoryHint")}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-5">
                <FormField
                  control={form.control}
                  name="baseUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {t("settings:giteaIntegration.baseUrlLabel")}
                      </FormLabel>
                      <FormControl>
                        <Input
                          disabled={isCreating}
                          placeholder="https://gitea.example.com"
                          type="url"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        {t("settings:giteaIntegration.baseUrlHint")}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="accessToken"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {t("settings:giteaIntegration.tokenLabel")}
                      </FormLabel>
                      <FormControl>
                        <Input
                          autoComplete="off"
                          disabled={isCreating}
                          placeholder={
                            canUseStoredCredential
                              ? t(
                                  "settings:giteaIntegration.tokenPlaceholderUpdate",
                                )
                              : t("settings:giteaIntegration.tokenPlaceholder")
                          }
                          type="password"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        {canUseStoredCredential &&
                        integration?.maskedAccessToken
                          ? t("settings:giteaIntegration.usingStoredToken", {
                              token: integration.maskedAccessToken,
                            })
                          : t("settings:giteaIntegration.tokenHint")}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  className="w-full justify-start"
                  disabled={
                    !baseUrl || (!accessToken.trim() && !canUseStoredCredential)
                  }
                  onClick={() => setShowRepositoryBrowser(true)}
                  type="button"
                  variant="outline"
                >
                  <GitBranch aria-hidden="true" className="size-4" />
                  {t("settings:giteaIntegration.browseRepositories")}
                </Button>

                <div className="relative flex items-center">
                  <Separator />
                  <span className="absolute left-1/2 -translate-x-1/2 bg-popover px-2 text-muted-foreground text-xs">
                    {t("settings:giteaIntegration.manualEntry")}
                  </span>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="repositoryOwner"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {t("settings:giteaIntegration.ownerLabel")}
                        </FormLabel>
                        <FormControl>
                          <Input
                            autoComplete="off"
                            disabled={isCreating}
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
                          {t("settings:giteaIntegration.repoNameLabel")}
                        </FormLabel>
                        <FormControl>
                          <Input
                            autoComplete="off"
                            disabled={isCreating}
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
                      verificationResult.result.isInstalled &&
                        verificationResult.result.hasRequiredPermissions
                        ? "border-success/25 bg-success/10"
                        : verificationResult.result.repositoryExists
                          ? "border-warning/25 bg-warning/10"
                          : "border-destructive/25 bg-destructive/10",
                    )}
                  >
                    {verificationResult.result.isInstalled &&
                    verificationResult.result.hasRequiredPermissions ? (
                      <CheckCircle className="mt-0.5 size-4 shrink-0 text-success-foreground" />
                    ) : verificationResult.result.repositoryExists ? (
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
                    ) : (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
                    )}
                    <p className="font-medium">
                      {verificationResult.result.message}
                    </p>
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
                    isCreating ||
                    isVerifying ||
                    !form.formState.isValid ||
                    (!accessToken.trim() && !canUseStoredCredential)
                  }
                  loading={isCreating || isVerifying}
                  type="submit"
                >
                  <Link aria-hidden="true" className="size-4" />
                  {t("settings:giteaIntegration.addRepository")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogPopup>
      </Dialog>

      <GiteaRepositoryBrowserModal
        excludedRepositories={repositories.map(
          (repository) => repository.fullPath,
        )}
        hasStoredCredential={canUseStoredCredential}
        open={showRepositoryBrowser}
        projectId={projectId}
        onOpenChange={setShowRepositoryBrowser}
        onSelectRepository={handleRepositorySelect}
        selectedRepository={
          repositoryOwner && repositoryName
            ? `${repositoryOwner}/${repositoryName}`
            : undefined
        }
        baseUrl={baseUrl}
        accessToken={accessToken}
      />
    </div>
  );
}
