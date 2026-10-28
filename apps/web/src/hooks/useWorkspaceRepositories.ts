import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, WorkspaceRepository } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";
import { projectEnvironment } from "../state/projects";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../state/query";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  defaultWorkspaceRepositoryPath,
  resolveWorkspaceGitCwd,
  selectWorkspaceRepository,
  updateWorkspaceRepositorySelection,
} from "../lib/workspaceRepositories";
import { useWorkspaceMutationRefresh } from "./useWorkspaceMutationRefresh";

const EMPTY_REPOSITORIES: readonly WorkspaceRepository[] = [];

export function useWorkspaceRepositories(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  mutationId: string | null;
  enabled: boolean;
}) {
  const { environmentId, cwd, mutationId, enabled } = input;
  const query = useEnvironmentQuery(
    enabled && environmentId !== null && cwd !== null
      ? projectEnvironment.listRepositories({ environmentId, input: { cwd } })
      : null,
  );
  const repositories = query.data?.repositories ?? EMPTY_REPOSITORIES;
  const scope = JSON.stringify([environmentId, cwd]);
  const [selection, setSelection] = useState<{
    scope: string;
    path: string | null;
    diffPath: string | null;
  } | null>(null);
  const selectedPath = selection?.scope === scope ? selection.path : null;
  const selectedRepository = selectWorkspaceRepository(repositories, selectedPath);
  // A failed list leaves Git actions on the workspace unless a repository was chosen; only the
  // picker reports the failure.
  const gitRepositories = query.error ? EMPTY_REPOSITORIES : repositories;
  const selectRepository = (path: string | null) => {
    setSelection((current) => ({
      scope,
      ...updateWorkspaceRepositorySelection(current?.scope === scope ? current : null, path),
    }));
  };
  const statusTargets = (() =>
    environmentId === null
      ? []
      : repositories
          .filter((repository) => repository.available)
          .map((repository) => ({
            repository,
            atom: vcsEnvironment.status({ environmentId, input: { cwd: repository.cwd } }),
          })))();
  const statusesAtom = (() =>
    Atom.make((get) =>
      statusTargets.map(({ repository, atom }) => {
        const result = get(atom);
        return {
          repository,
          status: Option.getOrNull(AsyncResult.value(result)),
          error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
          isPending: result.waiting,
        };
      }),
    ))();
  const statuses = useAtomValue(statusesAtom);
  const refreshRepositories = query.refresh;
  const refresh = () => {
    refreshRepositories();
    for (const { atom } of statusTargets) appAtomRegistry.refresh(atom);
  };
  useWorkspaceMutationRefresh({
    enabled: cwd !== null,
    mutationId,
    refresh,
    resourceKey: `repositories:${scope}`,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes repository queries when the browser window regains focus
  useEffect(() => {
    if (cwd === null) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [cwd, refresh]);
  return {
    repositories,
    statuses,
    selectedRepository,
    /** The repository Git actions target, chosen or default; `.` is the workspace. */
    gitRepositoryPath: selectedPath ?? defaultWorkspaceRepositoryPath(gitRepositories),
    gitCwd: resolveWorkspaceGitCwd(cwd, selectedPath, gitRepositories),
    selectRepository,
    repositoryFilter: selection?.scope === scope ? selection.diffPath : null,
    refresh,
    error: query.error,
    isPending: query.isPending,
  };
}
