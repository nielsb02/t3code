import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  yield* sql`CREATE INDEX projection_threads_parent_thread_id ON projection_threads(parent_thread_id) WHERE parent_thread_id IS NOT NULL`;
});
