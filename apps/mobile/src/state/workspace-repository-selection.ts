import type { WorkspaceRepository } from "@t3tools/contracts";

/**
 * The repository Git actions use until one is chosen: the workspace itself, or its first
 * available repository when discovery found the workspace is not a Git repository. The web
 * client's workspaceRepositories follows the same rule.
 */
export function resolveWorkspaceRepositoryPath(
  selectedPath: string | null,
  repositories: readonly Pick<WorkspaceRepository, "path" | "available">[],
): string {
  if (selectedPath !== null) return selectedPath;
  const root = repositories.find((repository) => repository.path === ".");
  if (root === undefined || root.available) return ".";
  return repositories.find((repository) => repository.available)?.path ?? ".";
}

/**
 * Where Git actions run. The workspace keeps its own path, so the target stays put while
 * discovery loads or fails; a chosen repository that is gone yields no target rather than another.
 */
export function resolveWorkspaceGitCwd(
  workspaceCwd: string | null,
  selectedPath: string | null,
  repositories: readonly Pick<WorkspaceRepository, "path" | "cwd" | "available">[],
): string | null {
  const path = resolveWorkspaceRepositoryPath(selectedPath, repositories);
  if (path === ".") return workspaceCwd;
  return (
    repositories.find((repository) => repository.path === path && repository.available)?.cwd ?? null
  );
}

export interface WorkspaceRepositorySelection {
  readonly path: string | null;
  readonly diffPath: string | null;
}

export function updateWorkspaceRepositorySelection(
  current: WorkspaceRepositorySelection,
  path: string | null,
): WorkspaceRepositorySelection {
  return { path: path ?? current.path, diffPath: path };
}

export function resolveWorkspaceRepositoryFilter(
  selectedPath: string | null,
  repositories: readonly Pick<WorkspaceRepository, "path" | "available">[],
): string | null {
  return repositories.some((repository) => repository.path === selectedPath && repository.available)
    ? selectedPath
    : null;
}
