import { Atom } from "effect/unstable/reactivity";
import type { DesktopAppRendererReady, ScopedThreadRef } from "@t3tools/contracts";
import { environmentCatalog } from "../connection/catalog";
import {
  buildDesktopSessionSnapshot,
  buildDesktopAppRendererReadiness,
  createDesktopSidebarOrderAtom,
} from "../desktopSessions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { environmentShell } from "./shell";

const sidebarOrderAtom = createDesktopSidebarOrderAtom();

export function publishDesktopSidebarOrder(sidebarOrder: readonly ScopedThreadRef[]): void {
  const current = appAtomRegistry.get(sidebarOrderAtom);
  if (
    current.sidebarOrderReady &&
    current.sidebarOrder.length === sidebarOrder.length &&
    current.sidebarOrder.every(
      (ref, index) =>
        ref.environmentId === sidebarOrder[index]?.environmentId &&
        ref.threadId === sidebarOrder[index]?.threadId,
    )
  )
    return;
  appAtomRegistry.set(sidebarOrderAtom, { sidebarOrder, sidebarOrderReady: true });
}

export function readDesktopSessionSnapshot() {
  return buildDesktopSessionSnapshot({
    catalog: appAtomRegistry.get(environmentCatalog.catalogValueAtom),
    readShell: (environmentId) =>
      appAtomRegistry.get(environmentShell.stateValueAtom(environmentId)),
    isConnected: (environmentId) =>
      appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
        .phase === "connected",
    sidebar: appAtomRegistry.get(sidebarOrderAtom),
  });
}

let previousReadiness: DesktopAppRendererReady = {
  ready: true,
  primaryEnvironmentReady: false,
  readyEnvironmentIds: [],
};

export const desktopAppRendererReadinessAtom = Atom.make((get) => {
  const next = buildDesktopAppRendererReadiness({
    catalog: get(environmentCatalog.catalogValueAtom),
    readShell: (environmentId) => get(environmentShell.stateValueAtom(environmentId)),
    isConnected: (environmentId) =>
      get(environmentPresentations.presentationAtom(environmentId))?.connection.phase ===
      "connected",
    hasServerConfig: (environmentId) =>
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig != null,
  });
  if (
    previousReadiness.primaryEnvironmentReady === next.primaryEnvironmentReady &&
    previousReadiness.readyEnvironmentIds.length === next.readyEnvironmentIds.length &&
    next.readyEnvironmentIds.every(
      (id, index) => id === previousReadiness.readyEnvironmentIds[index],
    )
  ) {
    return previousReadiness;
  }
  previousReadiness = next;
  return previousReadiness;
}).pipe(Atom.withLabel("desktop-app-renderer-readiness"));
