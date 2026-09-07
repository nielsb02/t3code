import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorktreeOperationGuard from "../project/WorktreeOperationGuard.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";

const worktreeGuardLayer = WorktreeOperationGuard.layer.pipe(
  Layer.provide(FileSystem.layerNoop({ realPath: (cwd) => Effect.succeed(cwd) })),
  Layer.provide(Path.layer),
);

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(worktreeGuardLayer),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("worktree removal and creation reject cleanup ownership before invoking Git", () => {
    const removed: string[] = [];
    const registryLayer = Layer.effect(
      VcsDriverRegistry.VcsDriverRegistry,
      Effect.gen(function* () {
        const driver = yield* VcsDriver.VcsDriver;
        return VcsDriverRegistry.VcsDriverRegistry.of({
          get: () => Effect.succeed(driver),
          detect: () => Effect.succeed(null),
          resolve: ({ cwd }) =>
            Effect.gen(function* () {
              return {
                kind: "git" as const,
                driver,
                repository: {
                  kind: "git" as const,
                  rootPath: cwd,
                  metadataPath: null,
                  freshness: {
                    source: "live-local" as const,
                    observedAt: yield* DateTime.now,
                    expiresAt: Option.none(),
                  },
                },
              };
            }),
        });
      }),
    ).pipe(
      Layer.provide(
        Layer.mock(VcsDriver.VcsDriver)({
          capabilities: {
            kind: "git",
            supportsWorktrees: true,
            supportsBookmarks: false,
            supportsAtomicSnapshot: false,
            supportsPushDefaultRemote: true,
            ignoreClassifier: "git-compatible-fallback",
          },
        }),
      ),
    );
    const mutationLayer = GitWorkflowService.layer.pipe(
      Layer.provide(registryLayer),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          removeWorktree: ({ path }) =>
            Effect.sync(() => {
              removed.push(path);
            }),
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provideMerge(worktreeGuardLayer),
    );
    return Effect.gen(function* () {
      const guard = yield* WorktreeOperationGuard.WorktreeOperationGuard;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const release = yield* guard.tryAcquireCleanup("/repo/task");
      const removeError = yield* workflow
        .removeWorktree({ cwd: "/repo", path: "/repo/task", force: true })
        .pipe(Effect.flip);
      expect(removeError).toMatchObject({
        _tag: "GitCommandError",
        detail: expect.stringContaining("manual settle action"),
      });
      const createError = yield* workflow
        .createWorktree({ cwd: "/repo", refName: "main", path: "/repo/task" })
        .pipe(Effect.flip);
      expect(createError).toMatchObject({
        _tag: "GitCommandError",
        detail: expect.stringContaining("manual settle action"),
      });
      expect(removed).toEqual([]);
      yield* workflow.removeWorktree({ cwd: "/repo", path: "/repo/unrelated", force: true });
      release!();
      yield* workflow.removeWorktree({ cwd: "/repo", path: "/repo/task", force: true });
      expect(removed).toEqual(["/repo/unrelated", "/repo/task"]);
    }).pipe(Effect.provide(mutationLayer));
  });

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(worktreeGuardLayer),
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });
});
