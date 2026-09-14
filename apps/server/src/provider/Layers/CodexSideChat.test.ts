import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe } from "vite-plus/test";
import {
  assertHandoffGuard,
  forkCodexThread,
  readHandoffConfig,
  HANDOFF_CONFIG,
  handoffLaunchArgs,
} from "./CodexSideChat.ts";

describe("native Codex side chat", () => {
  it.effect(
    "forks a completed native turn using metadata only and verifies the child boundary",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ method: string; params: unknown }> = [];
        let page = 0;
        const result = yield* forkCodexThread({
          sourceThreadId: "native-parent",
          params: { cwd: "/project" },
          client: {
            raw: {
              request: (method, params) => {
                requests.push({ method, params });
                if (method === "thread/fork")
                  return Effect.succeed({
                    cwd: "/project",
                    model: "codex",
                    thread: { id: "native-child" },
                  });
                return Effect.succeed({
                  data:
                    ++page === 1
                      ? [
                          { id: "running-2", status: "inProgress" },
                          { id: "completed-1", status: "completed" },
                        ]
                      : [{ id: "completed-1", status: "completed" }],
                });
              },
            },
          },
        });
        NodeAssert.equal(result.thread.id, "native-child");
        NodeAssert.deepEqual(requests, [
          {
            method: "thread/turns/list",
            params: {
              threadId: "native-parent",
              itemsView: "notLoaded",
              sortDirection: "desc",
              limit: 16,
            },
          },
          {
            method: "thread/fork",
            params: {
              threadId: "native-parent",
              cwd: "/project",
              lastTurnId: "completed-1",
              excludeTurns: true,
            },
          },
          {
            method: "thread/turns/list",
            params: {
              threadId: "native-child",
              itemsView: "notLoaded",
              sortDirection: "desc",
              limit: 1,
            },
          },
        ]);
      }),
  );

  it.effect("forks ephemeral context without requesting unsupported child history", () =>
    Effect.gen(function* () {
      const methods: string[] = [];
      const result = yield* forkCodexThread({
        sourceThreadId: "parent",
        params: { ephemeral: true },
        client: {
          raw: {
            request: (method, params) => {
              methods.push(method);
              if (method === "thread/fork") {
                NodeAssert.equal((params as { excludeTurns: boolean }).excludeTurns, true);
                return Effect.succeed({
                  cwd: "/project",
                  model: "codex",
                  thread: { id: "ephemeral-child" },
                });
              }
              return Effect.succeed({ data: [{ id: "completed", status: "completed" }] });
            },
          },
        },
      });
      NodeAssert.equal(result.thread.id, "ephemeral-child");
      NodeAssert.deepEqual(methods, ["thread/turns/list", "thread/fork"]);
    }),
  );

  it.effect("requires a completed parent turn", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const result = yield* forkCodexThread({
        sourceThreadId: "parent",
        params: {},
        client: {
          raw: {
            request: (method) => {
              requests.push(method);
              return Effect.succeed({ data: [{ id: "turn", status: "inProgress" }] });
            },
          },
        },
      }).pipe(Effect.result);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.deepEqual(requests, ["thread/turns/list"]);
    }),
  );

  it.effect("does not fall back to replay or a fresh session on unsupported providers", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const result = yield* forkCodexThread({
        sourceThreadId: "parent",
        params: {},
        client: {
          raw: {
            request: (method) => {
              requests.push(method);
              return method === "thread/turns/list"
                ? Effect.succeed({ data: [{ id: "turn", status: "completed" }] })
                : Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method));
            },
          },
        },
      }).pipe(Effect.result);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.deepEqual(requests, ["thread/turns/list", "thread/fork"]);
    }),
  );

  it.effect("rejects providers that ignore the requested completed-turn boundary", () =>
    Effect.gen(function* () {
      let page = 0;
      const result = yield* forkCodexThread({
        sourceThreadId: "parent",
        params: {},
        client: {
          raw: {
            request: (method) =>
              Effect.succeed(
                method === "thread/fork"
                  ? { cwd: "/project", model: "codex", thread: { id: "child" } }
                  : {
                      data:
                        ++page === 1
                          ? [{ id: "turn", status: "completed" }]
                          : [{ id: "later", status: "inProgress" }],
                    },
              ),
          },
        },
      }).pipe(Effect.result);
      NodeAssert.equal(result._tag, "Failure");
    }),
  );

  it.effect("isolates inherited hooks without losing the trusted tool guard", () =>
    Effect.gen(function* () {
      const inheritedKey = "/Users/test/.codex/hooks.json:session_start:0:0";
      const guardKey = "/<session-flags>/config.toml:pre_tool_use:0:0";
      const config = yield* readHandoffConfig(
        {
          raw: {
            request: (method) =>
              method === "config/read"
                ? Effect.succeed({ config: {} })
                : Effect.succeed({
                    data: [
                      {
                        cwd: "/project",
                        errors: [],
                        warnings: [],
                        hooks: [
                          { ...guard, key: guardKey },
                          {
                            ...guard,
                            key: inheritedKey,
                            eventName: "sessionStart",
                            source: "user",
                            sourcePath: "/Users/test/.codex/hooks.json",
                            command: "inherited-hook",
                          },
                        ],
                      },
                    ],
                  }),
          },
        },
        "/project",
      );
      NodeAssert.deepEqual(config["hooks.state"], {
        [inheritedKey]: { enabled: false },
        ...HANDOFF_CONFIG["hooks.state"],
      });
      const args = handoffLaunchArgs(config);
      const stateArg = args.find((arg) => arg.startsWith("hooks.state="));
      NodeAssert.ok(
        stateArg?.includes(
          '"/Users/test/.codex/hooks.json:session_start:0:0" = { "enabled" = false }',
        ),
      );
      NodeAssert.ok(stateArg?.includes('"trusted_hash" = "sha256:'));
    }),
  );

  it.effect("disables configured MCP servers and plugins in a handoff", () =>
    Effect.gen(function* () {
      const config = yield* readHandoffConfig(
        {
          raw: {
            request: (method) =>
              method === "hooks/list"
                ? Effect.succeed({ data: [] })
                : Effect.succeed({
                    config: {
                      mcp_servers: { workspace: { command: "workspace-tool" } },
                      plugins: { browser: { enabled: true } },
                    },
                  }),
          },
        },
        "/project",
      );
      NodeAssert.deepEqual(config.mcp_servers, { workspace: { enabled: false } });
      NodeAssert.deepEqual(config.plugins, { browser: { enabled: false } });
    }),
  );
});

const guard: CodexSchema.V2HooksListResponse__HookMetadata = {
  command: "exit 2",
  currentHash: "hash",
  displayOrder: 0,
  enabled: true,
  eventName: "preToolUse",
  handlerType: "command",
  isManaged: false,
  key: "guard",
  matcher: ".*",
  source: "sessionFlags",
  sourcePath: "/<session-flags>/config.toml",
  timeoutSec: 600,
  trustStatus: "trusted",
};
describe("handoff tool guard", () => {
  it.effect("accepts a trusted provider-confirmed deny-all hook", () =>
    assertHandoffGuard({ data: [{ cwd: "/project", hooks: [guard], warnings: [], errors: [] }] }),
  );
  for (const hooks of [
    [],
    [{ ...guard, trustStatus: "untrusted" as const }],
    [guard, { ...guard, command: "other-hook" }],
  ]) {
    it.effect("refuses missing, untrusted, or additional executable hooks", () =>
      Effect.gen(function* () {
        const result = yield* assertHandoffGuard({
          data: [{ cwd: "/project", hooks, warnings: [], errors: [] }],
        }).pipe(Effect.result);
        NodeAssert.equal(result._tag, "Failure");
      }),
    );
  }
});
