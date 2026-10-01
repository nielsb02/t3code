import * as Effect from "effect/Effect";
import migrateForkThreads from "./053_ReconcileForkThreadSchema.ts";
import migrateFilesViewed from "./053_PullRequestFilesViewed.ts";

// Released fork databases used ID 53 for thread reconciliation. Upstream databases
// used it for viewed files. Reconcile both shapes after the shared migration IDs.
export default Effect.gen(function* () {
  yield* migrateForkThreads;
  yield* migrateFilesViewed;
});
