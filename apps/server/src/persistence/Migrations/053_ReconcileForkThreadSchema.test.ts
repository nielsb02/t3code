import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateParentThreads from "./050_ProjectionThreadsParent.ts";

for (const history of ["fork", "upstream", "fresh"] as const) {
  it.layer(Layer.fresh(NodeSqliteClient.layerMemory()))(
    `fork schema reconciliation: ${history}`,
    (it) => {
      it.effect("preserves thread data and upgrades through the complete migration runner", () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 49 });
          if (history === "fork") {
            yield* migrateParentThreads;
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (50, 'ProjectionThreadsParent')`;
          } else if (history === "upstream") {
            yield* runMigrations({ toMigrationInclusive: 52 });
          }

          yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json,
            linked_pull_request_json, created_at, updated_at
          ) VALUES (
            'child', 'project', 'Side chat', '{"instanceId":"codex","model":"gpt-5.4"}',
            '{"repository":"acme/widgets","number":7,"url":"https://github.com/acme/widgets/pull/7"}',
            '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'
          )
        `;
          if (history === "fork") {
            yield* sql`UPDATE projection_threads SET parent_thread_id = 'parent' WHERE thread_id = 'child'`;
          }
          if (history === "upstream") {
            yield* sql`
            INSERT INTO projection_thread_pull_requests (thread_id, host, repository, number, url, source, linked_at)
            VALUES ('child', 'github.com', 'acme/widgets', 8, 'https://github.com/acme/widgets/pull/8', 'manual', '2026-03-02T00:00:00.000Z')
          `;
          }

          yield* runMigrations();
          const threads =
            yield* sql`SELECT title, parent_thread_id, title_state_json FROM projection_threads WHERE thread_id = 'child'`;
          assert.deepStrictEqual(threads, [
            {
              title: "Side chat",
              parent_thread_id: history === "fork" ? "parent" : null,
              title_state_json: null,
            },
          ]);
          const links =
            yield* sql`SELECT number FROM projection_thread_pull_requests WHERE thread_id = 'child'`;
          assert.deepStrictEqual(links, [{ number: history === "upstream" ? 8 : 7 }]);
          const messageColumns = yield* sql<{
            readonly name: string;
          }>`PRAGMA table_info(projection_thread_messages)`;
          assert.ok(messageColumns.some((column) => column.name === "context_json"));
          const indexes = yield* sql<{
            readonly name: string;
          }>`PRAGMA index_list(projection_threads)`;
          assert.ok(indexes.some((index) => index.name === "projection_threads_parent_thread_id"));
          assert.deepStrictEqual(yield* runMigrations(), []);
        }),
      );
    },
  );
}
