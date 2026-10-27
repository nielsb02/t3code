import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { useCallback, useMemo } from "react";
import { appAtomRegistry } from "../../state/atom-registry";
import { lastReviewGitSectionsAtom, reviewEnvironment } from "../../state/review";

export function useWorkspaceReviewSources(
  environmentId: EnvironmentId | undefined,
  repositories: readonly { path: string; cwd: string; available: boolean }[],
  enabled: boolean,
) {
  const queries = useMemo(
    () =>
      environmentId && enabled
        ? repositories
            .filter((repository) => repository.available)
            .map((repository) => ({
              repository,
              lastSections: lastReviewGitSectionsAtom(environmentId, repository.cwd),
              atom: reviewEnvironment.diffPreview({
                environmentId,
                input: { cwd: repository.cwd },
              }),
            }))
        : [],
    [environmentId, repositories, enabled],
  );
  const aggregate = useMemo(
    () =>
      Atom.make((get) =>
        queries.map(({ repository, atom, lastSections }) => ({
          repository,
          result: get(atom),
          lastSections: get(lastSections),
        })),
      ),
    [queries],
  );
  const results = useAtomValue(aggregate);
  const entries = useMemo(
    () =>
      results.flatMap(({ repository, result, lastSections }) => {
        const data = Option.getOrNull(AsyncResult.value(result));
        return (data?.sources ?? lastSections).map((source) => ({ repository, source }));
      }),
    [results],
  );
  const failure = results.find(({ result }) => AsyncResult.isFailure(result));
  const error =
    failure && AsyncResult.isFailure(failure.result)
      ? `${failure.repository.path}: ${String(Cause.squash(failure.result.cause))}`
      : null;
  const refresh = useCallback(() => {
    for (const { atom } of queries) appAtomRegistry.refresh(atom);
  }, [queries]);
  return {
    entries,
    error,
    // Every repository has answered once, so an empty list means no changes rather than loading.
    hasData: results.length > 0 && results.every(({ result }) => result._tag !== "Initial"),
    isPending: results.some(({ result }) => result._tag === "Initial" || result.waiting),
    refresh,
  };
}
