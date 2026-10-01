import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import {
  PrimaryConnectionTarget,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/unstable/reactivity";
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
const thread: OrchestrationThreadShell = {
  id: ThreadId.make("same-id"),
  projectId: ProjectId.make("project"),
  title: "Chat",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: time,
  updatedAt: time,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
};
const completed = {
  turnId: TurnId.make("turn"),
  state: "completed",
  requestedAt: time,
  startedAt: time,
  completedAt: time,
  assistantMessageId: null,
} as const;
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
  threads: readonly OrchestrationThreadShell[],
  status: EnvironmentShellState["status"] = "live",
): EnvironmentShellState {
  return {
    status,
    error: Option.none(),
    snapshot: Option.some({
      snapshotSequence: 1,
      updatedAt: time,
      threads,
      projects: [
        {
          id: thread.projectId,
          title: "Project",
          workspaceRoot: "/project",
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

  it("filters legacy rows to active top-level chats while respecting old-server capabilities", () => {
    const capabilities = { threadSettlement: true, threadSnooze: true };
    expect(isDesktopSidebarThread(thread, capabilities, time)).toBe(true);
    expect(isDesktopSidebarThread({ ...thread, pinnedAt: time }, capabilities, time)).toBe(true);
    expect(
      isDesktopSidebarThread(
        { ...thread, parentThreadId: ThreadId.make("parent") },
        capabilities,
        time,
      ),
    ).toBe(false);
    expect(isDesktopSidebarThread({ ...thread, archivedAt: time }, capabilities, time)).toBe(false);
    const settled = { ...thread, settledOverride: "settled" } as const;
    const snoozed = { ...thread, snoozedUntil: "2026-10-01T10:00:00.000Z" };
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
          { ...thread, latestTurn: completed, latestUserMessageAt: "2026-09-30T00:00:00.000Z" },
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

  it.each<readonly [Partial<OrchestrationThreadShell>, string]>([
    [{}, "idle"],
    [{ latestTurn: completed }, "done"],
    [{ latestTurn: { ...completed, state: "interrupted" } }, "idle"],
    [{ latestTurn: { ...completed, state: "error" } }, "error"],
    [{ latestTurn: { ...completed, state: "running" } }, "working"],
    [{ latestTurn: completed, backgroundLiveness: "working" }, "working"],
    [{ latestTurn: completed, backgroundLiveness: "monitoring" }, "working"],
    [{ hasPendingApprovals: true, backgroundLiveness: "working" }, "blocked"],
    [{ hasPendingUserInput: true }, "blocked"],
    [{ hasActionableProposedPlan: true }, "blocked"],
    ...(["idle", "starting", "running", "ready", "interrupted", "stopped", "error"] as const).map(
      (status) =>
        [
          {
            session: {
              threadId: thread.id,
              status,
              providerName: null,
              runtimeMode: "full-access" as const,
              activeTurnId: null,
              lastError: null,
              updatedAt: time,
            },
          },
          status === "starting" || status === "running"
            ? "working"
            : status === "error"
              ? "error"
              : "idle",
        ] as const,
    ),
  ])("projects status with precedence %j", (changes, expected) => {
    expect(desktopSessionStatus({ ...thread, ...changes })).toBe(expected);
  });

  it("keeps local and remote identical thread ids separate, includes filtered pins, and reports cached freshness", () => {
    const result = buildDesktopSessionSnapshot({
      catalog: catalog([local, remote]),
      readShell: (id) =>
        shell(
          [
            {
              ...thread,
              latestTurn: completed,
              pinnedAt: time,
              worktreePath: id === remote ? "/remote/tree" : null,
            },
            { ...thread, id: ThreadId.make("archived"), archivedAt: time },
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
            completionId: "turn",
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
