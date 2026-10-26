import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import {
  PrimaryConnectionTarget,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/reactivity";
import {
  buildDesktopSessionSnapshot,
  buildDesktopAppRendererReadiness,
  createDesktopSidebarOrderAtom,
  desktopSessionStatus,
  isDesktopSidebarThread,
} from "./desktopSessions";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const time = "2026-09-29T10:00:00.000Z";
const at = DateTime.makeUnsafe(time);
const providerInstanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("same-id");
const thread: OrchestrationV2ThreadShell = {
  id: threadId,
  projectId: ProjectId.make("project"),
  title: "Chat",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const runId = RunId.make("run");
const completed = {
  latestRunId: runId,
  latestRunRequestedAt: at,
  latestRunStartedAt: at,
  latestRunCompletedAt: at,
  status: "completed",
} as const;
const pendingRequest = (kind: "command" | "user_input") => ({
  id: RuntimeRequestId.make("request"),
  kind,
  createdAt: at,
});
function catalog(ids: readonly EnvironmentId[]): EnvironmentCatalogState {
  return {
    isReady: true,
    entries: new Map(
      ids.map((environmentId) => [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: environmentId,
            httpBaseUrl: "http://localhost",
            wsBaseUrl: "ws://localhost",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  };
}
function shell(
  threads: readonly OrchestrationV2ThreadShell[],
  status: EnvironmentShellState["status"] = "live",
): EnvironmentShellState {
  return {
    status,
    generation: 0,
    removedAt: new Map(),
    error: Option.none(),
    snapshot: Option.some({
      schemaVersion: 1,
      snapshotSequence: 1,
      threads,
      archivedThreads: [],
      projects: [
        {
          id: thread.projectId,
          title: "Project",
          workspaceRoot: "/project",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: time,
          updatedAt: time,
        },
      ],
    }),
  };
}

describe("desktop session snapshot", () => {
  it("keeps reads ready while navigation waits for connection, live shell, and primary config", () => {
    const input = {
      catalog: catalog([local]),
      readShell: () => shell([], "empty"),
      isConnected: () => true,
      hasServerConfig: () => true,
    };
    expect(buildDesktopAppRendererReadiness(input)).toEqual({
      ready: true,
      primaryEnvironmentReady: false,
      readyEnvironmentIds: [],
    });
    expect(
      buildDesktopAppRendererReadiness({ ...input, readShell: () => shell([], "cached") })
        .readyEnvironmentIds,
    ).toEqual([]);
    expect(
      buildDesktopAppRendererReadiness({ ...input, readShell: () => shell([], "synchronizing") })
        .readyEnvironmentIds,
    ).toEqual([]);
    expect(
      buildDesktopAppRendererReadiness({
        ...input,
        readShell: () => shell([]),
        isConnected: () => false,
      }).readyEnvironmentIds,
    ).toEqual([]);
    expect(
      buildDesktopAppRendererReadiness({
        ...input,
        readShell: () => shell([]),
        hasServerConfig: () => false,
      }),
    ).toEqual({ ready: true, primaryEnvironmentReady: false, readyEnvironmentIds: [local] });
    expect(buildDesktopAppRendererReadiness({ ...input, readShell: () => shell([]) })).toEqual({
      ready: true,
      primaryEnvironmentReady: true,
      readyEnvironmentIds: [local],
    });
  });

  it("makes remote thread navigation ready when the local environment is disabled", () => {
    const source = catalog([local, remote]);
    const entries = new Map(source.entries);
    const localEntry = entries.get(local);
    if (localEntry) entries.set(local, { ...localEntry, enabled: false });
    const remoteEntry = entries.get(remote);
    if (remoteEntry)
      entries.set(remote, {
        ...remoteEntry,
        target: new BearerConnectionTarget({
          environmentId: remote,
          label: "Remote",
          connectionId: "remote",
        }),
      });
    const input = {
      catalog: { ...source, entries },
      readShell: () => shell([]),
      isConnected: () => true,
      hasServerConfig: () => true,
    };
    expect(buildDesktopAppRendererReadiness(input)).toEqual({
      ready: true,
      primaryEnvironmentReady: false,
      readyEnvironmentIds: [remote],
    });
    expect(
      buildDesktopAppRendererReadiness({ ...input, catalog: { ...input.catalog, isReady: false } }),
    ).toEqual({ ready: true, primaryEnvironmentReady: false, readyEnvironmentIds: [] });
  });

  it("filters sidebar rows to active top-level chats while respecting old-server capabilities", () => {
    const capabilities = { threadSettlement: true, threadSnooze: true };
    const row = (changes: Partial<OrchestrationV2ThreadShell> = {}) =>
      presentThreadShell(local, { ...thread, ...changes });
    expect(isDesktopSidebarThread(row(), capabilities, time)).toBe(true);
    expect(isDesktopSidebarThread(row({ pinnedAt: at }), capabilities, time)).toBe(true);
    expect(
      isDesktopSidebarThread(
        row({
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        }),
        capabilities,
        time,
      ),
    ).toBe(false);
    expect(isDesktopSidebarThread(row({ archivedAt: at }), capabilities, time)).toBe(false);
    const settled = row({ settledOverride: "settled" });
    const snoozed = row({ snoozedUntil: DateTime.makeUnsafe("2026-10-01T10:00:00.000Z") });
    expect(isDesktopSidebarThread(settled, capabilities, time)).toBe(false);
    expect(isDesktopSidebarThread(snoozed, capabilities, time)).toBe(false);
    expect(isDesktopSidebarThread(settled, undefined, time)).toBe(true);
    expect(isDesktopSidebarThread(snoozed, undefined, time)).toBe(true);
    expect(
      isDesktopSidebarThread({ ...snoozed, hasPendingApprovals: true }, capabilities, time),
    ).toBe(true);
    expect(isDesktopSidebarThread(snoozed, capabilities, "2026-10-02T10:00:00.000Z")).toBe(true);
  });

  it("uses user interaction time and excludes disabled environments", () => {
    const enabled = catalog([local, remote]);
    const entries = new Map(enabled.entries);
    const remoteEntry = entries.get(remote);
    if (remoteEntry) entries.set(remote, { ...remoteEntry, enabled: false });
    const result = buildDesktopSessionSnapshot({
      catalog: { ...enabled, entries },
      readShell: () =>
        shell([
          {
            ...thread,
            ...completed,
            latestUserMessageAt: DateTime.makeUnsafe("2026-09-30T00:00:00.000Z"),
          },
        ]),
      isConnected: () => true,
      sidebar: { sidebarOrder: [], sidebarOrderReady: false },
    });
    expect(result?.environments.map((e) => e.environmentId)).toEqual([local]);
    expect(result?.environments[0]?.sessions[0]?.updatedAt).toBe("2026-09-30T00:00:00.000Z");
  });

  it("does not expose the initial empty catalog as an authoritative snapshot", () => {
    expect(
      buildDesktopSessionSnapshot({
        catalog: { isReady: false, entries: new Map() },
        readShell: () => shell([]),
        isConnected: () => false,
        sidebar: { sidebarOrder: [], sidebarOrderReady: false },
      }),
    ).toBeNull();
  });

  it.each<readonly [Partial<OrchestrationV2ThreadShell>, string]>([
    [{}, "idle"],
    [completed, "done"],
    [{ ...completed, status: "interrupted" }, "idle"],
    [{ ...completed, status: "cancelled" }, "idle"],
    [{ ...completed, status: "failed" }, "error"],
    [{ ...completed, status: "failed", lastErrorClass: "usage_limit" }, "error"],
    [{ latestRunId: runId, activeRunId: runId, status: "running" }, "working"],
    [{ latestRunId: runId, activeRunId: runId, status: "starting" }, "working"],
    [{ latestRunId: runId, activeRunId: runId, status: "preparing" }, "working"],
    [{ ...completed, pendingBackgroundTasks: [{ taskId: "agent", kind: "subagent" }] }, "working"],
    [{ ...completed, pendingBackgroundTasks: [{ taskId: "dev", kind: "command" }] }, "done"],
    [
      {
        latestRunId: runId,
        activeRunId: runId,
        status: "running",
        pendingRuntimeRequest: pendingRequest("command"),
      },
      "blocked",
    ],
    [{ ...completed, pendingRuntimeRequest: pendingRequest("user_input") }, "blocked"],
    [{ ...completed, interactionMode: "plan", hasActionableProposedPlan: true }, "blocked"],
    [{ ...completed, hasActionableProposedPlan: true }, "done"],
    [
      {
        latestRunId: runId,
        activeRunId: runId,
        status: "running",
        interactionMode: "plan",
        hasActionableProposedPlan: true,
      },
      "working",
    ],
  ])("projects status with precedence %j", (changes, expected) => {
    expect(desktopSessionStatus(presentThreadShell(local, { ...thread, ...changes }))).toBe(
      expected,
    );
  });

  it("excludes subagent threads from the session list", () => {
    const result = buildDesktopSessionSnapshot({
      catalog: catalog([local]),
      readShell: () =>
        shell([
          thread,
          {
            ...thread,
            id: ThreadId.make("child"),
            lineage: {
              rootThreadId: thread.id,
              parentThreadId: thread.id,
              relationshipToParent: "subagent",
            },
          },
        ]),
      isConnected: () => true,
      sidebar: { sidebarOrder: [], sidebarOrderReady: false },
    });
    expect(result?.environments[0]?.sessions.map((session) => session.threadId)).toEqual([
      thread.id,
    ]);
  });

  it("lifts a thread's status with its open side chats but keeps them out of the list", () => {
    const sideChat = (id: string, extra: Partial<OrchestrationV2ThreadShell>) =>
      ({
        ...thread,
        id: ThreadId.make(id),
        sideChat: true,
        lineage: {
          rootThreadId: thread.id,
          parentThreadId: thread.id,
          relationshipToParent: "fork",
        },
        ...extra,
      }) as OrchestrationV2ThreadShell;
    const statusWith = (...sideChats: OrchestrationV2ThreadShell[]) =>
      buildDesktopSessionSnapshot({
        catalog: catalog([local]),
        readShell: () => shell([{ ...thread, ...completed }, ...sideChats]),
        isConnected: () => true,
        sidebar: { sidebarOrder: [], sidebarOrderReady: false },
      })?.environments[0]?.sessions.map((session) => [session.threadId, session.status]);

    expect(statusWith()).toEqual([[thread.id, "done"]]);
    expect(
      statusWith(
        sideChat("side-working", { latestRunId: runId, activeRunId: runId, status: "running" }),
      ),
    ).toEqual([[thread.id, "working"]]);
    expect(
      statusWith(
        sideChat("side-working", { latestRunId: runId, activeRunId: runId, status: "running" }),
        sideChat("side-asking", { pendingRuntimeRequest: pendingRequest("user_input") }),
      ),
    ).toEqual([[thread.id, "blocked"]]);
    // Closed side chats and finished ones leave the thread's own status alone.
    expect(
      statusWith(
        sideChat("side-closed", {
          latestRunId: runId,
          activeRunId: runId,
          status: "running",
          archivedAt: at,
        }),
        sideChat("side-done", completed),
      ),
    ).toEqual([[thread.id, "done"]]);
  });

  it("keeps local and remote identical thread ids separate, includes filtered pins, and reports cached freshness", () => {
    const result = buildDesktopSessionSnapshot({
      catalog: catalog([local, remote]),
      readShell: (id) =>
        shell(
          [
            {
              ...thread,
              ...completed,
              pinnedAt: at,
              worktreePath: id === remote ? "/remote/tree" : null,
            },
            { ...thread, id: ThreadId.make("archived"), archivedAt: at },
          ],
          id === remote ? "cached" : "live",
        ),
      isConnected: (id) => id === local,
      sidebar: {
        sidebarOrderReady: true,
        sidebarOrder: [{ environmentId: local, threadId: thread.id }],
      },
    });
    expect(result?.environments).toMatchObject([
      {
        environmentId: local,
        connected: true,
        freshness: "live",
        sessions: [
          {
            threadId: thread.id,
            isPinned: true,
            directory: "/project",
            completionId: "run",
            updatedAt: time,
          },
        ],
      },
      {
        environmentId: remote,
        connected: false,
        freshness: "cached",
        sessions: [{ threadId: thread.id, isPinned: true, directory: "/remote/tree" }],
      },
    ]);
    expect(result?.environments.map((e) => e.sessions.length)).toEqual([1, 1]);
    expect(result?.sidebarOrder).toEqual([{ environmentId: local, threadId: thread.id }]);
  });

  it("drops removed environments and missing threads from a retained sidebar projection", () => {
    const result = buildDesktopSessionSnapshot({
      catalog: catalog([local]),
      readShell: () => shell([thread]),
      isConnected: () => true,
      sidebar: {
        sidebarOrderReady: true,
        sidebarOrder: [
          { environmentId: remote, threadId: thread.id },
          { environmentId: local, threadId: ThreadId.make("deleted") },
          { environmentId: local, threadId: thread.id },
        ],
      },
    });
    expect(result?.environments.map((e) => e.environmentId)).toEqual([local]);
    expect(result?.sidebarOrder).toEqual([{ environmentId: local, threadId: thread.id }]);
  });

  it("retains published order without a sidebar subscriber", () => {
    const registry = AtomRegistry.make();
    const atom = createDesktopSidebarOrderAtom();
    expect(registry.get(atom)).toEqual({ sidebarOrderReady: false, sidebarOrder: [] });
    const unsubscribe = registry.subscribe(atom, () => undefined);
    const published = {
      sidebarOrderReady: true,
      sidebarOrder: [
        { environmentId: remote, threadId: thread.id },
        { environmentId: local, threadId: thread.id },
      ],
    };
    registry.set(atom, published);
    unsubscribe();
    expect(registry.get(atom)).toEqual(published);
    registry.dispose();
  });
});
