import {
  CommandId,
  type ThreadContextTransfer,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationReadModel,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const seedReadModel = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-delete"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-delete"),
      title: "Project Delete",
      workspaceRoot: "/tmp/project-delete",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  const withFirstThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create-1"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-1"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withFirstThread, {
    sequence: 3,
    eventId: asEventId("evt-thread-create-2"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-2"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-2"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-2"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-2"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 2",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

const now = "2026-01-01T00:00:00.000Z";
const childId = asThreadId("child");
const parentId = asThreadId("thread-delete-1");
const seedParent = seedReadModel.pipe(
  Effect.map((readModel): OrchestrationReadModel => ({
    ...readModel,
    threads: readModel.threads.map((thread) =>
      thread.id !== parentId
        ? thread
        : {
            ...thread,
            branch: "feature/main",
            worktreePath: "/feature/main",
            session: {
              threadId: parentId,
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
          },
    ),
  })),
);
const createChild = {
  type: "thread.create",
  commandId: asCommandId("create-child"),
  threadId: childId,
  parentThreadId: parentId,
  projectId: asProjectId("project-delete"),
  title: "Side chat",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: now,
} satisfies OrchestrationCommand;
const withChild = Effect.gen(function* () {
  let model = yield* seedParent;
  const result = yield* decideOrchestrationCommand({ readModel: model, command: createChild });
  for (const event of Array.isArray(result) ? result : [result]) {
    model = yield* projectEvent(model, { ...event, sequence: model.snapshotSequence + 1 });
  }
  return model;
});

it.layer(NodeServices.layer)("side chat commands", (it) => {
  it.effect("force-deletes a project containing side chats child-first", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        readModel: yield* withChild,
        command: {
          type: "project.delete",
          commandId: asCommandId("delete-project"),
          projectId: asProjectId("project-delete"),
          force: true,
        },
      });
      const events = Array.isArray(result) ? result : [result];
      const deletions = events
        .filter((event) => event.type === "thread.deleted")
        .map((event) => event.payload.threadId);
      expect(deletions.indexOf(childId)).toBeLessThan(deletions.indexOf(parentId));
      expect(events.at(-1)?.type).toBe("project.deleted");
    }),
  );
  it.effect("rejects reporting from a main thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        readModel: yield* withChild,
        command: {
          type: "thread.context.report",
          commandId: asCommandId("report"),
          threadId: parentId,
          message: "Report",
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ detail: "This thread is not a side chat." });
    }),
  );
  for (const target of [parentId, childId]) {
    it.effect(`rejects reporting with archived ${target}`, () =>
      Effect.gen(function* () {
        const model = yield* withChild;
        const error = yield* decideOrchestrationCommand({
          readModel: {
            ...model,
            threads: model.threads.map((thread) =>
              thread.id === target ? { ...thread, archivedAt: now } : thread,
            ),
          },
          command: {
            type: "thread.context.report",
            commandId: asCommandId("report"),
            threadId: childId,
            message: "Report",
            createdAt: now,
          },
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          detail: "Restore the side chat and its parent before reporting back.",
        });
      }),
    );
  }
  for (const status of ["requested", "delivering", "delivered", "failed"] as const) {
    it.effect(`does not cancel ${status} context`, () =>
      Effect.gen(function* () {
        const readModel = yield* withChild;
        const result = yield* decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.context.cancel",
            commandId: asCommandId("cancel"),
            threadId: parentId,
            transferId: asCommandId("transfer"),
            createdAt: now,
          },
          contextTransfer: {
            transferId: asCommandId("transfer"),
            sourceThreadId: childId,
            sourceTurnId: null,
            direction: "to-parent",
            status,
          },
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }),
    );
  }
  for (const status of ["starting", "running"] as const) {
    it.effect(`cancels a pending update while an unrelated turn is ${status}`, () =>
      Effect.gen(function* () {
        const model = yield* withChild;
        const readModel = {
          ...model,
          threads: model.threads.map((thread) =>
            thread.id === parentId && thread.session
              ? { ...thread, session: { ...thread.session, status } }
              : thread,
          ),
        };
        const result = yield* decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.context.cancel",
            commandId: asCommandId("cancel"),
            threadId: parentId,
            transferId: asCommandId("transfer"),
            createdAt: now,
          },
          contextTransfer: {
            transferId: asCommandId("transfer"),
            sourceThreadId: childId,
            sourceTurnId: null,
            direction: "to-parent",
            status: "prepared",
            text: "Shared finding",
          },
        }).pipe(Effect.result);
        expect(result._tag).toBe("Success");
      }),
    );
  }
  it.effect("delivery cannot reclaim cancelled or already claimed context", () =>
    Effect.gen(function* () {
      const readModel = yield* withChild;
      for (const status of ["cancelled", "delivering", "delivered"] as const) {
        expect(
          yield* decideOrchestrationCommand({
            readModel,
            command: {
              type: "thread.context.claim",
              commandId: asCommandId("claim"),
              threadId: parentId,
              transferId: asCommandId("transfer"),
              createdAt: now,
            },
            contextTransfer: {
              transferId: asCommandId("transfer"),
              sourceThreadId: childId,
              sourceTurnId: null,
              direction: "to-parent",
              status,
            },
          }),
        ).toMatchObject({ payload: { activity: { payload: { status } } } });
      }
    }),
  );
  it.effect("cancels a pending share once and retains its history", () =>
    Effect.gen(function* () {
      let readModel = yield* withChild;
      const contextTransfer: ThreadContextTransfer = {
        transferId: asCommandId("transfer"),
        sourceThreadId: childId,
        sourceTurnId: null,
        direction: "to-parent",
        status: "prepared",
        text: "Shared finding",
      };
      const command = {
        type: "thread.context.cancel",
        commandId: asCommandId("cancel"),
        threadId: parentId,
        transferId: contextTransfer.transferId,
        createdAt: now,
      } satisfies OrchestrationCommand;
      const result = yield* decideOrchestrationCommand({ readModel, command, contextTransfer });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      for (const event of events)
        readModel = yield* projectEvent(readModel, {
          ...event,
          sequence: readModel.snapshotSequence + 1,
        });
      expect(readModel.threads.find((thread) => thread.id === parentId)?.activities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "side-chat.context.cancelled",
            payload: { ...contextTransfer, status: "cancelled" },
          }),
        ]),
      );
      expect(
        yield* decideOrchestrationCommand({
          readModel,
          command: { ...command, commandId: asCommandId("cancel-again") },
          contextTransfer: { ...contextTransfer, status: "cancelled" },
        }),
      ).toMatchObject({
        payload: { activity: { payload: { ...contextTransfer, status: "cancelled" } } },
      });
    }),
  );
  it.effect("inherits the parent checkout while keeping an independent model", () =>
    Effect.gen(function* () {
      const model = yield* withChild;
      expect(model.threads.find((thread) => thread.id === childId)).toMatchObject({
        parentThreadId: parentId,
        branch: "feature/main",
        worktreePath: "/feature/main",
        modelSelection: createChild.modelSelection,
        session: null,
      });
    }),
  );
  it.effect("rejects unsupported parent providers", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ readModel, command: createChild }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("keeps a parent available while its archived child still depends on it", () =>
    Effect.gen(function* () {
      const readModel = yield* withChild;
      const archivedModel = {
        ...readModel,
        threads: readModel.threads.map((thread) =>
          thread.id === childId ? { ...thread, archivedAt: now } : thread,
        ),
      };
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: archivedModel,
          command: {
            type: "thread.delete",
            commandId: asCommandId("delete-parent"),
            threadId: parentId,
          },
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("blocks changing a shared child's workspace", () =>
    Effect.gen(function* () {
      const readModel = yield* withChild;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.meta.update",
            commandId: asCommandId("change-workspace"),
            threadId: childId,
            worktreePath: "/other",
          },
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect(
    "shares a completed answer as pending background context without starting a parent turn",
    () =>
      Effect.gen(function* () {
        const model = yield* withChild;
        const messageId = MessageId.make("child-answer");
        const readModel = {
          ...model,
          threads: model.threads.map((thread) =>
            thread.id === childId
              ? {
                  ...thread,
                  messages: [
                    {
                      id: messageId,
                      role: "assistant" as const,
                      text: "Keep the settings endpoint unchanged.",
                      streaming: false,
                      turnId: null,
                      createdAt: now,
                      updatedAt: now,
                    },
                  ],
                }
              : thread,
          ),
        };
        const result = yield* decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.context.share",
            commandId: asCommandId("share-answer"),
            threadId: childId,
            messageId,
            createdAt: now,
          },
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          aggregateId: parentId,
          type: "thread.activity-appended",
          payload: {
            threadId: parentId,
            activity: {
              kind: "side-chat.context.prepared",
              payload: {
                sourceThreadId: childId,
                direction: "to-parent",
                status: "prepared",
                text: "Keep the settings endpoint unchanged.",
              },
            },
          },
        });
      }),
  );
  it.effect("refresh requests only context generation, without adding a message or turn", () =>
    Effect.gen(function* () {
      const readModel = yield* withChild;
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.context.refresh",
          commandId: asCommandId("refresh-child"),
          threadId: childId,
          createdAt: now,
        },
      });
      expect(Array.isArray(result) ? result : [result]).toMatchObject([
        {
          type: "thread.activity-appended",
          payload: {
            activity: {
              kind: "side-chat.context.requested",
              payload: { sourceThreadId: parentId, status: "requested" },
            },
          },
        },
      ]);
    }),
  );
  it.effect(
    "rejects oversized shared answers before they can strand the parent's input budget",
    () =>
      Effect.gen(function* () {
        const readModel = yield* withChild;
        const messageId = MessageId.make("oversized");
        const error = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: {
              type: "thread.context.share",
              commandId: asCommandId("share-oversized"),
              threadId: childId,
              messageId,
              createdAt: now,
            },
            sharedMessage: {
              id: messageId,
              role: "assistant",
              text: "x".repeat(64_001),
              streaming: false,
              turnId: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        );
        expect(error).toMatchObject({
          _tag: "OrchestrationCommandInvariantError",
          detail: expect.stringContaining("too long"),
        });
      }),
  );
});
