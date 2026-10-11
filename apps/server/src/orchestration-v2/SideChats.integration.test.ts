import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex-side-chats");
const modelSelection = { instanceId, model: "side-chat-model" };
// Portable forks keep the fake adapter free of native fork bookkeeping.
const capabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  threads: { ...CodexProviderCapabilitiesV2.threads, canForkThread: false, canForkFromTurn: false },
};
const projectId = ProjectId.make("project:side-chats");
const parentThreadId = ThreadId.make("thread:side-chats:parent");
const forkThreadId = ThreadId.make("thread:side-chats:fork");

interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly text: string;
}

function unsupported(detail: string) {
  return Effect.fail(new ProviderAdapterProtocolError({ driver, detail }));
}

/** Answers every turn with `answer:<prompt>`; a prompt with a gate waits for it first. */
function makeAdapter(input: {
  readonly captured: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly gates: Map<string, Deferred.Deferred<void>>;
}): ProviderAdapterV2Shape {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const turns = new Map<ProviderTurnId, ProviderAdapterV2TurnInput>();
        const publish = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const providerTurn = (
          turn: ProviderAdapterV2TurnInput,
          id: ProviderTurnId,
          status: "running" | "completed" | "interrupted",
          at: DateTime.Utc,
        ): ProviderAdapterV2Event => ({
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            id,
            providerThreadId: turn.providerThread.id,
            nodeId: turn.rootNodeId,
            runAttemptId: turn.attemptId,
            nativeTurnRef: { driver, nativeId: `native:${id}`, strength: "strong" },
            ordinal: turn.providerTurnOrdinal,
            status,
            startedAt: at,
            completedAt: status === "running" ? null : at,
          },
        });
        const terminal = (
          turn: ProviderAdapterV2TurnInput,
          id: ProviderTurnId,
          status: "completed" | "interrupted",
        ): ProviderAdapterV2Event => ({
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThread.id,
          providerTurnId: id,
          runOrdinal: turn.runOrdinal,
          status,
          failure: null,
          threadDisposition: "reusable",
        });
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
            model: sessionInput.modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                ...threadInput.existingProviderThread,
                id:
                  threadInput.existingProviderThread?.id ??
                  ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              yield* Ref.update(input.captured, (captured) => [
                ...captured,
                { threadId: turn.threadId, runId: turn.runId, text: turn.message.text },
              ]);
              const id = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
              turns.set(id, turn);
              yield* publish([providerTurn(turn, id, "running", yield* DateTime.now)]);
              const prompt = turn.message.text.split("User message:\n").at(-1) ?? "";
              const gate = input.gates.get(prompt);
              if (gate !== undefined) yield* Deferred.await(gate);
              const at = yield* DateTime.now;
              yield* publish([
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(`turn-item:${turn.attemptId}:answer`),
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId: turn.rootNodeId,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: id,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    status: "completed",
                    title: null,
                    startedAt: at,
                    completedAt: at,
                    updatedAt: at,
                    type: "assistant_message",
                    messageId: MessageId.make(`message:${turn.attemptId}:answer`),
                    text: `answer:${prompt}`,
                    streaming: false,
                  },
                },
                providerTurn(turn, id, "completed", at),
                terminal(turn, id, "completed"),
              ]);
            }).pipe(Effect.forkDetach, Effect.asVoid),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerTurnId }) =>
            Effect.gen(function* () {
              const turn = turns.get(providerTurnId);
              if (turn === undefined) return;
              yield* publish([
                providerTurn(turn, providerTurnId, "interrupted", yield* DateTime.now),
                terminal(turn, providerTurnId, "interrupted"),
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unsupported("readThreadSnapshot is unused"),
          rollbackThread: () => unsupported("rollbackThread is unused"),
          forkThread: () => unsupported("forkThread is unused"),
        };
      }),
  };
}

const sideChatTest = <A, E>(
  name: string,
  body: (input: {
    readonly cwd: string;
    readonly captured: Ref.Ref<ReadonlyArray<CapturedTurn>>;
    readonly gates: Map<string, Deferred.Deferred<void>>;
  }) => Effect.Effect<
    A,
    E,
    Orchestrator.OrchestratorV2 | ThreadManagementService.ThreadManagementService | Scope.Scope
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const gates = new Map<string, Deferred.Deferred<void>>();
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name },
        ProviderAdapterRegistry.layerSingle(makeAdapter({ captured, gates })),
      );
      return yield* body({ cwd, captured, gates }).pipe(
        Effect.provide(
          Layer.merge(
            layerOrchestrator,
            ThreadManagementService.layer.pipe(Layer.provide(layerOrchestrator)),
          ),
        ),
      );
    }),
  );

const threads = ThreadManagementService.ThreadManagementService;

const send = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const service = yield* threads;
    const { run } = yield* service.sendToThread({
      projectId,
      commandId: CommandId.make(`command:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      modelSelection,
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
    });
    return run;
  });

const sendAndWait = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const run = yield* send(threadId, text);
    const waited = yield* (yield* threads).waitForThread({
      projectId,
      threadId,
      runId: run.id,
      timeoutMs: 60_000,
    });
    assert.equal(waited.run?.status, "completed");
    return run;
  });

const createParentAndFork = (cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:side-chats:create"),
      threadId: parentThreadId,
      projectId,
      title: "Parent work",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
    });
    const sourceRun = yield* sendAndWait(parentThreadId, "parent one");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:side-chats:fork"),
      sourceThreadId: parentThreadId,
      targetThreadId: forkThreadId,
      sourcePoint: { type: "run", runId: sourceRun.id },
    });
  });

/** Sends `text` and returns once its provider turn is running. */
const sendWhileRunning = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.threadId === threadId &&
          event.type === "provider-turn.updated" &&
          event.payload.status === "running",
      ),
      Stream.runHead,
      Effect.forkScoped,
    );
    const run = yield* send(threadId, text);
    yield* Fiber.join(running);
    return run;
  });

const turnText = (captured: ReadonlyArray<CapturedTurn>, runId: RunId) =>
  captured.find((turn) => turn.runId === runId)?.text ?? "";

/** Waits for the next event on `threadId` matching `predicate`, subscribed before `trigger` runs. */
const awaitEventAfter = <A, E, R>(
  threadId: ThreadId,
  predicate: (event: OrchestrationV2DomainEvent) => boolean,
  trigger: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const next = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter((event) => event.threadId === threadId && predicate(event)),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* trigger;
    return yield* Fiber.join(next);
  });

it.live("tells a fork how to report back and points it at parent runs it has not seen", () =>
  sideChatTest("side-chats-notice", ({ cwd, captured }) =>
    Effect.gen(function* () {
      const service = yield* threads;
      yield* createParentAndFork(cwd);
      const parentTwo = yield* sendAndWait(parentThreadId, "parent two");

      const forkOne = yield* sendAndWait(forkThreadId, "fork one");
      const first = turnText(yield* Ref.get(captured), forkOne.id);
      assert.include(first, `Side chat: this thread is a fork of "Parent work"`);
      assert.include(first, "at its run 1.");
      assert.include(first, "completed 1 run you have not seen (run 2)");
      assert.include(first, `Its latest answer begins: "answer:parent two"`);
      assert.isTrue(first.endsWith("User message:\nfork one"));
      const afterPosition = Number(/"afterPosition":(\d+)/.exec(first)?.[1]);
      const catchUp = yield* service.getTimelinePage(parentThreadId, {
        afterPosition,
        view: "messages",
        limit: 1,
      });
      assert.equal(catchUp.items[0]?.item.runId, parentTwo.id);

      // Nothing new on the parent, and the instructions are already in this conversation.
      const forkTwo = yield* sendAndWait(forkThreadId, "fork two");
      assert.equal(turnText(yield* Ref.get(captured), forkTwo.id), "fork two");

      yield* sendAndWait(parentThreadId, "parent three");
      const forkThree = yield* sendAndWait(forkThreadId, "fork three");
      const third = turnText(yield* Ref.get(captured), forkThree.id);
      assert.notInclude(third, "Side chat:");
      assert.include(third, "completed 1 run you have not seen (run 3)");
      assert.notInclude(third, "run 2");

      // The parent itself is not a fork.
      const parentRuns = (yield* Ref.get(captured)).filter(
        (turn) => turn.threadId === parentThreadId,
      );
      assert.isTrue(parentRuns.every((turn) => !turn.text.includes("Side chat:")));
    }),
  ),
);

it.live("merges a fork's own turn back only once that turn completes", () =>
  sideChatTest("side-chats-deferred-merge", ({ cwd, gates }) =>
    Effect.gen(function* () {
      const service = yield* threads;
      yield* createParentAndFork(cwd);
      yield* sendAndWait(forkThreadId, "fork one");
      const mergeBack = (commandName: string) =>
        service.mergeBack({
          commandId: CommandId.make(`command:side-chats:${commandName}`),
          sourceThreadId: forkThreadId,
          targetThreadId: parentThreadId,
          byOwnAgent: true,
          createdBy: "agent",
          creationSource: "mcp",
        });
      const mergeTransfers = Effect.gen(function* () {
        const { contextTransfers } = yield* service.getThreadRecords(parentThreadId, [
          "contextTransfers",
        ]);
        return contextTransfers.filter((transfer) => transfer.type === "merge_back");
      });

      // An interrupted turn merges nothing.
      gates.set("fork interrupted", yield* Deferred.make<void>());
      const interrupted = yield* sendWhileRunning(forkThreadId, "fork interrupted");
      assert.deepStrictEqual(yield* mergeBack("merge-interrupted"), {
        mergesWhenTurnEnds: true,
        sourceRunId: interrupted.id,
      });
      yield* service.interruptThread({
        projectId,
        commandId: CommandId.make("command:side-chats:interrupt"),
        threadId: forkThreadId,
        runId: interrupted.id,
      });
      const interruptedRun = yield* service.waitForThread({
        projectId,
        threadId: forkThreadId,
        runId: interrupted.id,
        timeoutMs: 60_000,
      });
      assert.equal(interruptedRun.run?.status, "interrupted");

      const gate = yield* Deferred.make<void>();
      gates.set("fork report", gate);
      const report = yield* sendWhileRunning(forkThreadId, "fork report");
      assert.deepStrictEqual(yield* mergeBack("merge-report"), {
        mergesWhenTurnEnds: true,
        sourceRunId: report.id,
      });
      assert.lengthOf(yield* mergeTransfers, 0);

      const created = yield* awaitEventAfter(
        parentThreadId,
        (event) => event.type === "context-transfer.created",
        Deferred.succeed(gate, undefined),
      );
      assert.isTrue(created._tag === "Some");
      const transfers = yield* mergeTransfers;
      assert.lengthOf(transfers, 1);
      assert.equal(transfers[0]?.status, "pending");
      assert.equal(transfers[0]?.sourcePoint.runId, report.id);

      // A thread that is not the fork's parent is refused up front.
      const notParent = yield* Effect.flip(
        service.mergeBack({
          commandId: CommandId.make("command:side-chats:merge-wrong-target"),
          sourceThreadId: parentThreadId,
          targetThreadId: forkThreadId,
          byOwnAgent: false,
          createdBy: "agent",
          creationSource: "mcp",
        }),
      );
      assert.equal(notParent._tag, "OrchestratorDispatchError");
    }),
  ),
);

it.live("cancels a pending merge-back so the parent's next turn does not receive it", () =>
  sideChatTest("side-chats-cancel-merge", ({ cwd, captured }) =>
    Effect.gen(function* () {
      const service = yield* threads;
      yield* createParentAndFork(cwd);
      yield* sendAndWait(forkThreadId, "fork one");
      yield* service.mergeBack({
        commandId: CommandId.make("command:side-chats:merge"),
        sourceThreadId: forkThreadId,
        targetThreadId: parentThreadId,
        byOwnAgent: false,
        createdBy: "user",
        creationSource: "web",
      });
      const pendingTransfer = (yield* service.getThreadRecords(parentThreadId, [
        "contextTransfers",
      ])).contextTransfers.find((transfer) => transfer.type === "merge_back");
      assert.equal(pendingTransfer?.status, "pending");
      const cancel = (commandName: string) =>
        service.dispatch({
          type: "thread.merge_back.cancel",
          commandId: CommandId.make(`command:side-chats:${commandName}`),
          threadId: parentThreadId,
          transferId: pendingTransfer!.id,
        });

      yield* cancel("cancel");
      const cancelled = (yield* service.getThreadRecords(parentThreadId, [
        "contextTransfers",
      ])).contextTransfers.find((transfer) => transfer.id === pendingTransfer!.id);
      assert.equal(cancelled?.status, "superseded");
      assert.equal(cancelled?.error, Orchestrator.MERGE_BACK_CANCELLED_ERROR);
      const again = yield* Effect.flip(cancel("cancel-again"));
      assert.equal(again._tag, "OrchestratorDispatchError");

      const next = yield* sendAndWait(parentThreadId, "parent two");
      assert.equal(turnText(yield* Ref.get(captured), next.id), "parent two");
      const { contextHandoffs } = yield* service.getThreadRecords(parentThreadId, [
        "contextHandoffs",
      ]);
      assert.isTrue(contextHandoffs.every((handoff) => handoff.transferId !== pendingTransfer!.id));
    }),
  ),
);
