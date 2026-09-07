import { EnvironmentId, ProjectId, ThreadId, type MicroControlAction } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppActivationRequest,
  type DesktopAppActivationDependencies,
} from "./desktopAppActivation";

const environmentId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("project-existing");
const createdProjectId = ProjectId.make("project-created");
const threadId = ThreadId.make("thread-1");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
} as const;

function dependencies(
  overrides: Partial<DesktopAppActivationDependencies> = {},
): DesktopAppActivationDependencies {
  return {
    executeMicroControl: vi.fn(() => true),
    isEnvironmentConnected: (id) => id === environmentId,
    findThread: () => ({ projectId: existingProjectId }),
    navigateThread: vi.fn(async () => undefined),
    getTarget: () => ({ environmentId, platform: "linux" }),
    findProject: () => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }),
    createProject: vi.fn(async () => createdProjectId),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId })),
    ...overrides,
  };
}

describe("desktop app activation", () => {
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
  ])("dispatches %s and acknowledges the same accepted action", async (action) => {
    const deps = dependencies({ getTarget: () => null });
    const response = await handleDesktopAppActivationRequest(
      { version: 1, requestId: "micro-1", type: "micro-control", action },
      deps,
    );

    expect(response).toEqual({ version: 1, requestId: "micro-1", ok: true, action });
    expect(deps.executeMicroControl).toHaveBeenCalledWith(action);
    expect(deps.navigateThread).not.toHaveBeenCalled();
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it("rejects Micro controls when the renderer has no focused active chat", async () => {
    const response = await handleDesktopAppActivationRequest(
      { version: 1, requestId: "micro-1", type: "micro-control", action: "dial-press" },
      dependencies({ executeMicroControl: () => false }),
    );

    expect(response).toMatchObject({
      requestId: "micro-1",
      ok: false,
      code: "micro-control-unavailable",
    });
  });

  it("reports a failed Micro handler without acknowledging the action", async () => {
    const response = await handleDesktopAppActivationRequest(
      { version: 1, requestId: "micro-1", type: "micro-control", action: "dial-press" },
      dependencies({
        executeMicroControl: () => {
          throw new Error("Control failed.");
        },
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      code: "internal-error",
      message: "Control failed.",
    });
  });

  const openExisting = {
    version: 1,
    requestId: "open-existing",
    type: "open-thread",
    environmentId,
    threadId,
  } as const;

  it("navigates to the exact existing session without creating a project or thread", async () => {
    const deps = dependencies();
    const response = await handleDesktopAppActivationRequest(openExisting, deps);
    expect(response).toEqual({
      version: 1,
      requestId: "open-existing",
      ok: true,
      environmentId,
      threadId,
      projectId: existingProjectId,
    });
    expect(deps.navigateThread).toHaveBeenCalledWith({ environmentId, threadId });
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it("does not substitute the primary environment for an unavailable target", async () => {
    const deps = dependencies();
    const response = await handleDesktopAppActivationRequest(
      { ...openExisting, environmentId: EnvironmentId.make("other") },
      deps,
    );
    expect(response).toMatchObject({ ok: false, code: "environment-unavailable" });
    expect(deps.navigateThread).not.toHaveBeenCalled();
  });

  it("reports a missing session without creating a replacement", async () => {
    const deps = dependencies({ findThread: () => null });
    const response = await handleDesktopAppActivationRequest(openExisting, deps);
    expect(response).toMatchObject({ ok: false, code: "thread-open-failed" });
    expect(deps.navigateThread).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it("reports a navigation failure instead of acknowledging an unopened session", async () => {
    const deps = dependencies({
      navigateThread: vi.fn(async () => {
        throw new Error("Navigation failed.");
      }),
    });
    const response = await handleDesktopAppActivationRequest(openExisting, deps);
    expect(response).toMatchObject({
      ok: false,
      code: "thread-open-failed",
      message: "Navigation failed.",
    });
  });

  it("uses the requested connected environment even when it is not the primary", async () => {
    const otherId = EnvironmentId.make("other");
    const deps = dependencies({
      isEnvironmentConnected: () => true,
      findThread: vi.fn(() => ({ projectId: existingProjectId })),
    });
    const response = await handleDesktopAppActivationRequest(
      { ...openExisting, environmentId: otherId },
      deps,
    );
    expect(response).toMatchObject({ ok: true, environmentId: otherId, threadId });
    expect(deps.findThread).toHaveBeenCalledWith({ environmentId: otherId, threadId });
    expect(deps.navigateThread).toHaveBeenCalledWith({ environmentId: otherId, threadId });
  });
  it("reuses an existing project and opens a new thread", async () => {
    const deps = dependencies();

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).toHaveBeenCalledWith({ environmentId, projectId: existingProjectId });
    expect(response).toEqual({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: existingProjectId,
      threadId,
    });
  });

  it("waits for a created project before it opens the thread", async () => {
    const order: string[] = [];
    const deps = dependencies({
      findProject: () => null,
      createProject: vi.fn(async () => {
        order.push("create");
        return createdProjectId;
      }),
      waitForProject: vi.fn(async () => {
        order.push("project-event");
      }),
      openThread: vi.fn(async () => {
        order.push("open-thread");
        return { threadId };
      }),
    });

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(order).toEqual(["create", "project-event", "open-thread"]);
    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
  });

  it("rejects a Windows path when the primary environment is WSL", async () => {
    const response = await handleDesktopAppActivationRequest(
      { ...request, platform: "win32" },
      dependencies({ getTarget: () => ({ environmentId, platform: "linux" }) }),
    );

    expect(response).toMatchObject({ ok: false, code: "platform-mismatch" });
  });

  it("returns a project error without opening a thread", async () => {
    const openThread = vi.fn(async () => ({ threadId }));
    const response = await handleDesktopAppActivationRequest(
      request,
      dependencies({
        findProject: () => null,
        createProject: vi.fn(async () => {
          throw new Error("Project path is not available.");
        }),
        openThread,
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      code: "project-create-failed",
      message: "Project path is not available.",
    });
    expect(openThread).not.toHaveBeenCalled();
  });
});
