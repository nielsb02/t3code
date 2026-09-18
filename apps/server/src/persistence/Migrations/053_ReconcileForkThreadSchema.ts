import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import migratePullRequests from "./050_ProjectionThreadPullRequests.ts";
import migrateParentThreads from "./050_ProjectionThreadsParent.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "parent_thread_id")) {
    yield* migrateParentThreads;
  }

  // Released fork databases recorded parent threads as migration 50, so the
  // ID-based runner skips upstream's migration 50 on those installations.
  const tables = yield* sql`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_thread_pull_requests'
  `;
  if (tables.length === 0) {
    yield* migratePullRequests;
  }
});
