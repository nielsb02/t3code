// @effect-diagnostics nodeBuiltinImport:off -- This adapter test binds a real local socket or Windows named pipe and verifies its cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  DesktopAppActivationResponse,
  DESKTOP_SESSION_LIST_MAX_BYTES,
  type DesktopAppActivationRequest,
  type MicroControlAction,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect } from "vite-plus/test";

import { startDesktopAppControlServer } from "./DesktopAppActivation.ts";

const openServers: Array<{ close: () => Promise<void> }> = [];
const decodeResponse = Schema.decodeUnknownSync(DesktopAppActivationResponse);

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function makeTarget(stateDir: string, platform: NodeJS.Platform, userId: number | undefined) {
  return resolveDesktopAppControlAddress({
    stateDir,
    platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: NodePath.join,
  });
}

function request(requestId: string, platform: NodeJS.Platform): DesktopAppActivationRequest {
  return {
    version: 1,
    requestId,
    type: "open-workspace",
    workspaceRoot: NodePath.join(NodeOS.tmpdir(), "project"),
    platform: platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux",
  };
}

function startOkServer(target: ReturnType<typeof makeTarget>, userId: number | undefined) {
  return startDesktopAppControlServer({
    ...target,
    userId,
    handle: async (input) => ({
      version: 1,
      requestId: input.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    }),
    cancel: () => undefined,
    onReclaimError: () => undefined,
  }).then((server) => {
    openServers.push(server);
    return server;
  });
}

function exchange(address: string, payload: unknown) {
  return exchangeLine(address, JSON.stringify(payload));
}

function exchangeLine(address: string, line: string) {
  return new Promise<DesktopAppActivationResponse>((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      try {
        resolve(decodeResponse(JSON.parse(buffer.slice(0, newline))));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("desktop app control server", () => {
  it.effect("returns large session lists and rejects oversized replies without truncation", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-snapshot-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          cancel: () => undefined,
          onReclaimError: () => undefined,
          handle: async (input) => ({
            version: 1,
            requestId: input.requestId,
            ok: true,
            type: "session-list",
            environments: [
              {
                environmentId: EnvironmentId.make("remote"),
                label: "VPS",
                connected: true,
                freshness: "live",
                sessions: [
                  {
                    threadId: ThreadId.make("thread"),
                    title: "x".repeat(
                      input.requestId === "too-large" ? DESKTOP_SESSION_LIST_MAX_BYTES : 70_000,
                    ),
                    status: "idle",
                    updatedAt: "",
                    isPinned: false,
                    completionId: null,
                    directory: null,
                  },
                ],
              },
            ],
            sidebarOrder: [],
            sidebarOrderReady: true,
          }),
        });
        openServers.push(server);
        const response = await exchange(target.address, {
          version: 1,
          requestId: "large",
          type: "list-sessions",
        });
        expect(response).toMatchObject({ ok: true, type: "session-list" });
        if (!response.ok || !("environments" in response)) throw new Error("Missing snapshot");
        expect(response.environments[0]?.sessions[0]?.title).toHaveLength(70_000);
        expect(
          await exchange(target.address, {
            version: 1,
            requestId: "too-large",
            type: "list-sessions",
          }),
        ).toMatchObject({ ok: false, requestId: "too-large", code: "snapshot-too-large" });
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("roundtrips every Micro action and rejects malformed requests before dispatch", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-micro-control-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const received: MicroControlAction[] = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          cancel: () => undefined,
          onReclaimError: () => undefined,
          handle: async (input) => {
            if (input.type !== "micro-control") throw new Error("Unexpected request type");
            received.push(input.action);
            return { version: 1, requestId: input.requestId, ok: true, action: input.action };
          },
        });
        openServers.push(server);
        try {
          const actions: MicroControlAction[] = [
            "dial-clockwise",
            "dial-counterclockwise",
            "dial-press",
            "composer-toggle",
            "new-thread",
            "new-project",
            "latest-message",
            "settle-thread",
            "terminal-toggle",
            "command-palette",
          ];
          for (const action of actions) {
            expect(
              await exchange(target.address, {
                version: 1,
                requestId: action,
                type: "micro-control",
                action,
              }),
            ).toEqual({ version: 1, requestId: action, ok: true, action });
          }
          expect(received).toEqual(actions);

          const payload = {
            version: 1,
            requestId: "invalid-micro",
            type: "micro-control",
            action: "dial-press",
          };
          for (const invalid of [
            { ...payload, version: 2 },
            { ...payload, action: "dial-up" },
            { ...payload, action: undefined },
            { ...payload, action: null },
            { ...payload, type: "micro" },
          ]) {
            expect(await exchange(target.address, invalid)).toMatchObject({
              requestId: payload.requestId,
              ok: false,
              code: "invalid-request",
            });
          }
          expect(await exchangeLine(target.address, "{invalid")).toMatchObject({
            ok: false,
            code: "invalid-request",
          });
          expect(received).toEqual(actions);
        } finally {
          await server.close();
          openServers.splice(openServers.indexOf(server), 1);
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      });
    }),
  );

  it.effect("roundtrips an open-thread request and a renderer rejection", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thread-open-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const environmentId = EnvironmentId.make("target-environment");
        const threadId = ThreadId.make("thread/with space 雪");
        const projectId = ProjectId.make("project-1");
        const navigated: Array<{ environmentId: EnvironmentId; threadId: ThreadId }> = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          cancel: () => undefined,
          onReclaimError: () => undefined,
          handle: async (input) => {
            if (input.type !== "open-thread") throw new Error("Unexpected request type");
            if (input.threadId !== threadId) {
              return {
                version: 1,
                requestId: input.requestId,
                ok: false,
                code: "thread-open-failed",
                message: "Missing session",
              };
            }
            navigated.push({ environmentId: input.environmentId, threadId: input.threadId });
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              environmentId: input.environmentId,
              threadId: input.threadId,
              projectId,
            };
          },
        });
        openServers.push(server);
        const payload = {
          version: 1,
          requestId: "exact-session",
          type: "open-thread",
          environmentId,
          threadId,
        } as const;
        expect(await exchange(target.address, payload)).toEqual({
          version: 1,
          requestId: "exact-session",
          ok: true,
          projectId,
          environmentId,
          threadId,
        });
        expect(navigated).toEqual([{ environmentId, threadId }]);
        expect(
          await exchange(target.address, {
            ...payload,
            requestId: "missing-session",
            threadId: ThreadId.make("missing"),
          }),
        ).toMatchObject({ ok: false, code: "thread-open-failed" });
        expect(navigated).toHaveLength(1);
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("roundtrips a request and removes its socket on shutdown", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-control-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const received: DesktopAppActivationRequest[] = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async (input) => {
            received.push(input);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            };
          },
          cancel: () => undefined,
          onReclaimError: () => undefined,
        });
        openServers.push(server);

        const response = await exchange(target.address, request("request-1", platform));

        expect(received).toHaveLength(1);
        expect(response).toMatchObject({ ok: true, requestId: "request-1" });
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        if (target.directory !== null) {
          await expect(NodeFSP.stat(target.address)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("cancels a queued request when the client disconnects", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-cancel-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        let resolveCanceled: (requestId: string) => void = () => undefined;
        const canceled = new Promise<string>((resolve) => {
          resolveCanceled = resolve;
        });
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: () => new Promise(() => undefined),
          cancel: resolveCanceled,
          onReclaimError: () => undefined,
        });
        openServers.push(server);
        const socket = NodeNet.createConnection(target.address);
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.write(`${JSON.stringify(request("request-canceled", platform))}\n`, () => {
              socket.destroy();
              resolve();
            });
          });
        });

        await expect(canceled).resolves.toBe("request-canceled");
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  // Two desktop apps can share one state dir, such as nightly and a preview build.
  it.effect("keeps a newer app's socket when an older app on the same state dir quits", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-takeover-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const older = await startOkServer(target, userId);
        await startOkServer(target, userId);

        await older.close();

        await expect(
          exchange(target.address, request("after-quit", platform)),
        ).resolves.toMatchObject({ ok: true, requestId: "after-quit" });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("binds its address again after the socket file is removed", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-reclaim-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const server = await startOkServer(target, userId);

        await NodeFSP.unlink(target.address);
        await server.reclaim();

        await expect(
          exchange(target.address, request("reclaimed", platform)),
        ).resolves.toMatchObject({
          ok: true,
          requestId: "reclaimed",
        });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
});
