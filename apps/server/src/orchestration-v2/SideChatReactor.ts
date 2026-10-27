import { CommandId, type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** Main-thread events that close every side chat still open inside it. */
const CLOSING_EVENTS = new Set<OrchestrationV2DomainEvent["type"]>([
  "thread.settled",
  "thread.archived",
]);

/**
 * Micro fork: side chats live inside their main thread. Settling or archiving the main thread
 * closes (archives) its open side chats, which stay listed in the thread to reopen or delete.
 * Deleting the main thread deletes all of its side chats, closed ones included, since nothing
 * else can reach them. Both cascade to a side chat's own side chats through their events.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;

  const sideChatsOf = (parentThreadId: ThreadId, which: "open" | "undeleted") =>
    sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId"
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND (${which} = 'undeleted' OR archived_at IS NULL)
        AND json_extract(payload_json, '$.sideChat') = 1
        AND json_extract(payload_json, '$.lineage.parentThreadId') = ${parentThreadId}
    `;

  const cascade = Effect.fn("SideChatReactor.cascade")(
    function* (event: OrchestrationV2DomainEvent, action: "archive" | "delete") {
      const rows = yield* sideChatsOf(event.threadId, action === "delete" ? "undeleted" : "open");
      for (const row of rows) {
        const threadId = ThreadId.make(row.threadId);
        yield* orchestrator
          .dispatch({
            type: action === "delete" ? "thread.delete" : "thread.archive",
            commandId: CommandId.make(`side-chat:${action}:${threadId}:${event.id}`),
            threadId,
          })
          .pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logWarning(`Could not ${action} a side chat`, {
                  threadId,
                  parentThreadId: event.threadId,
                  cause: Cause.pretty(cause),
                }),
            ),
          );
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Could not look up side chats", {
              parentThreadId: event.threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  const start = Effect.fn("SideChatReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "thread.deleted"
          ? cascade(event, "delete")
          : CLOSING_EVENTS.has(event.type)
            ? cascade(event, "archive")
            : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Side chat event stream failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
  });

  return { start };
});
