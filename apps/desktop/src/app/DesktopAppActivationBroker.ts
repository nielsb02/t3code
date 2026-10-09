// @effect-diagnostics globalTimers:off -- This protocol broker owns cancellable request deadlines outside the Effect runtime.
import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  matchesDesktopAppActivationResponse,
  type DesktopAppActivationFailure,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
  type DesktopAppRendererReady,
  type EnvironmentId,
} from "@t3tools/contracts";

interface PendingActivation {
  readonly request: DesktopAppActivationRequest;
  readonly resolve: (response: DesktopAppActivationResponse) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  dispatched: boolean;
}

type RendererSender = (request: DesktopAppActivationRequest) => void;

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    ok: false,
    code,
    message,
  };
}

/** Holds CLI requests until the real desktop renderer is ready to handle them. */
export class DesktopAppActivationBroker {
  readonly #pending = new Map<string, PendingActivation>();
  readonly #requestTimeoutMs: number;
  readonly #activate: () => void;
  #renderer: RendererSender | null = null;
  #closed = false;
  #primaryEnvironmentReady = false;
  #readyEnvironmentIds = new Set<EnvironmentId>();

  constructor(input: { readonly requestTimeoutMs: number; readonly activate: () => void }) {
    this.#requestTimeoutMs = input.requestTimeoutMs;
    this.#activate = input.activate;
  }

  request(request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> {
    if (this.#closed) {
      return Promise.resolve(
        failure(request.requestId, "renderer-unavailable", "T3 Code is shutting down."),
      );
    }
    if (this.#pending.has(request.requestId)) {
      return Promise.resolve(
        failure(request.requestId, "invalid-request", "The request id is already in use."),
      );
    }
    if (
      (request.type === "micro-control" || request.type === "list-sessions") &&
      this.#renderer === null
    ) {
      return Promise.resolve(
        failure(request.requestId, "renderer-unavailable", "The T3 Code window is not ready."),
      );
    }

    const response = new Promise<DesktopAppActivationResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this.#settle(
          failure(
            request.requestId,
            "request-timeout",
            "The desktop app did not finish the request in time.",
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(request.requestId, {
        request,
        resolve,
        timeout,
        dispatched: false,
      });
    });

    if (request.type === "open-workspace" || request.type === "open-thread") this.#activate();
    this.#flush();
    return response;
  }

  registerRenderer(send: RendererSender, readiness: DesktopAppRendererReady): void {
    this.#renderer = send;
    this.#primaryEnvironmentReady = readiness.primaryEnvironmentReady;
    this.#readyEnvironmentIds = new Set(readiness.readyEnvironmentIds);
    this.#flush();
  }

  clearRenderer(): void {
    this.#renderer = null;
    this.#primaryEnvironmentReady = false;
    this.#readyEnvironmentIds.clear();
    for (const pending of this.#pending.values()) {
      if (
        pending.dispatched ||
        pending.request.type === "micro-control" ||
        pending.request.type === "list-sessions"
      ) {
        this.#settle(
          failure(
            pending.request.requestId,
            "renderer-unavailable",
            "The T3 Code window became unavailable before it completed the request.",
          ),
        );
      }
    }
  }

  complete(response: DesktopAppActivationResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending?.dispatched) return;
    if (!matchesDesktopAppActivationResponse(pending.request, response)) {
      this.#settle(
        failure(
          response.requestId,
          "internal-error",
          "The renderer response did not match the request.",
        ),
      );
      return;
    }
    this.#settle(response);
  }

  cancel(requestId: string): void {
    this.#settle(
      failure(requestId, "renderer-unavailable", "The command closed before T3 Code was ready."),
    );
  }

  close(): void {
    this.#closed = true;
    this.#renderer = null;
    for (const pending of this.#pending.values()) {
      this.#settle(
        failure(pending.request.requestId, "renderer-unavailable", "T3 Code is shutting down."),
      );
    }
  }

  #flush(): void {
    const renderer = this.#renderer;
    if (renderer === null) return;
    let mutationInFlight = [...this.#pending.values()].some(
      (pending) => pending.dispatched && pending.request.type !== "list-sessions",
    );

    for (const pending of this.#pending.values()) {
      if (pending.dispatched) continue;
      const request = pending.request;
      if (request.type !== "list-sessions") {
        if (mutationInFlight) continue;
        if (request.type === "open-workspace" && !this.#primaryEnvironmentReady) continue;
        if (request.type === "open-thread" && !this.#readyEnvironmentIds.has(request.environmentId))
          continue;
        mutationInFlight = true;
      }
      try {
        pending.dispatched = true;
        renderer(request);
      } catch {
        pending.dispatched = false;
        this.clearRenderer();
        return;
      }
    }
  }

  #settle(response: DesktopAppActivationResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(response.requestId);
    pending.resolve(response);
    this.#flush();
  }
}
