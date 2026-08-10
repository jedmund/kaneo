import { useQuery } from "@tanstack/react-query";
import { ExternalLink, GitBranch, Lock, Search } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import listGiteaRepositories, {
  type ListGiteaRepositoriesResponse,
} from "@/fetchers/gitea-integration/list-gitea-repositories";
import { cn } from "@/lib/cn";

type GiteaRepositoryBrowserModalProps = {
  baseUrl: string;
  accessToken?: string;
  excludedRepositories?: string[];
  hasStoredCredential?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectRepository: (repository: { owner: string; name: string }) => void;
  open: boolean;
  projectId: string;
  selectedRepository?: string;
};

export function GiteaRepositoryBrowserModal({
  accessToken = "",
  baseUrl,
  excludedRepositories = [],
  hasStoredCredential = false,
  onOpenChange,
  onSelectRepository,
  open,
  projectId,
  selectedRepository,
}: GiteaRepositoryBrowserModalProps) {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = React.useState("");

  const canFetch =
    open &&
    baseUrl.trim().length > 0 &&
    (accessToken.trim().length > 0 || hasStoredCredential);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [
      "gitea-repositories",
      projectId,
      baseUrl,
      accessToken.trim() ? "provided-token" : "stored-token",
    ],
    queryFn: () =>
      listGiteaRepositories({
        projectId,
        baseUrl,
        ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
      }),
    enabled: canFetch,
  });

  const availableRepositories = React.useMemo(() => {
    if (!data?.repositories) return [];

    const excluded = new Set(
      excludedRepositories.map((repository) => repository.toLowerCase()),
    );
    return data.repositories.filter(
      (repository) => !excluded.has(repository.full_name.toLowerCase()),
    );
  }, [data?.repositories, excludedRepositories]);

  const filteredRepositories = React.useMemo(() => {
    if (!searchTerm) return availableRepositories;

    const search = searchTerm.toLowerCase();
    return availableRepositories.filter((repo) =>
      repo.full_name.toLowerCase().includes(search),
    );
  }, [availableRepositories, searchTerm]);

  const handleSelectRepository = (
    repository: ListGiteaRepositoriesResponse["repositories"][number],
  ) => {
    onSelectRepository({
      owner: repository.owner.login,
      name: repository.name,
    });
    resetAndCloseModal(false);
  };

  const resetAndCloseModal = (next: boolean) => {
    if (!next) {
      setSearchTerm("");
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={resetAndCloseModal}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch aria-hidden="true" className="size-5" />
            {t("settings:giteaIntegration.browseModalTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("settings:giteaIntegration.browseModalHint")}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="pl-9"
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={t("settings:giteaIntegration.searchRepos")}
              type="search"
              value={searchTerm}
            />
          </div>

          <div className="min-h-48 rounded-md border border-border p-2">
            {!canFetch && (
              <p className="py-8 text-center text-muted-foreground text-sm">
                {t("settings:giteaIntegration.browseNeedsCredentials")}
              </p>
            )}
            {canFetch && isLoading && (
              <p className="py-8 text-center text-muted-foreground text-sm">
                {t("settings:giteaIntegration.loadingRepos")}
              </p>
            )}
            {canFetch && error && (
              <div className="space-y-2 py-6 text-center">
                <p className="text-destructive text-sm">
                  {error instanceof Error ? error.message : "Error"}
                </p>
                <Button
                  onClick={() => refetch()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {t("settings:giteaIntegration.retry")}
                </Button>
              </div>
            )}
            {canFetch && data && data.repositories.length === 0 && (
              <p className="py-8 text-center text-muted-foreground text-sm">
                {t("settings:giteaIntegration.noBrowseRepositories")}
              </p>
            )}
            {canFetch &&
              data &&
              data.repositories.length > 0 &&
              availableRepositories.length === 0 && (
                <p className="py-8 text-center text-muted-foreground text-sm">
                  {t("settings:giteaIntegration.allRepositoriesAttached")}
                </p>
              )}
            {canFetch && data && filteredRepositories.length > 0 && (
              <ul className="space-y-1">
                {filteredRepositories.map((repo) => (
                  <li className="flex items-center gap-2" key={repo.id}>
                    <button
                      className={cn(
                        "flex flex-1 items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted/80",
                        selectedRepository === repo.full_name && "bg-muted",
                      )}
                      onClick={() => handleSelectRepository(repo)}
                      type="button"
                    >
                      <span className="truncate font-medium">
                        {repo.full_name}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {repo.private ? (
                          <Lock
                            aria-hidden="true"
                            className="size-3.5 text-muted-foreground"
                          />
                        ) : null}
                        <Badge className="text-xs" variant="secondary">
                          {repo.owner.login}
                        </Badge>
                      </span>
                    </button>
                    <a
                      aria-label={t(
                        "settings:giteaIntegration.openRepository",
                        { repository: repo.full_name },
                      )}
                      className="rounded-md p-2 text-primary transition-colors hover:bg-muted/80"
                      href={repo.html_url}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <ExternalLink aria-hidden="true" className="size-3.5" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {canFetch &&
              data &&
              availableRepositories.length > 0 &&
              filteredRepositories.length === 0 && (
                <p className="py-8 text-center text-muted-foreground text-sm">
                  {t("settings:giteaIntegration.noRepositoryMatches")}
                </p>
              )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
