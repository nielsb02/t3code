import type { WorkspaceRepository, VcsStatusResult } from "@t3tools/contracts";
import { FolderGit2Icon } from "lucide-react";

import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./chat/threadDetailsPanelStyles";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

/** Picks the repository Git actions target when a checkout declares several. */
export function WorkspaceRepositorySelector({
  repositories,
  statuses,
  selectedPath,
  onSelect,
}: {
  repositories: readonly WorkspaceRepository[];
  statuses: readonly {
    repository: WorkspaceRepository;
    status: VcsStatusResult | null;
    error: string | null;
  }[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (repositories.length === 0 || (repositories.length === 1 && selectedPath !== null))
    return null;
  const statusesByPath = new Map(statuses.map((entry) => [entry.repository.path, entry]));
  const selected = repositories.find((repository) => repository.path === selectedPath);
  return (
    <Menu>
      <MenuTrigger
        render={<ThreadDetailsControl part="select" />}
        className="min-w-0 max-w-full"
        aria-label="Git repository"
      >
        <FolderGit2Icon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="min-w-0 truncate">{selected?.name ?? "Select repository"}</span>
      </MenuTrigger>
      <MenuPopup align="start">
        {repositories.map((repository) => {
          const state = statusesByPath.get(repository.path);
          return (
            <MenuItem
              key={repository.path}
              disabled={!repository.available}
              onClick={() => onSelect(repository.path)}
            >
              <span className="min-w-0 flex-1 truncate">
                {repository.name}
                {repository.kind === "root" ? " (workspace)" : ""}
              </span>
              <span className="ml-3 text-xs text-muted-foreground">
                {repositoryStatusLabel(
                  repository.available,
                  state?.status ?? null,
                  state?.error ?? null,
                )}
              </span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

function repositoryStatusLabel(
  available: boolean,
  status: VcsStatusResult | null,
  error: string | null,
): string {
  if (!available) return "Unavailable";
  if (error) return "Status unavailable";
  if (status) return `${status.refName ?? "Detached"} · ${status.workingTree.files.length}`;
  return "Loading…";
}
