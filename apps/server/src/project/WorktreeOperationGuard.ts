import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class WorktreeCleanupBusyError extends Schema.TaggedErrorClass<WorktreeCleanupBusyError>()(
  "WorktreeCleanupBusyError",
  { cwd: Schema.String },
) {
  override get message() {
    return `A manual settle action is running in ${this.cwd}. Wait for it to finish before changing the checkout.`;
  }
}

export class WorktreeOperationGuard extends Context.Service<
  WorktreeOperationGuard,
  {
    readonly withMutation: <A, E, R>(
      cwds: readonly string[],
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | WorktreeCleanupBusyError, R>;
    /** Reserve before launching cleanup; null means an operation already owns this checkout. */
    readonly tryAcquireCleanup: (cwd: string) => Effect.Effect<(() => void) | null>;
  }
>()("t3/project/WorktreeOperationGuard") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const operations = new Map<string, { mutations: number; cleanup: boolean }>();
  const canonicalize = (cwd: string) =>
    fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));

  const acquireMutation = Effect.fn("WorktreeOperationGuard.acquireMutation")(function* (
    cwds: readonly string[],
  ) {
    const canonicalPaths = new Set(yield* Effect.forEach(cwds, canonicalize));
    for (const cwd of canonicalPaths) {
      if (operations.get(cwd)?.cleanup) return yield* new WorktreeCleanupBusyError({ cwd });
    }
    for (const cwd of canonicalPaths) {
      const state = operations.get(cwd) ?? { mutations: 0, cleanup: false };
      state.mutations++;
      operations.set(cwd, state);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const cwd of canonicalPaths) {
        const state = operations.get(cwd)!;
        if (--state.mutations === 0) operations.delete(cwd);
      }
    };
  });

  const tryAcquireCleanup = Effect.fn("WorktreeOperationGuard.tryAcquireCleanup")(function* (
    cwd: string,
  ) {
    const canonical = yield* canonicalize(cwd);
    if (operations.has(canonical)) return null;
    const state = { mutations: 0, cleanup: true };
    operations.set(canonical, state);
    return () => {
      if (operations.get(canonical) === state) operations.delete(canonical);
    };
  });

  return WorktreeOperationGuard.of({
    withMutation: (cwds, effect) =>
      Effect.acquireUseRelease(
        acquireMutation(cwds),
        () => effect,
        (release) => Effect.sync(release),
      ),
    tryAcquireCleanup,
  });
});

export const layer = Layer.effect(WorktreeOperationGuard, make);
