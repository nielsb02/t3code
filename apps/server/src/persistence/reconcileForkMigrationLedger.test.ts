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

  it.effect(
    "upgrades the V2 fork at migration 60 without losing side chats or repository links",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 60 });
        const payload = JSON.stringify({
          id: "side-chat",
          projectId: "workspace",
          title: "Side chat",
          sideChat: true,
          worktreePath: "/workspace/task",
          branch: "task",
          lineage: {
            parentThreadId: "parent",
            relationshipToParent: "fork",
            rootThreadId: "parent",
          },
          linkedPullRequest: {
            projectId: "workspace",
            repository: "org/child",
            number: 42,
            url: "https://github.com/org/child/pull/42",
          },
          updatedAt: "2026-10-11T00:00:00.000Z",
        });
        yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES ('side-chat', 'workspace', 'Side chat', 'codex', 'full-access', 'default',
          '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z', ${payload})
      `;
        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES ('side-chat-created', 'thread', 'side-chat', 0, 'thread.created',
          '2026-10-11T00:00:00.000Z', 'user', ${payload}, '{}', 2)
      `;
        yield* sql`
        INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('legacy-message', 'legacy-thread', 'user', 'Keep the import source', 0, '2026-10-11', '2026-10-11')
      `;
        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([id]) => id > 60),
        );
        assert.deepStrictEqual(yield* ledger, migrationManifest);
        for (const table of [
          "projection_thread_activities",
          "projection_turns",
          "projection_thread_proposed_plans",
          "projection_pending_approvals",
          "projection_state",
          "checkpoint_diff_blobs",
        ])
          assert.isFalse(yield* hasTable(table));
        assert.deepStrictEqual(
          yield* sql`SELECT text FROM projection_thread_messages WHERE message_id = 'legacy-message'`,
          [{ text: "Keep the import source" }],
        );
        const rows = yield* sql<{
          sideChat: number;
          parent: string;
          worktree: string;
          repository: string;
        }>`
        SELECT json_extract(payload_json, '$.sideChat') AS sideChat,
          json_extract(payload_json, '$.lineage.parentThreadId') AS parent,
          json_extract(payload_json, '$.worktreePath') AS worktree,
          json_extract(payload_json, '$.pullRequests[0].repository') AS repository
        FROM orchestration_v2_projection_threads WHERE thread_id = 'side-chat'
        UNION ALL
        SELECT json_extract(payload_json, '$.sideChat'), json_extract(payload_json, '$.lineage.parentThreadId'),
          json_extract(payload_json, '$.worktreePath'), json_extract(payload_json, '$.pullRequests[0].repository')
        FROM orchestration_events WHERE event_id = 'side-chat-created'
      `;
        const expected = {
          sideChat: 1,
          parent: "parent",
          worktree: "/workspace/task",
          repository: "org/child",
        };
        assert.deepStrictEqual(rows, [expected, expected]);
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades the previous nightly at migration 66 without rewriting fork payloads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      const payload = JSON.stringify({
        id: "side-chat",
        sideChat: true,
        lineage: { parentThreadId: "parent", relationshipToParent: "fork", rootThreadId: "parent" },
        pullRequests: [{ host: "github.com", repository: "org/child", number: 42 }],
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES ('side-chat', 'workspace', 'Side chat', 'codex', 'full-access', 'default',
          '2026-10-20', '2026-10-20', ${payload})
      `;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > 66),
      );
      assert.deepStrictEqual(yield* ledger, migrationManifest);
      assert.deepStrictEqual(
        yield* sql`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = 'side-chat'`,
        [{ payload_json: payload }],
      );
      assert.isTrue(yield* hasTable("scheduled_task_webhook_replay_keys"));
      assert.isTrue(yield* hasTable("scheduled_task_webhook_pending"));
      yield* sql`SELECT last_run_webhook_delivery_id FROM scheduled_tasks`;
      assert.deepStrictEqual(yield* runMigrations(), []);
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
