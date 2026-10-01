import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DESKTOP_SESSION_LIST_MAX_BYTES = 8 * 1024 * 1024;

export const DesktopAppSessionListRequest = Schema.Struct({
  version: Schema.Literal(1),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("list-sessions"),
});

export const DesktopSessionSummary = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  status: Schema.Literals(["blocked", "working", "done", "idle", "error", "unknown"]),
  updatedAt: Schema.String,
  isPinned: Schema.Boolean,
  completionId: Schema.NullOr(Schema.String),
  directory: Schema.NullOr(Schema.String),
});
export type DesktopSessionSummary = typeof DesktopSessionSummary.Type;

export const DesktopSessionEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  connected: Schema.Boolean,
  freshness: Schema.Literals(["empty", "cached", "synchronizing", "live"]),
  sessions: Schema.Array(DesktopSessionSummary),
});
export type DesktopSessionEnvironment = typeof DesktopSessionEnvironment.Type;

export const DesktopAppSessionListSuccess = Schema.Struct({
  version: Schema.Literal(1),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  type: Schema.Literal("session-list"),
  environments: Schema.Array(DesktopSessionEnvironment),
  sidebarOrder: Schema.Array(Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId })),
  sidebarOrderReady: Schema.Boolean,
});
export type DesktopAppSessionListSuccess = typeof DesktopAppSessionListSuccess.Type;
