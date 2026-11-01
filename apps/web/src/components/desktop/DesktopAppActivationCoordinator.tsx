import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { handleDesktopAppActivationRequest } from "../../desktopAppActivation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
} from "@t3tools/client-runtime/state/projects";
import { newProjectId } from "../../lib/utils";
import { executeMicroControl } from "../../microControls";
import { readProjects, readThreadShell, waitForProject } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import {
  desktopAppRendererReadinessAtom,
  readDesktopSessionSnapshot,
} from "../../state/desktopSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { reportProjectFailure } from "../../hooks/useProjectGroupUpdate";

export function DesktopAppActivationCoordinator() {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    label: "project unarchive",
  });
  const openThread = useNewThreadHandler();
  const readiness = useAtomValue(desktopAppRendererReadinessAtom);
  const activation = window.desktopBridge?.appActivation;

  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) =>
    handleDesktopAppActivationRequest(request, {
      readSessions: readDesktopSessionSnapshot,
      executeMicroControl: (action) => document.hasFocus() && executeMicroControl(action),
      isEnvironmentConnected: (environmentId) =>
        environments.some(
          (environment) =>
            environment.environmentId === environmentId &&
            environment.connection.phase === "connected",
        ),
      findThread: (ref) => {
        const thread = readThreadShell(ref);
        return thread?.archivedAt == null ? thread : null;
      },
      navigateThread: async (ref) => {
        await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      },
      getTarget: () => {
        if (
          primaryEnvironment?.connection.phase !== "connected" ||
          primaryEnvironment.serverConfig === null
        ) {
          return null;
        }
        return {
          environmentId: primaryEnvironment.environmentId,
          platform: primaryEnvironment.serverConfig.environment.platform.os,
        };
      },
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: (projectRef) => {
        const project = readProjects().find(
          (candidate) =>
            candidate.environmentId === projectRef.environmentId &&
            candidate.id === projectRef.projectId,
        );
        // Opening an archived project's folder again brings the project back.
        if (project?.archivedAt != null) {
          void updateProject({
            environmentId: projectRef.environmentId,
            input: { projectId: projectRef.projectId, archived: false },
          }).then((result) => reportProjectFailure("Failed to unarchive project", result));
        }
        return openThread(projectRef);
      },
    }),
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
