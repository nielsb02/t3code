import * as Schema from "effect/Schema";
import { DesktopAppSessionListRequest, DesktopAppSessionListSuccess } from "./desktopSessions.ts";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION = 1 as const;

export const DesktopAppRendererReady = Schema.Struct({
  ready: Schema.Literal(true),
  primaryEnvironmentReady: Schema.Boolean,
  readyEnvironmentIds: Schema.Array(EnvironmentId),
});
export type DesktopAppRendererReady = typeof DesktopAppRendererReady.Type;

export const DesktopAppRendererReadiness = Schema.Union([
  Schema.Struct({ ready: Schema.Literal(false) }),
  DesktopAppRendererReady,
]);
export type DesktopAppRendererReadiness = typeof DesktopAppRendererReadiness.Type;

export const DesktopAppActivationPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type DesktopAppActivationPlatform = typeof DesktopAppActivationPlatform.Type;

export const MicroDialAction = Schema.Literals([
  "dial-clockwise",
  "dial-counterclockwise",
  "dial-press",
  "composer-toggle",
]);
export type MicroDialAction = typeof MicroDialAction.Type;

export const MicroControlAction = Schema.Union([
  MicroDialAction,
  Schema.Literals([
    "new-thread",
    "new-project",
    "latest-message",
    "settle-thread",
    "terminal-toggle",
    "command-palette",
  ]),
]);
export type MicroControlAction = typeof MicroControlAction.Type;

export const DesktopAppOpenWorkspaceRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("open-workspace"),
  workspaceRoot: TrimmedNonEmptyString,
  platform: DesktopAppActivationPlatform,
});
export const DesktopAppOpenThreadRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("open-thread"),
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export const DesktopAppMicroControlRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("micro-control"),
  action: MicroControlAction,
});
export type DesktopAppMicroControlRequest = typeof DesktopAppMicroControlRequest.Type;

export const DesktopAppActivationRequest = Schema.Union([
  DesktopAppOpenWorkspaceRequest,
  DesktopAppOpenThreadRequest,
  DesktopAppMicroControlRequest,
  DesktopAppSessionListRequest,
]);
export type DesktopAppActivationRequest = typeof DesktopAppActivationRequest.Type;

export const DesktopAppActivationErrorCode = Schema.Literals([
  "invalid-request",
  "renderer-unavailable",
  "environment-unavailable",
  "platform-mismatch",
  "project-create-failed",
  "thread-open-failed",
  "micro-control-unavailable",
  "request-timeout",
  "internal-error",
  "snapshot-too-large",
]);
export type DesktopAppActivationErrorCode = typeof DesktopAppActivationErrorCode.Type;

export const DesktopAppOpenSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  projectId: ProjectId,
  threadId: ThreadId,
  environmentId: Schema.optional(EnvironmentId),
});
export const DesktopAppMicroControlSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  action: MicroControlAction,
});
export type DesktopAppMicroControlSuccess = typeof DesktopAppMicroControlSuccess.Type;

export const DesktopAppActivationSuccess = Schema.Union([
  DesktopAppOpenSuccess,
  DesktopAppMicroControlSuccess,
  DesktopAppSessionListSuccess,
]);
export type DesktopAppActivationSuccess = typeof DesktopAppActivationSuccess.Type;

export const DesktopAppActivationFailure = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(false),
  code: DesktopAppActivationErrorCode,
  message: TrimmedNonEmptyString,
});
export type DesktopAppActivationFailure = typeof DesktopAppActivationFailure.Type;

export const DesktopAppActivationResponse = Schema.Union([
  DesktopAppActivationSuccess,
  DesktopAppActivationFailure,
]);
export type DesktopAppActivationResponse = typeof DesktopAppActivationResponse.Type;

export function matchesDesktopAppActivationResponse(
  request: DesktopAppActivationRequest,
  response: DesktopAppActivationResponse,
): boolean {
  if (response.requestId !== request.requestId) return false;
  if (!response.ok) return true;
  switch (request.type) {
    case "micro-control":
      return "action" in response && response.action === request.action;
    case "list-sessions":
      return "type" in response && response.type === "session-list";
    case "open-thread":
    case "open-workspace":
      return "projectId" in response;
  }
}
