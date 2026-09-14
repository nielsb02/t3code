import {
  GitCommandError,
  OrchestrationDispatchCommandError,
  type OrchestrationThreadShell,
  type ThreadTurnStartBootstrap,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { WorktreeOperationGuard } from "./WorktreeOperationGuard.ts";

/** Reserve cleanup before reading saved references so a side-chat bootstrap cannot race removal. */
export const withSideChatWorktreeRemoval = <A, E, R>(
  input: VcsRemoveWorktreeInput,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const operations = yield* WorktreeOperationGuard;
    return yield* Effect.acquireUseRelease(
      operations.tryAcquireCleanup(path.resolve(input.cwd, input.path)),
      (release): Effect.Effect<A, E | GitCommandError, R> =>
        release
          ? effect
          : Effect.fail(
              new GitCommandError({
                operation: "removeWorktree",
                command: "git worktree remove",
                cwd: input.cwd,
                detail:
                  "This checkout has an operation in progress. Wait for it to finish before removing it.",
              }),
            ),
      (release) => Effect.sync(() => release?.()),
    );
  });

export const assertSideChatBootstrapAllowed = Effect.fn("assertSideChatBootstrapAllowed")(
  function* (
    bootstrap: ThreadTurnStartBootstrap,
    existingThread: Pick<OrchestrationThreadShell, "parentThreadId"> | null,
  ) {
    if (
      (bootstrap.prepareWorktree || bootstrap.runSetupScript) &&
      (bootstrap.createThread?.parentThreadId || existingThread?.parentThreadId)
    ) {
      return yield* new OrchestrationDispatchCommandError({
        message:
          "Side chats share their parent's checkout. Worktree creation and setup scripts are not supported for side chats.",
      });
    }
  },
);

export const assertWorktreeNotSharedWithSideChat = Effect.fn("assertWorktreeNotSharedWithSideChat")(
  function* (
    input: VcsRemoveWorktreeInput,
    threads: ReadonlyArray<Pick<OrchestrationThreadShell, "parentThreadId" | "worktreePath">>,
  ) {
    const children = threads.filter((thread) => thread.parentThreadId && thread.worktreePath);
    if (children.length === 0) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalize = (candidate: string) => {
      const absolute = path.resolve(input.cwd, candidate);
      return fs.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute));
    };
    const target = yield* canonicalize(input.path);
    for (const child of children) {
      if (child.worktreePath && (yield* canonicalize(child.worktreePath)) === target) {
        return yield* new GitCommandError({
          operation: "removeWorktree",
          command: "git worktree remove",
          cwd: input.cwd,
          detail:
            "This checkout is shared with a saved side chat. Delete its side chats before removing the worktree. Archived side chats also keep their checkout.",
        });
      }
    }
  },
);
