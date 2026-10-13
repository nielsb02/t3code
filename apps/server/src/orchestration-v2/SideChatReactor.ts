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
  "thread.deleted",
]);

/**
 * Micro fork: side chats live inside their main thread, so settling, archiving
 * or deleting the main thread archives its open side chats. Archiving a side
 * chat closes its own side chats the same way.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;

  const openSideChats = (parentThreadId: ThreadId) =>
    sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId"
      FROM orchestration_v2_projection_threads
      WHERE archived_at IS NULL
        AND deleted_at IS NULL
        AND json_extract(payload_json, '$.sideChat') = 1
        AND json_extract(payload_json, '$.lineage.parentThreadId') = ${parentThreadId}
    `;

  const closeSideChats = Effect.fn("SideChatReactor.closeSideChats")(
    function* (event: OrchestrationV2DomainEvent) {
      for (const row of yield* openSideChats(event.threadId)) {
        const threadId = ThreadId.make(row.threadId);
        yield* orchestrator
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`side-chat:close:${threadId}:${event.id}`),
            threadId,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("Could not close a side chat", {
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
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Could not look up side chats to close", {
                parentThreadId: event.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const start = Effect.fn("SideChatReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        CLOSING_EVENTS.has(event.type) ? closeSideChats(event) : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Side chat event stream failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
  });

  return { start };
});
