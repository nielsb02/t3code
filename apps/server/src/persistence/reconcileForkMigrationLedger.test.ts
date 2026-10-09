import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const ledger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const hasTable = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
    return rows.length === 1;
  });

describe("fork migration ledger", () => {
  it.effect("upgrades the released fork ledger so OrchestrationV2 runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Shape recorded by 0.0.45-micro releases.
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
      yield* sql`UPDATE effect_sql_migrations SET name = 'ReconcileForkThreadSchema' WHERE migration_id = 53`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'ReconcileForkReleaseSchema')`;

      const executed = yield* runMigrations();

      assert.deepStrictEqual(executed.slice(0, 2), [
        [53, "PullRequestFilesViewed"],
        [55, "OrchestrationV2"],
      ]);
      assert.deepStrictEqual(yield* ledger, migrationManifest);
      assert.ok(yield* hasTable("orchestration_v2_legacy_imports"));
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("restores upstream 50 when the fork recorded parent threads there", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`DROP TABLE projection_thread_pull_requests`;
      yield* sql`UPDATE effect_sql_migrations SET name = 'ProjectionThreadsParent' WHERE migration_id = 50`;

      const executed = yield* runMigrations();

      assert.deepStrictEqual(executed.slice(0, 3), [
        [50, "ProjectionThreadPullRequests"],
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
      ]);
      assert.ok(yield* hasTable("projection_thread_pull_requests"));
      assert.deepStrictEqual(yield* ledger, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves other ledgers alone", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const before = yield* ledger;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* ledger, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
