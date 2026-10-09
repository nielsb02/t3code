import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import ProjectionThreadPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";

// Released Micro fork builds recorded their own migrations under upstream ids.
// The migrator skips every id at or below the recorded maximum, so the fork's
// 55 would mask upstream's OrchestrationV2 forever. Apply the upstream schema
// those ids stand for (each is idempotent), record the upstream names, and drop
// the fork-only 55 so upstream's 55 and later run normally.
const forkRows = new Map([
  [50, "ProjectionThreadsParent"],
  [53, "ReconcileForkThreadSchema"],
  [55, "ReconcileForkReleaseSchema"],
]);

const upstreamRows = new Map([
  [50, { name: "ProjectionThreadPullRequests", migration: ProjectionThreadPullRequests }],
  [53, { name: "PullRequestFilesViewed", migration: PullRequestFilesViewed }],
]);

export const reconcileForkMigrationLedger = Effect.fn("reconcileForkMigrationLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id IN (50, 53, 55)
        `;
      const forkHistory = history.filter((row) => forkRows.get(row.migration_id) === row.name);
      const executed: Array<readonly [number, string]> = [];
      for (const row of forkHistory) {
        const upstream = upstreamRows.get(row.migration_id);
        if (upstream === undefined) {
          // The fork's 55 created upstream 53's table; make sure it exists
          // before the ids it shadowed run.
          yield* PullRequestFilesViewed;
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migration_id}`;
          continue;
        }
        yield* upstream.migration;
        yield* sql`
            UPDATE effect_sql_migrations SET name = ${upstream.name}
            WHERE migration_id = ${row.migration_id}
          `;
        executed.push([row.migration_id, upstream.name]);
      }
      return executed;
    }),
  );
});
