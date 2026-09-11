import type { WorkspaceRepository } from "@t3tools/contracts";

export function resolveWorkspaceGitCwd(
  workspaceCwd: string | null,
  selectedPath: string | null,
  repositories: readonly Pick<WorkspaceRepository, "path" | "cwd" | "available">[],
): string | null {
  if (selectedPath === null || selectedPath === ".") return workspaceCwd;
  return (
    repositories.find((repository) => repository.path === selectedPath && repository.available)
      ?.cwd ?? null
  );
}
