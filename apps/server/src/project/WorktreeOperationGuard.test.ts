import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { layer, WorktreeOperationGuard } from "./WorktreeOperationGuard.ts";

const testLayer = layer.pipe(
  Layer.provide(
    FileSystem.layerNoop({
      realPath: (cwd) => Effect.succeed(cwd === "/alias/task" ? "/repo/task" : cwd),
    }),
  ),
  Layer.provide(Path.layer),
);

it.effect("cleanup rejects mutations through aliases while unrelated checkouts continue", () =>
  Effect.gen(function* () {
    const guard = yield* WorktreeOperationGuard;
    const release = yield* guard.tryAcquireCleanup("/repo/task");
    expect(release).not.toBeNull();
    expect(yield* guard.tryAcquireCleanup("/alias/task")).toBeNull();
    let ran = false;
    const rejected = yield* guard
      .withMutation(
        ["/alias/task"],
        Effect.sync(() => {
          ran = true;
        }),
      )
      .pipe(Effect.flip);
    expect(rejected._tag).toBe("WorktreeCleanupBusyError");
    expect(ran).toBe(false);
    expect(yield* guard.withMutation(["/repo/other"], Effect.succeed("finished"))).toBe("finished");
    release!();
    const releaseAgain = yield* guard.tryAcquireCleanup("/alias/task");
    expect(releaseAgain).not.toBeNull();
    release!();
    expect(yield* guard.tryAcquireCleanup("/repo/task")).toBeNull();
    releaseAgain!();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("cleanup skips prior mutations until all nested operations release", () =>
  Effect.gen(function* () {
    const guard = yield* WorktreeOperationGuard;
    yield* guard.withMutation(
      ["/repo/task", "/alias/task"],
      Effect.gen(function* () {
        expect(yield* guard.tryAcquireCleanup("/alias/task")).toBeNull();
        const unrelated = yield* guard.tryAcquireCleanup("/repo/other");
        expect(unrelated).not.toBeNull();
        unrelated!();
        yield* guard.withMutation(["/repo/task"], Effect.void);
        expect(yield* guard.tryAcquireCleanup("/repo/task")).toBeNull();
      }),
    );
    const release = yield* guard.tryAcquireCleanup("/repo/task");
    expect(release).not.toBeNull();
    release!();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("failed multi-checkout acquisition leaves no partial mutation lease", () =>
  Effect.gen(function* () {
    const guard = yield* WorktreeOperationGuard;
    const releaseBusy = yield* guard.tryAcquireCleanup("/repo/busy");
    yield* guard.withMutation(["/repo/free", "/repo/busy"], Effect.void).pipe(Effect.flip);
    const releaseFree = yield* guard.tryAcquireCleanup("/repo/free");
    expect(releaseFree).not.toBeNull();
    releaseFree!();
    releaseBusy!();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("mutation failure and interruption both release ownership", () =>
  Effect.gen(function* () {
    const guard = yield* WorktreeOperationGuard;
    expect(yield* guard.withMutation(["/repo/task"], Effect.fail("failed")).pipe(Effect.flip)).toBe(
      "failed",
    );
    const afterFailure = yield* guard.tryAcquireCleanup("/repo/task");
    expect(afterFailure).not.toBeNull();
    afterFailure!();

    const entered = yield* Deferred.make<void>();
    const mutation = yield* guard
      .withMutation(
        ["/repo/task"],
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect(yield* guard.tryAcquireCleanup("/repo/task")).toBeNull();
    yield* Fiber.interrupt(mutation);
    const afterInterrupt = yield* guard.tryAcquireCleanup("/repo/task");
    expect(afterInterrupt).not.toBeNull();
    afterInterrupt!();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("missing paths use normalized absolute paths for both kinds of ownership", () =>
  Effect.gen(function* () {
    const guard = yield* WorktreeOperationGuard;
    yield* guard.withMutation(
      ["/repo/missing/../task"],
      Effect.gen(function* () {
        expect(yield* guard.tryAcquireCleanup("/repo/task")).toBeNull();
      }),
    );
  }).pipe(
    Effect.provide(layer.pipe(Layer.provide(FileSystem.layerNoop({})), Layer.provide(Path.layer))),
  ),
);
