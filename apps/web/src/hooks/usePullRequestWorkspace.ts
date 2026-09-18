import type { ScopedThreadRef, WorkspaceRepository } from "@t3tools/contracts";

import { useProjects, useServerConfigs, useThreadShell } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";

const EMPTY_REPOSITORIES: readonly WorkspaceRepository[] = [];

/** Shares the active checkout's discovery query with the Git and workspace PR panels. */
export function usePullRequestWorkspace(threadRef: ScopedThreadRef | null | undefined) {
  const thread = useThreadShell(threadRef ?? null);
  const projects = useProjects();
  const configs = useServerConfigs();
  const project =
    threadRef && thread
      ? projects.find(
          (candidate) =>
            candidate.environmentId === threadRef.environmentId &&
            candidate.id === thread.projectId,
        )
      : undefined;
  const capabilities = threadRef
    ? configs.get(threadRef.environmentId)?.environment.capabilities
    : undefined;
  const cwd = thread?.worktreePath ?? project?.workspaceRoot;
  const query = useEnvironmentQuery(
    project && cwd && capabilities?.workspacePullRequestLinks
      ? projectEnvironment.listRepositories({
          environmentId: project.environmentId,
          input: { cwd },
        })
      : null,
  );
  return { project, repositories: query.data?.repositories ?? EMPTY_REPOSITORIES };
}
