import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";

const NativeTurn = Schema.Struct({ id: Schema.String, status: Schema.String });
const TurnPage = Schema.Struct({
  data: Schema.Array(NativeTurn),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeTurnPage = Schema.decodeUnknownEffect(TurnPage);
const ForkResult = Schema.Struct({
  cwd: Schema.String,
  model: Schema.String,
  thread: Schema.Struct({
    id: Schema.String,
  }),
});

const decodeForkResult = Schema.decodeUnknownEffect(ForkResult);

export const HANDOFF_DENY_COMMAND = "exit 2";
const handoffToml = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(handoffToml).join(", ")}]`;
  if (value !== null && typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${handoffToml(item)}`)
      .join(", ")} }`;
  return JSON.stringify(value);
};

const HANDOFF_GUARD_STATE = Object.fromEntries(
  ["/<session-flags>/config.toml", "C:\\<session-flags>\\config.toml"].map((path) => [
    `${path}:pre_tool_use:0:0`,
    { trusted_hash: "sha256:01e60a4099b79533d422b3c1d0f25db167401cf097b693e5bb6d4430ee46c72f" },
  ]),
);

export const HANDOFF_CONFIG = {
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.apps": false,
  "features.browser_use": false,
  "features.computer_use": false,
  "features.image_generation": false,
  "features.code_mode": false,
  "features.js_repl": false,
  "features.codex_hooks": true,
  // Codex hashes the normalized hook definition. A changed provider hash fails
  // the native guard check before any helper turn starts.
  "hooks.state": HANDOFF_GUARD_STATE,
  web_search: "disabled",
  notify: [],
  "hooks.PreToolUse": [
    { matcher: ".*", hooks: [{ type: "command", command: HANDOFF_DENY_COMMAND }] },
  ],
  ...Object.fromEntries(
    [
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop",
      "Interrupt",
    ].map((event) => [`hooks.${event}`, []]),
  ),
} satisfies Readonly<Record<string, unknown>>;

export const handoffLaunchArgs = (config: Readonly<Record<string, unknown>> = HANDOFF_CONFIG) =>
  Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${handoffToml(value)}`]);

/** Refuse to generate until the provider confirms a trusted deny-all tool hook. */
export const assertHandoffGuard = Effect.fn("assertHandoffGuard")(function* (
  response: CodexSchema.V2HooksListResponse,
) {
  const hooks = response.data.flatMap((entry) => entry.hooks).filter((hook) => hook.enabled);
  const isGuard = (hook: (typeof hooks)[number]) =>
    hook.eventName === "preToolUse" &&
    hook.command === HANDOFF_DENY_COMMAND &&
    hook.matcher === ".*" &&
    (hook.trustStatus === "trusted" || hook.trustStatus === "managed");
  if (
    response.data.some((entry) => entry.errors.length > 0) ||
    !hooks.some(isGuard) ||
    hooks.some((hook) => !isGuard(hook))
  ) {
    return yield* CodexErrors.CodexAppServerRequestError.invalidParams(
      "Codex could not establish a tool-free handoff session. Update Codex or disable additional hooks for this provider instance.",
    );
  }
});

const HandoffConfigSources = Schema.Struct({
  config: Schema.Struct({
    mcp_servers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    plugins: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});

const decodeHandoffConfigSources = Schema.decodeUnknownEffect(HandoffConfigSources);
const decodeHandoffHooks = Schema.decodeUnknownEffect(CodexSchema.V2HooksListResponse);

export const readHandoffConfig = Effect.fn("readHandoffConfig")(function* (
  client: { readonly raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request"> },
  cwd: string,
) {
  const sources = yield* client.raw
    .request("config/read", { cwd, includeLayers: false })
    .pipe(
      Effect.flatMap((response) =>
        decodeHandoffConfigSources(response).pipe(
          Effect.mapError((cause) =>
            CodexErrors.CodexAppServerRequestError.invalidPayload(
              "config/read",
              "decode-payload",
              cause,
            ),
          ),
        ),
      ),
    );
  const hooks = yield* client.raw
    .request("hooks/list", { cwds: [cwd] })
    .pipe(
      Effect.flatMap((response) =>
        decodeHandoffHooks(response).pipe(
          Effect.mapError((cause) =>
            CodexErrors.CodexAppServerRequestError.invalidPayload(
              "hooks/list",
              "decode-payload",
              cause,
            ),
          ),
        ),
      ),
    );
  return {
    ...HANDOFF_CONFIG,
    "hooks.state": {
      ...Object.fromEntries(
        hooks.data.flatMap((entry) => entry.hooks).map((hook) => [hook.key, { enabled: false }]),
      ),
      ...HANDOFF_GUARD_STATE,
    },
    mcp_servers: Object.fromEntries(
      Object.keys(sources.config.mcp_servers ?? {}).map((name) => [name, { enabled: false }]),
    ),
    plugins: Object.fromEntries(
      Object.keys(sources.config.plugins ?? {}).map((name) => [name, { enabled: false }]),
    ),
  };
});

/** Read and fork through one completed native turn; never resume or rewrite the parent. */
export const forkCodexThread = Effect.fn("forkCodexThread")(
  function* (input: {
    readonly client: {
      readonly raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">;
    };
    readonly sourceThreadId: string;
    readonly params: Omit<CodexSchema.V2ThreadForkParams, "threadId" | "lastTurnId">;
  }) {
    let cursor: string | undefined;
    let lastTurn: typeof NativeTurn.Type | undefined;
    do {
      const page = yield* input.client.raw
        .request("thread/turns/list", {
          threadId: input.sourceThreadId,
          itemsView: "notLoaded",
          sortDirection: "desc",
          limit: 16,
          ...(cursor ? { cursor } : {}),
        })
        .pipe(
          Effect.flatMap((response) =>
            decodeTurnPage(response).pipe(
              Effect.mapError((cause) =>
                CodexErrors.CodexAppServerRequestError.invalidPayload(
                  "thread/turns/list",
                  "decode-payload",
                  cause,
                ),
              ),
            ),
          ),
        );
      lastTurn = page.data.find((turn) => turn.status === "completed");
      cursor = page.nextCursor ?? undefined;
    } while (!lastTurn && cursor);
    if (!lastTurn) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidParams(
        "The parent needs a completed Codex turn before a side chat can inherit its context.",
      );
    }
    const fork = yield* input.client.raw
      .request("thread/fork", {
        ...input.params,
        threadId: input.sourceThreadId,
        lastTurnId: lastTurn.id,
        excludeTurns: true,
      })
      .pipe(
        Effect.flatMap((response) =>
          decodeForkResult(response).pipe(
            Effect.mapError((cause) =>
              CodexErrors.CodexAppServerRequestError.invalidPayload(
                "thread/fork",
                "decode-payload",
                cause,
              ),
            ),
          ),
        ),
      );
    if (fork.thread.id === input.sourceThreadId) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidParams(
        "Codex returned the parent instead of an independent fork.",
      );
    }
    // Ephemeral Codex threads deliberately expose no persisted turn history.
    // Their boundary is enforced by thread/fork's required lastTurnId argument.
    if (input.params.ephemeral) return fork;
    const childPage = yield* input.client.raw
      .request("thread/turns/list", {
        threadId: fork.thread.id,
        itemsView: "notLoaded",
        sortDirection: "desc",
        limit: 1,
      })
      .pipe(
        Effect.flatMap((response) =>
          decodeTurnPage(response).pipe(
            Effect.mapError((cause) =>
              CodexErrors.CodexAppServerRequestError.invalidPayload(
                "thread/turns/list",
                "decode-payload",
                cause,
              ),
            ),
          ),
        ),
      );
    if (
      fork.thread.id === input.sourceThreadId ||
      childPage.data[0]?.id !== lastTurn.id ||
      childPage.data[0]?.status !== "completed"
    ) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidParams(
        "Codex did not return an independent fork at the completed turn. Update Codex before creating a side chat.",
      );
    }
    return fork;
  },
  Effect.mapError((error) =>
    error._tag === "CodexAppServerRequestError" && error.code === -32601
      ? CodexErrors.CodexAppServerRequestError.invalidParams(
          "Native side chats require Codex thread/fork and thread/turns/list support. Update the Codex CLI for this provider instance.",
        )
      : error,
  ),
);

const HandoffMessage = Schema.Struct({
  item: Schema.Struct({
    type: Schema.Literal("agentMessage"),
    phase: Schema.Literal("final_answer"),
    text: Schema.String,
  }),
});
const HandoffTurn = Schema.Struct({
  turn: Schema.Struct({ status: Schema.String }),
});
const isHandoffMessage = Schema.is(HandoffMessage);
const isHandoffTurn = Schema.is(HandoffTurn);
const isRetryingError = Schema.is(Schema.Struct({ willRetry: Schema.Literal(true) }));

export const collectCodexHandoff = Effect.fn("collectCodexHandoff")(function* (
  runtime: Pick<
    import("./CodexSessionRuntime.ts").CodexSessionRuntimeShape,
    "start" | "sendTurn" | "events"
  >,
  prompt: string,
) {
  yield* runtime.start();
  const turn = yield* runtime.sendTurn({
    input: [
      "Prepare a context handoff for another coding agent from this inherited conversation.",
      "Do not implement the task or call tools. Return only the handoff as your final answer.",
      "Include relevant requirements, decisions, constraints, file references, progress, and unresolved questions. Distinguish facts from assumptions. Keep it focused on this assignment:",
      prompt,
    ].join("\n\n"),
  });
  const completion = yield* Deferred.make<string, CodexErrors.CodexAppServerRequestError>();
  let finalAnswer = "";
  const fail = (message: string) =>
    Deferred.fail(completion, CodexErrors.CodexAppServerRequestError.invalidParams(message));
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (
          (event.method === "error" && !isRetryingError(event.payload)) ||
          event.method === "session/exited"
        ) {
          yield* fail("Codex stopped before producing the context handoff. Retry the side chat.");
          return;
        }
        if (event.turnId !== turn.turnId) return;
        if (event.method === "item/completed" && isHandoffMessage(event.payload)) {
          if (finalAnswer.length + event.payload.item.text.length > 64_000) {
            yield* fail(
              "Codex handoff exceeded the supported size. Narrow the side task and retry.",
            );
          } else {
            finalAnswer += event.payload.item.text;
          }
        }
        if (event.method === "turn/completed") {
          if (
            !isHandoffTurn(event.payload) ||
            event.payload.turn.status !== "completed" ||
            !finalAnswer.trim()
          ) {
            yield* fail("Codex did not complete a readable handoff. Retry the side chat.");
          } else {
            yield* Deferred.succeed(completion, finalAnswer.trim());
          }
        }
      }),
    ),
    Effect.forkChild,
  );
  return yield* Deferred.await(completion);
});
