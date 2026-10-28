import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";
import type { WorkspaceDiffRepository } from "../lib/workspaceDiff";
import { formatEnvironmentQueryError } from "../state/query";
import { reviewEnvironment } from "../state/review";
import { revisionedQuery } from "../state/revisionedQuery";

export function useWorkspaceDiff(
  environmentId: EnvironmentId | null,
  repositories: readonly WorkspaceDiffRepository[],
  baseRefs: Readonly<Record<string, string | null>>,
  ignoreWhitespace: boolean,
  mutationId?: string | null,
) {
  const registry = useContext(RegistryContext);
  const queries = (() =>
    environmentId
      ? repositories
          .filter((repo) => repo.available)
          .map((repository) => {
            const baseRef = baseRefs[repository.cwd];
            return {
              repository,
              atom: revisionedQuery(
                reviewEnvironment.diffPreview({
                  environmentId,
                  input: {
                    cwd: repository.cwd,
                    ...(baseRef ? { baseRef } : {}),
                    ignoreWhitespace,
                  },
                }),
                mutationId,
              ),
            };
          })
      : [])();
  const collection = (() =>
    Atom.make((get) =>
      queries.map(({ repository, atom }) => {
        const result = get(atom);
        return {
          repository,
          data: Option.getOrNull(AsyncResult.value(result)),
          dataUpdatedAt:
            result._tag === "Success"
              ? result.timestamp
              : result._tag === "Failure"
                ? (Option.getOrNull(result.previousSuccess)?.timestamp ?? 0)
                : 0,
          error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
          isPending: result._tag === "Initial" || result.waiting,
        };
      }),
    ))();
  const results = useAtomValue(collection);
  const refresh = () => {
    for (const { atom } of queries) registry.refresh(atom);
  };
  return { results, refresh };
}
