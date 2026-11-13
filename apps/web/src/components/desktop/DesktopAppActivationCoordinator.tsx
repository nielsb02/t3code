import { useAtomValue } from "@effect/atom-react";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { useOpenLocalWorkspace } from "../../hooks/useOpenLocalWorkspace";
import { desktopAppRendererReadinessAtom } from "../../state/desktopSessions";

export function DesktopAppActivationCoordinator() {
  const openLocalWorkspace = useOpenLocalWorkspace();
  const readiness = useAtomValue(desktopAppRendererReadinessAtom);
  const activation = window.desktopBridge?.appActivation;
  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) =>
    openLocalWorkspace.open(request),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop activation requests over the bridge and marks the renderer ready
  useEffect(() => {
    if (activation === undefined) return;

    const unsubscribe = activation.onRequest((request) => {
      // The broker serializes mutations. Reads must also complete during a slow open request.
      void processRequest(request)
        .then((response) => activation.complete(response))
        .catch(() => undefined);
    });
    return () => {
      void activation.setReady({ ready: false }).catch(() => undefined);
      unsubscribe();
    };
  }, [activation]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes current readiness to the desktop activation broker
  useEffect(() => {
    if (activation === undefined) return;
    let current = true;
    // Skip readiness if React cleans up before this subscription can receive requests.
    queueMicrotask(() => {
      if (current) void activation.setReady(readiness).catch(() => undefined);
    });
    return () => {
      current = false;
    };
  }, [activation, readiness]);

  return null;
}
