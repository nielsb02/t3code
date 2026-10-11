import {
  GitCommandError,
  type OrchestrationV2ThreadShell,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const NAMED_THREADS_MAX = 3;

/**
 * Refuses to remove a worktree that an active thread still works in. A fork
 * shares its parent's checkout, so removing it with one thread can strand the
 * other. Pass active (not archived, not deleted) threads: an archived thread
 * recreates its checkout from its branch when it is resumed.
 */
export const refuseRemovingWorktreeInUse = Effect.fn("refuseRemovingWorktreeInUse")(function* (
  input: VcsRemoveWorktreeInput,
  activeThreads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "title" | "worktreePath">>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = (candidate: string) => {
    const absolute = path.resolve(input.cwd, candidate);
    return fs.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute));
  };
  const target = yield* canonical(input.path);
  const users: Array<string> = [];
  for (const thread of activeThreads) {
    if (thread.worktreePath === null) continue;
    if ((yield* canonical(thread.worktreePath)) === target) users.push(thread.title);
  }
  if (users.length === 0) return;
  const named = users.slice(0, NAMED_THREADS_MAX).map((title) => JSON.stringify(title));
  const more = users.length - named.length;
  return yield* new GitCommandError({
    operation: "removeWorktree",
    command: "git worktree remove",
    cwd: input.cwd,
    detail: `This worktree is still used by ${[...named, ...(more > 0 ? [`${more} more`] : [])].join(", ")}. Archive or delete ${users.length === 1 ? "that thread" : "those threads"} first.`,
  });
});
