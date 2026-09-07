import type {
  OrchestrationClientOrigin,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { CommandId, EventId, OrchestrationCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { WorktreeOperationGuard } from "../../project/WorktreeOperationGuard.ts";
import { ProjectSettleScriptRunner } from "../../project/ProjectSettleScriptRunner.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandIdConflictError = Schema.is(OrchestrationCommandIdConflictError);

interface CommandEnvelope {
  command: OrchestrationCommand;
  origin: OrchestrationClientOrigin | undefined;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const settleScriptRunner = yield* ProjectSettleScriptRunner;
  const worktreeOperations = yield* WorktreeOperationGuard;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const settlingWorktrees = new Map<string, { threadId: ThreadId; projectId: ProjectId }>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const assertCheckoutAvailable = Effect.fn("OrchestrationEngine.assertCheckoutAvailable")(
    function* (command: OrchestrationCommand) {
      if (settlingWorktrees.size === 0) return;
      const checkouts: string[] = [];
      let targetThreadId: ThreadId | undefined;
      const projectRoot = (projectId: ProjectId) =>
        commandReadModel.projects.find((project) => project.id === projectId)?.workspaceRoot;
      if (
        command.type === "project.delete" ||
        (command.type === "project.meta.update" && command.workspaceRoot !== undefined)
      ) {
        if ([...settlingWorktrees.values()].some((busy) => busy.projectId === command.projectId)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              "A worktree in this project is running a manual settle action. Wait for it to finish.",
          });
        }
      }
      if (command.type === "project.create" || command.type === "project.meta.update") {
        if (command.workspaceRoot !== undefined) checkouts.push(command.workspaceRoot);
      } else if (command.type === "thread.create") {
        targetThreadId = command.threadId;
        const cwd = command.worktreePath ?? projectRoot(command.projectId);
        if (cwd) checkouts.push(cwd);
      } else if (
        command.type === "thread.unsettle" ||
        command.type === "thread.unarchive" ||
        command.type === "thread.turn.start" ||
        command.type === "thread.delete" ||
        command.type === "thread.archive" ||
        command.type === "thread.checkpoint.revert" ||
        command.type === "thread.runtime-mode.set" ||
        command.type === "thread.approval.respond" ||
        command.type === "thread.user-input.respond" ||
        (command.type === "thread.meta.update" &&
          (command.worktreePath !== undefined || command.branch !== undefined)) ||
        (command.type === "thread.session.set" &&
          (command.session.status === "starting" || command.session.status === "running"))
      ) {
        targetThreadId = command.threadId;
        const thread = commandReadModel.threads.find((thread) => thread.id === command.threadId);
        const cwd = thread && (thread.worktreePath ?? projectRoot(thread.projectId));
        if (cwd) checkouts.push(cwd);
        if (command.type === "thread.meta.update" && command.worktreePath !== undefined) {
          const nextCwd = command.worktreePath ?? (thread && projectRoot(thread.projectId));
          if (nextCwd) checkouts.push(nextCwd);
        }
        if (command.type === "thread.turn.start") {
          const create = command.bootstrap?.createThread;
          const nextCwd = create && (create.worktreePath ?? projectRoot(create.projectId));
          if (nextCwd) checkouts.push(nextCwd);
          const prepareCwd = command.bootstrap?.prepareWorktree?.projectCwd;
          if (prepareCwd) checkouts.push(prepareCwd);
        }
      }
      let busy = [...settlingWorktrees.values()].find((entry) => entry.threadId === targetThreadId);
      for (const cwd of checkouts) {
        const canonical = yield* fs
          .realPath(cwd)
          .pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
        busy ??= settlingWorktrees.get(canonical);
      }
      if (busy) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `This worktree is running a manual settle action for thread ${busy.threadId}. Wait for it to finish before reusing or changing the checkout.`,
        });
      }
    },
  );

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          // A receipt only proves this exact command was handled. Replaying it
          // for a command aimed at another aggregate would report success for
          // work that never happened.
          if (
            existingReceipt.value.aggregateKind !== aggregateRef.aggregateKind ||
            existingReceipt.value.aggregateId !== aggregateRef.aggregateId
          ) {
            return yield* new OrchestrationCommandIdConflictError({
              commandId: envelope.command.commandId,
              receiptAggregateKind: existingReceipt.value.aggregateKind,
              receiptAggregateId: existingReceipt.value.aggregateId,
              commandAggregateKind: aggregateRef.aggregateKind,
              commandAggregateId: aggregateRef.aggregateId,
            });
          }
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        yield* assertCheckoutAvailable(envelope.command);

        if (
          envelope.command.type === "thread.auto-settle" &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: envelope.command.threadId,
            sequenceExclusive: envelope.command.snapshotSequence,
          }))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} changed before automatic settlement`,
          });
        }

        // The decider compares the lookup inputs. Only recreation needs an
        // event check, since it can reset a thread to the same field values.
        if (
          envelope.command.type === "thread.pull-request.sync" &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: envelope.command.threadId,
            sequenceExclusive: envelope.command.snapshotSequence,
            type: "thread.created",
          }))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} was recreated before pull request discovery`,
          });
        }

        if (
          envelope.command.type === "thread.auto-settle" &&
          threadBackgroundLiveness.getThreadBackgroundLiveness(envelope.command.threadId) !== null
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} has live background work`,
          });
        }

        // Command snapshots omit activities at startup and cap them while running.
        // Read this request's durable state before deciding how to send the answer.
        const userInputActivity =
          envelope.command.type === "thread.user-input.respond"
            ? yield* projectionSnapshotQuery.getUserInputActivity(envelope.command)
            : Option.none();
        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
          ...(Option.isSome(userInputActivity)
            ? { userInputActivity: userInputActivity.value }
            : {}),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandRejection(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const plannedEvents = Array.isArray(eventBase) ? eventBase : [eventBase];
        const manualThreadId =
          envelope.command.type === "thread.settle" ? envelope.command.threadId : null;
        const manualSettlementThreadId =
          manualThreadId !== null &&
          commandReadModel.threads.find((thread) => thread.id === manualThreadId)
            ?.settledOverride !== "settled"
            ? manualThreadId
            : null;
        // Stamp the dispatching client's origin onto every event the command
        // produced. The decider stays pure; attribution is an engine concern.
        const eventBases =
          envelope.origin === undefined
            ? plannedEvents
            : plannedEvents.map((planned) => ({
                ...planned,
                metadata: { ...planned.metadata, origin: envelope.origin },
              }));
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              const attachmentCleanups: Effect.Effect<void>[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                const cleanup = yield* projectionPipeline.projectEventDeferred(savedEvent);
                attachmentCleanups.push(cleanup);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                attachmentCleanups,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const cleanup of committedCommand.attachmentCleanups) {
          yield* cleanup;
        }
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        if (manualSettlementThreadId !== null) {
          const appendSettleActivity = Effect.fn("OrchestrationEngine.appendSettleActivity")(
            function* (
              status: "started" | "completed" | "failed" | "skipped",
              detail: string,
              scriptId?: string,
            ) {
              const createdAt = yield* nowIso;
              const id = EventId.make(yield* crypto.randomUUIDv4);
              yield* dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`${envelope.command.commandId}:settle-action:${id}`),
                threadId: manualSettlementThreadId,
                createdAt,
                activity: {
                  id,
                  kind: `settle-script.${status}`,
                  summary: `Manual settle action ${status}`,
                  tone: status === "failed" ? "error" : "info",
                  turnId: null,
                  createdAt,
                  payload: { detail, ...(scriptId ? { scriptId } : {}) },
                },
              });
            },
          );
          let plan = yield* settleScriptRunner.prepare({
            threadId: manualSettlementThreadId,
            readModel: commandReadModel,
          });
          let releaseCheckout: (() => void) | null = null;
          if (plan.kind === "ready") {
            releaseCheckout = yield* worktreeOperations.tryAcquireCleanup(plan.cwd);
            if (releaseCheckout === null) {
              plan = {
                kind: "skipped",
                detail:
                  "Another checkout operation or manual settle action is already running in this worktree.",
              };
            }
          }
          if (plan.kind !== "none") {
            const cleanupPlan = plan;
            if (cleanupPlan.kind === "ready") {
              const thread = commandReadModel.threads.find(
                (thread) => thread.id === manualSettlementThreadId,
              )!;
              // Reserve while still in the command worker; unrelated checkouts keep processing.
              settlingWorktrees.set(cleanupPlan.cwd, {
                threadId: thread.id,
                projectId: thread.projectId,
              });
            }
            yield* Effect.forkIn(
              Effect.gen(function* () {
                if (cleanupPlan.kind !== "ready") {
                  yield* appendSettleActivity(cleanupPlan.kind, cleanupPlan.detail);
                  return;
                }
                for (const script of cleanupPlan.scripts) {
                  yield* appendSettleActivity(
                    "started",
                    `${script.name} in ${cleanupPlan.cwd}`,
                    script.id,
                  );
                  const result = yield* settleScriptRunner.execute({
                    script,
                    cwd: cleanupPlan.cwd,
                    env: cleanupPlan.env,
                  });
                  yield* appendSettleActivity(result.kind, result.detail, script.id);
                  if (result.kind === "failed") break;
                }
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Manual settle action could not be recorded", cause),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (cleanupPlan.kind === "ready") settlingWorktrees.delete(cleanupPlan.cwd);
                    releaseCheckout?.();
                  }),
                ),
              ),
              scope,
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (
            !isOrchestrationCommandPreviouslyRejectedError(error) &&
            !isOrchestrationCommandIdConflictError(error)
          ) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandRejection(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const readThreadEvents: OrchestrationEngineShape["readThreadEvents"] = ({ threadId, ...range }) =>
    eventStore.readAggregateRange({ ...range, aggregateKind: "thread", aggregateId: threadId });

  const getThreadReplayStats: OrchestrationEngineShape["getThreadReplayStats"] = ({
    threadId,
    ...range
  }) =>
    eventStore.getAggregateReplayStats({
      ...range,
      aggregateKind: "thread",
      aggregateId: threadId,
    });

  const dispatch: OrchestrationEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        origin: options?.origin,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    readThreadEvents,
    getThreadReplayStats,
    dispatch,
    subscribeDomainEvents: PubSub.subscribe(eventPubSub).pipe(Effect.map(Stream.fromSubscription)),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
