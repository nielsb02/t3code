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
  type ProviderAdapterV2,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SideChatReactor from "./SideChatReactor.ts";
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
const sideChatThreadId = ThreadId.make("thread:side-chats:side-chat");
const nativeForkThreadId = ThreadId.make("thread:side-chats:native-fork");

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
}): ProviderAdapterV2["Service"] {
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
    | Orchestrator.OrchestratorV2
    | ThreadManagementService.ThreadManagementService
    | SqlClient.SqlClient
    | Scope.Scope
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const gates = new Map<string, Deferred.Deferred<void>>();
      // Shared with the reactor, which reads side chats straight from the projections.
      const layerDatabase = SqlitePersistence.layerMemory;
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name },
        ProviderAdapterRegistry.layerSingle(makeAdapter({ captured, gates })),
        { databaseLayer: layerDatabase },
      );
      return yield* body({ cwd, captured, gates }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerDatabase,
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

/** Creates the main thread and returns its first, completed run. */
const createParent = (cwd: string) =>
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
    return yield* sendAndWait(parentThreadId, "parent one");
  });

const fork = (input: {
  readonly sourceThreadId?: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly sourcePoint:
    | { readonly type: "latest_stable" }
    | { readonly type: "run"; readonly runId: RunId };
  readonly sideChat: boolean;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:side-chats:fork:${input.targetThreadId}`),
      sourceThreadId: input.sourceThreadId ?? parentThreadId,
      targetThreadId: input.targetThreadId,
      sourcePoint: input.sourcePoint,
      ...(input.sideChat ? { sideChat: true } : {}),
    });
  });

const createParentAndSideChat = (cwd: string) =>
  Effect.gen(function* () {
    const sourceRun = yield* createParent(cwd);
    yield* fork({
      targetThreadId: sideChatThreadId,
      sourcePoint: { type: "run", runId: sourceRun.id },
      sideChat: true,
    });
    return sourceRun;
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

it.live(
  "briefs a side chat on its first turn only, and never a native fork or the main thread",
  () =>
    sideChatTest("side-chats-brief", ({ cwd, captured }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sourceRun = yield* createParentAndSideChat(cwd);
        yield* fork({
          targetThreadId: nativeForkThreadId,
          sourcePoint: { type: "run", runId: sourceRun.id },
          sideChat: false,
        });
        assert.isTrue((yield* orchestrator.getThreadShell(sideChatThreadId))?.sideChat);
        assert.isUndefined((yield* orchestrator.getThreadShell(nativeForkThreadId))?.sideChat);

        const first = yield* sendAndWait(sideChatThreadId, "side one");
        const firstText = turnText(yield* Ref.get(captured), first.id);
        assert.include(firstText, `Side chat: this thread is a side chat of "Parent work"`);
        assert.include(firstText, "forked after its run 1.");
        assert.isTrue(firstText.endsWith("User message:\nside one"));

        // The brief is already in this conversation.
        const second = yield* sendAndWait(sideChatThreadId, "side two");
        assert.equal(turnText(yield* Ref.get(captured), second.id), "side two");

        const native = yield* sendAndWait(nativeForkThreadId, "native one");
        assert.notInclude(turnText(yield* Ref.get(captured), native.id), "Side chat:");
        const parentTurns = (yield* Ref.get(captured)).filter(
          (turn) => turn.threadId === parentThreadId,
        );
        assert.isTrue(parentTurns.every((turn) => !turn.text.includes("Side chat:")));
      }),
    ),
);

it.live("starts a side chat from the latest finished run while the main thread keeps running", () =>
  sideChatTest("side-chats-while-running", ({ cwd, gates }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sourceRun = yield* createParent(cwd);
      const gate = yield* Deferred.make<void>();
      gates.set("parent two", gate);
      const running = yield* sendWhileRunning(parentThreadId, "parent two");

      yield* fork({
        targetThreadId: sideChatThreadId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
      });
      assert.deepStrictEqual((yield* orchestrator.getThreadShell(sideChatThreadId))?.forkedFrom, {
        type: "run",
        threadId: parentThreadId,
        runId: sourceRun.id,
      });
      yield* sendAndWait(sideChatThreadId, "side question");
      assert.equal((yield* orchestrator.getThreadShell(parentThreadId))?.activeRunId, running.id);

      yield* Deferred.succeed(gate, undefined);
      const waited = yield* (yield* threads).waitForThread({
        projectId,
        threadId: parentThreadId,
        runId: running.id,
        timeoutMs: 60_000,
      });
      assert.equal(waited.run?.status, "completed");
    }),
  ),
);

it.live("closes open side chats when their main thread settles, and their own when archived", () =>
  sideChatTest("side-chats-close", ({ cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* (yield* SideChatReactor.make).start();
      const sourceRun = yield* createParentAndSideChat(cwd);
      yield* fork({
        targetThreadId: nativeForkThreadId,
        sourcePoint: { type: "run", runId: sourceRun.id },
        sideChat: false,
      });
      // A side chat of the side chat closes when the side chat is archived.
      yield* sendAndWait(sideChatThreadId, "side one");
      const nestedThreadId = ThreadId.make("thread:side-chats:nested");
      yield* fork({
        sourceThreadId: sideChatThreadId,
        targetThreadId: nestedThreadId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
      });

      const nestedArchived = yield* awaitEventAfter(
        nestedThreadId,
        (event) => event.type === "thread.archived",
        orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("command:side-chats:settle"),
          threadId: parentThreadId,
        }),
      );
      assert.isTrue(Option.isSome(nestedArchived));
      assert.isNotNull((yield* orchestrator.getThreadShell(sideChatThreadId))?.archivedAt);
      // Native forks are ordinary threads and stay open.
      assert.isNull((yield* orchestrator.getThreadShell(nativeForkThreadId))?.archivedAt);
    }),
  ),
);

it.live("merges a fork's own turn back only once that turn completes", () =>
  sideChatTest("side-chats-deferred-merge", ({ cwd, gates }) =>
    Effect.gen(function* () {
      const service = yield* threads;
      yield* createParentAndSideChat(cwd);
      yield* sendAndWait(sideChatThreadId, "fork one");
      const mergeBack = (commandName: string) =>
        service.mergeBack({
          commandId: CommandId.make(`command:side-chats:${commandName}`),
          sourceThreadId: sideChatThreadId,
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
      const interrupted = yield* sendWhileRunning(sideChatThreadId, "fork interrupted");
      assert.deepStrictEqual(yield* mergeBack("merge-interrupted"), {
        mergesWhenTurnEnds: true,
        sourceRunId: interrupted.id,
      });
      yield* service.interruptThread({
        projectId,
        commandId: CommandId.make("command:side-chats:interrupt"),
        threadId: sideChatThreadId,
        runId: interrupted.id,
      });
      const interruptedRun = yield* service.waitForThread({
        projectId,
        threadId: sideChatThreadId,
        runId: interrupted.id,
        timeoutMs: 60_000,
      });
      assert.equal(interruptedRun.run?.status, "interrupted");

      const gate = yield* Deferred.make<void>();
      gates.set("fork report", gate);
      const report = yield* sendWhileRunning(sideChatThreadId, "fork report");
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
          targetThreadId: sideChatThreadId,
          byOwnAgent: false,
          createdBy: "agent",
          creationSource: "mcp",
        }),
      );
      assert.equal(notParent._tag, "OrchestratorDispatchError");
    }),
  ),
);
