import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadTurnStartBootstrap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  withSideChatWorktreeRemoval,
  assertSideChatBootstrapAllowed,
  assertWorktreeNotSharedWithSideChat,
} from "./SideChatWorkspaceGuard.ts";

import { WorktreeOperationGuard, layer as worktreeGuardLayer } from "./WorktreeOperationGuard.ts";

const parentThreadId = ThreadId.make("parent");
const createThread: NonNullable<ThreadTurnStartBootstrap["createThread"]> = {
  parentThreadId,
  projectId: ProjectId.make("project"),
  title: "UI side chat",
  modelSelection: { instanceId: ProviderInstanceId.make("claude-agent"), model: "claude-sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/repo/task",
  createdAt: "2026-09-11T12:00:00.000Z",
};

for (const resourceRequest of [
  { runSetupScript: true },
  { prepareWorktree: { projectCwd: "/repo", baseBranch: "main" } },
]) {
  it.effect(
    `rejects ${"runSetupScript" in resourceRequest ? "setup" : "worktree creation"} for new and existing children before mutations`,
    () =>
      Effect.gen(function* () {
        for (const input of [
          { bootstrap: { ...resourceRequest, createThread }, existing: null },
          { bootstrap: resourceRequest, existing: { parentThreadId } },
        ]) {
          let mutated = false;
          const failure = yield* assertSideChatBootstrapAllowed(
            input.bootstrap,
            input.existing,
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                mutated = true;
              }),
            ),
            Effect.flip,
          );
          expect(failure._tag).toBe("OrchestrationDispatchCommandError");
          expect(mutated).toBe(false);
        }
      }),
  );
}

it.effect("allows ordinary thread setup and child turns without checkout provisioning", () =>
  Effect.gen(function* () {
    yield* assertSideChatBootstrapAllowed(
      { prepareWorktree: { projectCwd: "/repo", baseBranch: "main" }, runSetupScript: true },
      null,
    );
    yield* assertSideChatBootstrapAllowed({ createThread }, null);
    yield* assertSideChatBootstrapAllowed({ runSetupScript: false }, { parentThreadId });
  }),
);

const paths = Layer.merge(
  FileSystem.layerNoop({
    realPath: (path) => Effect.succeed(path === "/alias/task" ? "/repo/task" : path),
  }),
  Path.layer,
);

it.effect("blocks forced removal through an alias while a saved child shares the checkout", () =>
  Effect.gen(function* () {
    let removed = false;
    const error = yield* assertWorktreeNotSharedWithSideChat(
      { cwd: "/repo", path: "/alias/task", force: true },
      [{ parentThreadId, worktreePath: "/repo/task" }],
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          removed = true;
        }),
      ),
      Effect.flip,
    );
    expect(error._tag).toBe("GitCommandError");
    expect(error.detail).toContain("Archived side chats");
    expect(removed).toBe(false);
  }).pipe(Effect.provide(paths)),
);

it.effect(
  "protects children supplied from the archived snapshot even without an active child",
  () =>
    Effect.gen(function* () {
      const active = [{ worktreePath: "/repo/task" }];
      const archived = [{ parentThreadId, worktreePath: "/repo/task" }];
      const error = yield* assertWorktreeNotSharedWithSideChat({ cwd: "/repo", path: "task" }, [
        ...active,
        ...archived,
      ]).pipe(Effect.flip);
      expect(error._tag).toBe("GitCommandError");
    }).pipe(Effect.provide(paths)),
);

it.effect("allows unrelated worktrees and checkouts without child references", () =>
  Effect.gen(function* () {
    yield* assertWorktreeNotSharedWithSideChat({ cwd: "/repo", path: "/repo/other" }, [
      { parentThreadId, worktreePath: "/repo/task" },
    ]);
    yield* assertWorktreeNotSharedWithSideChat({ cwd: "/repo", path: "/repo/task" }, [
      { worktreePath: "/repo/task" },
      { parentThreadId, worktreePath: null },
    ]);
  }).pipe(Effect.provide(paths)),
);

it.effect(
  "removal holds exclusive checkout ownership through the reference check and releases on failure",
  () =>
    Effect.gen(function* () {
      const operations = yield* WorktreeOperationGuard;
      const input = { cwd: "/repo", path: "task", force: true };
      yield* withSideChatWorktreeRemoval(
        input,
        Effect.gen(function* () {
          const result = yield* operations
            .withMutation(["/alias/task"], Effect.void)
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          return yield* Effect.fail("removal failed");
        }),
      ).pipe(Effect.flip);
      yield* operations.withMutation(
        ["/repo/task"],
        Effect.gen(function* () {
          const result = yield* withSideChatWorktreeRemoval(
            input,
            Effect.die("must not remove"),
          ).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
        }),
      );
      yield* withSideChatWorktreeRemoval(input, Effect.void);
    }).pipe(Effect.provide(worktreeGuardLayer.pipe(Layer.provideMerge(paths)))),
);
