import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DesktopAppSessionListRequest, DesktopAppSessionListSuccess } from "./desktopSessions.js";

const isSessionListRequest = Schema.is(DesktopAppSessionListRequest);
const isSessionListSuccess = Schema.is(DesktopAppSessionListSuccess);

describe("desktop session snapshots", () => {
  it("accepts a local read request and mixed-environment snapshot", () => {
    expect(
      isSessionListRequest({
        version: 1,
        requestId: "poll",
        type: "list-sessions",
      }),
    ).toBe(true);
    expect(
      isSessionListSuccess({
        version: 1,
        requestId: "poll",
        ok: true,
        type: "session-list",
        environments: [
          {
            environmentId: "remote",
            label: "VPS",
            connected: false,
            freshness: "cached",
            sessions: [
              {
                threadId: "thread",
                title: "Work",
                status: "working",
                updatedAt: "2026-09-29",
                isPinned: false,
                completionId: null,
                directory: null,
              },
            ],
          },
        ],
        sidebarOrder: [{ environmentId: "remote", threadId: "thread" }],
        sidebarOrderReady: true,
      }),
    ).toBe(true);
  });
  it("rejects replies without freshness or a response kind", () => {
    expect(
      isSessionListSuccess({
        version: 1,
        requestId: "poll",
        ok: true,
        environments: [],
        sidebarOrder: [],
        sidebarOrderReady: true,
      }),
    ).toBe(false);
    expect(
      isSessionListSuccess({
        version: 1,
        requestId: "poll",
        ok: true,
        type: "session-list",
        environments: [{ environmentId: "remote", label: "VPS", connected: true, sessions: [] }],
        sidebarOrder: [],
        sidebarOrderReady: true,
      }),
    ).toBe(false);
  });
});
