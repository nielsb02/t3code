import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";
import { appAtomRegistry } from "./atom-registry";
import { projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";
import {
  resolveWorkspaceRepositoryFilter,
  resolveWorkspaceRepositoryPath,
  updateWorkspaceRepositorySelection,
  type WorkspaceRepositorySelection,
  resolveWorkspaceGitCwd,
} from "./workspace-repository-selection";

const EMPTY_REPOSITORIES = Object.freeze([]);
const selections = Atom.family((_key: string) =>
  Atom.make<WorkspaceRepositorySelection>({ path: null, diffPath: null }).pipe(Atom.keepAlive),
);

export function useWorkspaceRepositories() {
  const { selectedThread, selectedEnvironmentRuntime } = useThreadSelection();
  const { selectedThreadCwd: workspaceCwd, selectedThreadWorktreePath } =
    useSelectedThreadWorktree();
  const supported =
    selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.workspaceRepositories ===
    true;
  const query = useEnvironmentQuery(
    supported && selectedThread && workspaceCwd
      ? projectEnvironment.listRepositories({
          environmentId: selectedThread.environmentId,
          input: { cwd: workspaceCwd },
        })
      : null,
  );
  const selectionAtom = selections(
    JSON.stringify([selectedThread?.environmentId, selectedThread?.id, workspaceCwd]),
  );
  const selection = useAtomValue(selectionAtom);
  const selectedPath = selection.path;
  const selectRepository = useCallback(
    (path: string | null) =>
      appAtomRegistry.set(
        selectionAtom,
        updateWorkspaceRepositorySelection(appAtomRegistry.get(selectionAtom), path),
      ),
    [selectionAtom],
  );
  const repositories = query.data?.repositories ?? EMPTY_REPOSITORIES;
  const chosenPath = supported ? selectedPath : null;
  // A failed list leaves Git actions on the workspace unless a repository was chosen; only the
  // picker reports the failure.
  const gitRepositories = query.error ? EMPTY_REPOSITORIES : repositories;
  const gitPath = resolveWorkspaceRepositoryPath(chosenPath, gitRepositories);
  return {
    repositories,
    repositoryFilter: resolveWorkspaceRepositoryFilter(selection.diffPath, repositories),
    selectedPath: gitPath,
    selectRepository,
    selectedThreadCwd: resolveWorkspaceGitCwd(workspaceCwd, chosenPath, gitRepositories),
    selectedThreadWorktreePath,
    workspaceCwd,
    isChildRepository: gitPath !== ".",
    refreshRepositories: query.refresh,
    repositoryError: query.error,
  };
}
