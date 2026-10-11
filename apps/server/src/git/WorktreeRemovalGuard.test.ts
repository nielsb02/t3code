import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { refuseRemovingWorktreeInUse } from "./WorktreeRemovalGuard.ts";

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-guard-" });
  const worktree = path.join(root, "worktrees", "feature");
  yield* fs.makeDirectory(worktree, { recursive: true });
  // Another spelling of the same checkout, as a thread may have recorded it.
  const alias = path.join(root, "alias");
  yield* fs.symlink(worktree, alias);
  return { root, worktree, alias };
});

it.effect("refuses to remove a worktree that an active thread still uses, naming it", () =>
  Effect.gen(function* () {
    const { root, alias } = yield* workspace;
    const error = yield* Effect.flip(
      refuseRemovingWorktreeInUse({ cwd: root, path: "worktrees/feature", force: true }, [
        { title: "Unrelated", worktreePath: null },
        { title: "Fix login fork", worktreePath: alias },
      ]),
    );
    assert.equal(error._tag, "GitCommandError");
    assert.include(error.detail, `still used by "Fix login fork". Archive or delete that thread`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("names a few of the threads and counts the rest", () =>
  Effect.gen(function* () {
    const { root, worktree } = yield* workspace;
    const error = yield* Effect.flip(
      refuseRemovingWorktreeInUse(
        { cwd: root, path: worktree },
        ["One", "Two", "Three", "Four", "Five"].map((title) => ({ title, worktreePath: worktree })),
      ),
    );
    assert.include(error.detail, `"One", "Two", "Three", 2 more. Archive or delete those threads`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("allows removing a worktree no active thread uses", () =>
  Effect.gen(function* () {
    const { root, worktree } = yield* workspace;
    yield* refuseRemovingWorktreeInUse({ cwd: root, path: worktree }, [
      { title: "Main checkout", worktreePath: root },
      { title: "Elsewhere", worktreePath: `${root}/worktrees/other` },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
