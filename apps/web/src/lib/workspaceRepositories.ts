interface RepositoryChoice {
  readonly path: string;
  readonly available: boolean;
}

/**
 * The repository Git actions use until one is chosen: the workspace itself, or its first
 * available repository when discovery found the workspace is not a Git repository. Mobile's
 * workspace-repository-selection follows the same rule.
 */
export function defaultWorkspaceRepositoryPath(repositories: readonly RepositoryChoice[]): string {
  const root = repositories.find((repository) => repository.path === ".");
  if (root === undefined || root.available) return ".";
  return repositories.find((repository) => repository.available)?.path ?? ".";
}

export function selectWorkspaceRepository<T extends RepositoryChoice>(
  repositories: readonly T[],
  selectedPath: string | null,
): T | null {
  const path = selectedPath ?? defaultWorkspaceRepositoryPath(repositories);
  return (
    repositories.find((repository) => repository.path === path && repository.available) ?? null
  );
}

/**
 * Where Git actions run. The workspace keeps its own path, so the target stays put while
 * discovery loads or fails; a chosen repository that is gone yields no target rather than another.
 */
export function resolveWorkspaceGitCwd(
  workspaceCwd: string | null,
  selectedPath: string | null,
  repositories: readonly (RepositoryChoice & { readonly cwd: string })[],
): string | null {
  const path = selectedPath ?? defaultWorkspaceRepositoryPath(repositories);
  if (path === ".") return workspaceCwd;
  return (
    repositories.find((repository) => repository.path === path && repository.available)?.cwd ?? null
  );
}

export function updateWorkspaceRepositorySelection(
  current: { path: string | null; diffPath: string | null } | null,
  path: string | null,
) {
  return { path: path ?? current?.path ?? null, diffPath: path };
}
