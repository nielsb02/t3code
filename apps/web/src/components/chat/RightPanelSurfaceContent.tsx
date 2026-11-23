import { useGT } from "gt-react";
import type {
  EditorId,
  EnvironmentId,
  IssueTrackerKind,
  PreviewAnnotationPayload,
  ProjectId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { lazy, Suspense } from "react";
import { LinkedThreadPane } from "./LinkedThreadPane";
import SideThreadPane from "./SideThreadPane";
import type { ComposerImageAttachment, DraftId } from "../../composerDraftStore";
import type { ShortcutMatchContext } from "../../keybindings";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import {
  PersistentThreadTerminalPanel,
  type PersistentThreadTerminalPanelProps,
} from "../PersistentThreadTerminals";
import { IssueDetailPanel } from "../issue/IssueDetailPanel";
import { pullRequestPanelContext } from "../pullRequest/pullRequestDetail.logic";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { PullRequestDetailGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { ThreadPullRequestsPanel } from "../pullRequest/ThreadPullRequestsPanel";
import { WorkspacePullRequestsPanel } from "../pullRequest/WorkspacePullRequestsPanel";
import type { useWorkspaceRepositories } from "../../hooks/useWorkspaceRepositories";

// Keep composer creation in the opening commit. A lazy Suspense retry can yield
// past Tiptap's unmounted-editor disposal timer before its layout effects run.

const PreviewPanel = lazy(() =>
  import("../preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("../DiffPanel"));
const DevicePanel = lazy(() =>
  import("../device/DevicePanel").then((module) => ({ default: module.DevicePanel })),
);
const FilePreviewPanel = lazy(() => import("../files/FilePreviewPanel"));

type RightPanelTerminalProps = Omit<
  PersistentThreadTerminalPanelProps,
  "visible" | "threadRef" | "surface"
>;

interface RightPanelPullRequestProps {
  readonly capabilityKnown: boolean;
  readonly supported: boolean;
  readonly projectId: ProjectId | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly linkedPullRequest: ThreadLinkedPullRequest | null;
  readonly branchPullRequest: ThreadLinkedPullRequest | null | undefined;
  readonly onBack: (() => void) | undefined;
}

interface RightPanelFileProps {
  readonly projectId?: ProjectId | undefined;
  readonly projectName: string | null;
  readonly workspaceRoot: string | undefined;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly pendingSurfaceIds: ReadonlySet<string>;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function RightPanelSurfaceContent(props: {
  readonly surface: RightPanelSurface | null;
  readonly activeSurfaceId: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly inputActive?: boolean;
  readonly workspaceRepositories?: ReturnType<typeof useWorkspaceRepositories> | null;
  readonly workspacePullRequestLinks?: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly configuredPreviewUrls: ReadonlyArray<string>;
  readonly workspaceMutationId: string | null;
  /** What the diff is read under, as the Changes totals are; see `useWorkspaceRevision`. */
  readonly workspaceRevision: string | null;
  readonly getShortcutContext: () => ShortcutMatchContext;
  readonly onSendAnnotation: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
  readonly terminal: RightPanelTerminalProps;
  readonly pullRequest: RightPanelPullRequestProps;
  readonly issuesSupported: boolean;
  readonly files: RightPanelFileProps;
  readonly sideChatParentPanel: SideChatParentPanel;
}) {
  const { surface, threadRef, visible } = props;
  const gt = useGT();
  if (surface === null) return null;
  switch (surface.kind) {
    case "workspace-pull-requests": {
      const workspace = props.workspaceRepositories;
      if (!workspace || !props.pullRequest.projectId) return null;
      return (
        <WorkspacePullRequestsPanel
          shortcutsEnabled={
            (props.inputActive ?? true) && visible && props.activeSurfaceId === surface.id
          }
          getShortcutContext={props.getShortcutContext}
          threadRef={threadRef}
          projectId={props.pullRequest.projectId}
          repositories={workspace.repositories}
          statuses={workspace.statuses}
          initialRepositoryPath={workspace.gitRepositoryPath}
          composerDraftTarget={props.composerDraftTarget}
          error={workspace.error}
          isPending={workspace.isPending}
          onRefresh={workspace.refresh}
        />
      );
    }
    case "preview":
      return (
        <Suspense fallback={null}>
          <PreviewPanel
            mode="embedded"
            threadRef={threadRef}
            tabId={surface.resourceId}
            configuredUrls={props.configuredPreviewUrls}
            visible={visible}
            onSendAnnotation={props.onSendAnnotation}
          />
        </Suspense>
      );
    case "terminal":
      return (
        <PersistentThreadTerminalPanel
          {...props.terminal}
          visible={visible}
          threadRef={threadRef}
          surface={surface}
        />
      );
    case "diff":
      return (
        <Suspense fallback={null}>
          <DiffPanel
            key={scopedThreadKey(threadRef)}
            mode="embedded"
            composerDraftTarget={props.composerDraftTarget}
            workspaceMutationId={props.workspaceRevision}
            visible={visible}
            {...(props.workspaceRepositories
              ? {
                  repositories: props.workspaceRepositories.repositories,
                  repositoryFilter: props.workspaceRepositories.repositoryFilter,
                  onSelectRepository: props.workspaceRepositories.selectRepository,
                }
              : {})}
          />
        </Suspense>
      );
    case "pull-request": {
      const pullRequest = props.pullRequest;
      if (!pullRequest.capabilityKnown) return <PullRequestDetailGhost />;
      if (!pullRequest.supported) {
        return (
          <PullRequestsUnavailableState
            title={gt("Pull requests unavailable")}
            error={gt("Update this environment's T3 Code server to browse pull requests.")}
          />
        );
      }
      return (
        <PullRequestDetailPanel
          getShortcutContext={props.getShortcutContext}
          shortcutsEnabled={
            (props.inputActive ?? true) && visible && props.activeSurfaceId === surface.id
          }
          key={`${scopedThreadKey(threadRef)}:${surface.id}`}
          environmentId={
            (surface.environmentId as EnvironmentId | undefined) ?? props.environmentId
          }
          onSelectPullRequest={(reference) => {
            useRightPanelStore.getState().openPullRequest(threadRef, {
              ...(surface.environmentId === undefined
                ? {}
                : { environmentId: surface.environmentId }),
              projectId: reference.projectId,
              repository: reference.repository,
              number: reference.number,
              ...(reference.host ? { host: reference.host } : {}),
            });
          }}
          threadRef={threadRef}
          {...(surface.url ? { browserUrl: surface.url } : {})}
          reference={{
            projectId: surface.projectId as ProjectId,
            ...(props.workspacePullRequestLinks &&
            surface.host &&
            surface.projectId === pullRequest.projectId
              ? { workspace: { threadId: threadRef.threadId } }
              : {}),
            ...(surface.host ? { host: surface.host } : {}),
            repository: surface.repository,
            number: surface.number,
          }}
          initialTab={surface.detailTab ?? "summary"}
          revealUrl={surface.revealUrl}
          onRevealSettled={(revealUrl) => {
            useRightPanelStore.getState().settlePullRequestReveal(threadRef, surface.id, revealUrl);
          }}
          onTabChange={(tab) => {
            useRightPanelStore.getState().setPullRequestDetailTab(threadRef, surface.id, tab);
          }}
          context={pullRequestPanelContext(
            {
              projectId: pullRequest.projectId,
              pullRequests: pullRequest.pullRequests,
              linkedPullRequest: pullRequest.linkedPullRequest,
              branchPullRequest: pullRequest.branchPullRequest,
            },
            surface,
          )}
          composerDraftTarget={props.composerDraftTarget}
          onBack={pullRequest.onBack}
        />
      );
    }
    case "issue":
      if (!props.pullRequest.capabilityKnown) return <PullRequestDetailGhost />;
      if (!props.issuesSupported) {
        return (
          <PullRequestsUnavailableState
            title={gt("Issues unavailable")}
            error={gt("Update this environment's T3 Code server to browse issues.")}
          />
        );
      }
      return (
        <IssueDetailPanel
          key={`${surface.environmentId ?? props.environmentId}:${surface.id}`}
          environmentId={
            (surface.environmentId as EnvironmentId | undefined) ?? props.environmentId
          }
          reference={{
            projectId: surface.projectId as ProjectId,
            tracker: surface.tracker as IssueTrackerKind,
            ...(surface.host ? { host: surface.host } : {}),
            scope: surface.scope,
            key: surface.key,
          }}
          threadRef={threadRef}
          onSelectPullRequest={(reference) => {
            useRightPanelStore.getState().openPullRequest(threadRef, {
              ...(surface.environmentId === undefined
                ? {}
                : { environmentId: surface.environmentId }),
              projectId: reference.projectId,
              repository: reference.repository,
              number: reference.number,
              ...(reference.host ? { host: reference.host } : {}),
            });
          }}
          onSelectIssue={({ host, ...reference }) => {
            useRightPanelStore.getState().openIssue(threadRef, {
              ...(surface.environmentId === undefined
                ? {}
                : { environmentId: surface.environmentId }),
              ...reference,
              ...(host ? { host } : {}),
            });
          }}
        />
      );
    case "pull-requests":
      return <ThreadPullRequestsPanel threadRef={threadRef} />;
    case "thread":
      // Not lazy: revealing a suspended tiptap editor tears down its view and crashes the composer.
      return (
        <SideThreadPane
          key={surface.id}
          parentRef={threadRef}
          surface={surface}
          parentPanel={props.sideChatParentPanel}
          onClose={() => props.onCloseSurface(surface)}
        />
      );
    case "linked-thread":
      return (
        <LinkedThreadPane
          key={surface.id}
          panelRef={threadRef}
          surface={surface}
          visible={visible && props.activeSurfaceId === surface.id}
        />
      );
    case "device":
      return (
        <Suspense fallback={null}>
          <DevicePanel
            mode="embedded"
            threadRef={threadRef}
            key={surface.id}
            surface={surface}
            visible={visible}
            onDismissSetup={() => {
              props.onCloseSurface(surface);
              useRightPanelStore.getState().show(threadRef);
            }}
          />
        </Suspense>
      );
    case "files":
    case "file": {
      const files = props.files;
      const attachment = surface.kind === "file" ? surface.attachment : undefined;
      if (!attachment && (files.projectName === null || !files.workspaceRoot)) return null;
      return (
        <Suspense fallback={null}>
          <FilePreviewPanel
            key={`${props.environmentId}:${
              attachment ? `attachment:${attachment.id}` : files.workspaceRoot
            }`}
            environmentId={props.environmentId}
            cwd={files.workspaceRoot ?? ""}
            projectName={files.projectName ?? ""}
            projectId={files.projectId}
            threadRef={threadRef}
            composerDraftTarget={props.composerDraftTarget}
            keybindings={props.keybindings}
            availableEditors={files.availableEditors}
            openInShortcutEnabled={visible}
            relativePath={surface.kind === "file" ? surface.relativePath : null}
            {...(attachment ? { attachment } : {})}
            revealLine={surface.kind === "file" ? (surface.revealLine ?? null) : null}
            revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
            onOpenFile={files.onOpenFile}
            onNavigateFolder={(relativePath, folderTrail, keepSource) =>
              useRightPanelStore
                .getState()
                .navigateFolder(threadRef, surface.id, relativePath, folderTrail, keepSource)
            }
            folderTrail={surface.folderTrail}
            onPendingChange={files.onPendingChange}
            selectedFilePending={surface.kind === "file" && files.pendingSurfaceIds.has(surface.id)}
            workspaceMutationId={props.workspaceMutationId}
          />
        </Suspense>
      );
    }
  }
}
