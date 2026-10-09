import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
  type DesktopAppMicroControlRequest,
  type MicroControlAction,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";

const request: DesktopAppActivationRequest = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
};

const microRequest: DesktopAppMicroControlRequest = {
  version: 1,
  requestId: "micro-1",
  type: "micro-control",
  action: "dial-clockwise",
};

describe("DesktopAppActivationBroker", () => {
  const listRequest = { version: 1, requestId: "list-1", type: "list-sessions" } as const;
  const listSuccess = {
    version: 1,
    requestId: "list-1",
    ok: true,
    type: "session-list",
    environments: [],
    sidebarOrder: [],
    sidebarOrderReady: false,
  } as const;

  const primaryReady = {
    ready: true,
    primaryEnvironmentReady: true,
    readyEnvironmentIds: [],
  } as const;
  const noEnvironmentsReady = {
    ready: true,
    primaryEnvironmentReady: false,
    readyEnvironmentIds: [],
  } as const;

  it("keeps a cold-start workspace request queued until primary readiness while allowing session reads", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    const open = broker.request(request);
    broker.registerRenderer(send, noEnvironmentsReady);
    expect(send).not.toHaveBeenCalled();
    const list = broker.request(listRequest);
    expect(send).toHaveBeenCalledWith(listRequest);
    broker.complete(listSuccess);
    await expect(list).resolves.toEqual(listSuccess);
    broker.registerRenderer(send, primaryReady);
    expect(send).toHaveBeenLastCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("p"),
      threadId: ThreadId.make("t"),
    });
    await expect(open).resolves.toMatchObject({ ok: true });
    broker.close();
  });

  it("waits for the requested remote environment without requiring the primary", async () => {
    const remoteId = EnvironmentId.make("remote");
    const remote = {
      version: 1,
      requestId: "remote-open",
      type: "open-thread",
      environmentId: remoteId,
      threadId: ThreadId.make("t"),
    } as const;
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(send, primaryReady);
    const open = broker.request(remote);
    expect(send).not.toHaveBeenCalled();
    broker.registerRenderer(send, {
      ready: true,
      primaryEnvironmentReady: false,
      readyEnvironmentIds: [remoteId],
    });
    expect(send).toHaveBeenCalledWith(remote);
    broker.complete({
      version: 1,
      requestId: remote.requestId,
      ok: true,
      projectId: ProjectId.make("p"),
      threadId: remote.threadId,
      environmentId: remoteId,
    });
    await expect(open).resolves.toMatchObject({ ok: true });
    broker.close();
  });

  it("reads sessions while navigation is already in flight", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(send, primaryReady);
    const open = broker.request(request);
    const list = broker.request(listRequest);
    expect(send).toHaveBeenNthCalledWith(2, listRequest);
    broker.complete(listSuccess);
    await expect(list).resolves.toEqual(listSuccess);
    broker.close();
    await expect(open).resolves.toMatchObject({ ok: false });
  });

  it("never dispatches a cold-start request after its deadline or cancellation", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
      broker.registerRenderer(send, noEnvironmentsReady);
      const expired = broker.request(request);
      const canceled = broker.request({ ...request, requestId: "canceled" });
      broker.cancel("canceled");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(expired).resolves.toMatchObject({ ok: false, code: "request-timeout" });
      await expect(canceled).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
      broker.registerRenderer(send, primaryReady);
      expect(send).not.toHaveBeenCalled();
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads sessions without revealing or focusing the window", async () => {
    const activate = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    const send = vi.fn();
    broker.registerRenderer(send, primaryReady);
    const response = broker.request(listRequest);
    broker.complete(listSuccess);
    await expect(response).resolves.toEqual(listSuccess);
    expect(send).toHaveBeenCalledWith(listRequest);
    expect(activate).not.toHaveBeenCalled();
    broker.close();
  });

  it("rejects session polling before renderer readiness without activating", async () => {
    const activate = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    await expect(broker.request(listRequest)).resolves.toMatchObject({
      ok: false,
      code: "renderer-unavailable",
    });
    expect(activate).not.toHaveBeenCalled();
    broker.close();
  });

  it("rejects a thread-open response to session polling", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(vi.fn(), primaryReady);
    const response = broker.request(listRequest);
    broker.complete({
      version: 1,
      requestId: "list-1",
      ok: true,
      projectId: ProjectId.make("p"),
      threadId: ThreadId.make("t"),
    });
    await expect(response).resolves.toMatchObject({ ok: false, code: "internal-error" });
    broker.close();
  });

  it("rejects a session list response to a workspace request", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(vi.fn(), primaryReady);
    const response = broker.request(request);
    broker.complete({ ...listSuccess, requestId: request.requestId });
    await expect(response).resolves.toMatchObject({ ok: false, code: "internal-error" });
    broker.close();
  });

  it.each<MicroControlAction>([
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
  ])("dispatches %s without revealing or focusing the window", async (action) => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send, primaryReady);

    const response = broker.request({ ...microRequest, action });
    expect(activate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ ...microRequest, action });
    const success = { version: 1, requestId: microRequest.requestId, ok: true, action } as const;
    broker.complete(success);
    await expect(response).resolves.toEqual(success);
    broker.close();
  });

  it("rejects Micro controls before renderer readiness without revealing the window", async () => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });

    await expect(broker.request(microRequest)).resolves.toMatchObject({
      requestId: microRequest.requestId,
      ok: false,
      code: "renderer-unavailable",
    });
    broker.registerRenderer(send, primaryReady);
    expect(activate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    broker.close();
  });

  it("dispatches queued Micro actions in order and ignores a premature acknowledgement", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(send, primaryReady);
    const second = { ...microRequest, requestId: "micro-2", action: "dial-press" } as const;
    const firstResponse = broker.request(microRequest);
    const secondResponse = broker.request(second);
    const secondSuccess = {
      version: 1,
      requestId: second.requestId,
      ok: true,
      action: second.action,
    } as const;

    broker.complete(secondSuccess);
    expect(send).toHaveBeenCalledTimes(1);
    broker.complete({
      version: 1,
      requestId: microRequest.requestId,
      ok: true,
      action: microRequest.action,
    });
    await expect(firstResponse).resolves.toMatchObject({ ok: true, action: "dial-clockwise" });
    expect(send).toHaveBeenNthCalledWith(2, second);
    broker.complete(secondSuccess);
    await expect(secondResponse).resolves.toEqual(secondSuccess);
    broker.close();
  });

  it.each<DesktopAppActivationResponse>([
    { version: 1, requestId: microRequest.requestId, ok: true, action: "dial-press" },
    {
      version: 1,
      requestId: microRequest.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    },
  ])(
    "rejects a Micro acknowledgement for a different action or request type",
    async (completion) => {
      const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
      broker.registerRenderer(vi.fn(), primaryReady);
      const response = broker.request(microRequest);
      broker.complete(completion);
      await expect(response).resolves.toMatchObject({ ok: false, code: "internal-error" });
      broker.close();
    },
  );

  it("rejects a Micro acknowledgement for a workspace request", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(vi.fn(), primaryReady);
    const response = broker.request(request);
    broker.complete({ version: 1, requestId: request.requestId, ok: true, action: "dial-press" });
    await expect(response).resolves.toMatchObject({ ok: false, code: "internal-error" });
    broker.close();
  });

  it("drops queued Micro actions when the renderer goes away", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(vi.fn(), primaryReady);
    const firstResponse = broker.request(microRequest);
    const secondResponse = broker.request({ ...microRequest, requestId: "micro-2" });
    broker.clearRenderer();
    const send = vi.fn();
    broker.registerRenderer(send, primaryReady);

    await expect(firstResponse).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    await expect(secondResponse).resolves.toMatchObject({
      ok: false,
      code: "renderer-unavailable",
    });
    expect(send).not.toHaveBeenCalled();
    broker.close();
  });

  it("rejects Micro controls if sending to the renderer fails", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(() => {
      throw new Error("Renderer closed.");
    }, primaryReady);
    await expect(broker.request(microRequest)).resolves.toMatchObject({
      ok: false,
      code: "renderer-unavailable",
    });
    broker.close();
  });

  it("focuses immediately and waits for renderer readiness", async () => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });

    const response = broker.request(request);
    expect(activate).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    broker.registerRenderer(send, primaryReady);
    expect(send).toHaveBeenCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: true, projectId: "project-1" });
    broker.close();
  });

  it("fails an in-flight request when the renderer goes away", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(vi.fn(), primaryReady);

    const response = broker.request(request);
    broker.clearRenderer();

    await expect(response).resolves.toMatchObject({
      ok: false,
      code: "renderer-unavailable",
    });
    broker.close();
  });

  it("queues requests after unsubscribe until a new renderer registers", async () => {
    const previousSend = vi.fn();
    const nextSend = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(previousSend, primaryReady);
    broker.clearRenderer();

    const response = broker.request(request);
    expect(previousSend).not.toHaveBeenCalled();
    expect(nextSend).not.toHaveBeenCalled();

    broker.registerRenderer(nextSend, primaryReady);
    expect(nextSend).toHaveBeenCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: true });
    broker.close();
  });

  it("removes a queued request when its CLI connection closes", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });

    const response = broker.request(request);
    broker.cancel(request.requestId);
    broker.registerRenderer(send, primaryReady);

    await expect(response).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(send).not.toHaveBeenCalled();
    broker.close();
  });

  it("never sends a canceled request that was queued behind another request", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(send, primaryReady);
    const secondRequest = { ...request, requestId: "request-2" };

    const firstResponse = broker.request(request);
    const secondResponse = broker.request(secondRequest);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(request);

    broker.cancel(secondRequest.requestId);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(firstResponse).resolves.toMatchObject({ ok: true });
    await expect(secondResponse).resolves.toMatchObject({ ok: false });
    expect(send).toHaveBeenCalledTimes(1);
    broker.close();
  });

  it("times out a request without polling", async () => {
    vi.useFakeTimers();
    try {
      const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
      const response = broker.request(request);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(response).resolves.toMatchObject({ ok: false, code: "request-timeout" });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
