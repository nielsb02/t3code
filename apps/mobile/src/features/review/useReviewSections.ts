import { useFocusEffect } from "@react-navigation/native";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { environmentSession } from "../../state/session";
import { useCallback, useEffect, useMemo } from "react";

import {
  deriveThreadCheckpointSummaries,
  type ThreadCheckpointSummary,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useWorkspaceRepositories } from "../../state/use-workspace-repositories";
import {
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
} from "./reviewModel";
import {
  setReviewAsyncError,
  setReviewGitSections,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  setReviewTurnDiffLoading,
  type ReviewCacheForThread,
} from "./reviewState";
import { useWorkspaceReviewSources } from "./useWorkspaceReviewSources";

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const enabled = input.enabled ?? true;
  const fileAccessSession = useEnvironmentQuery(
    environmentId === undefined ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const selectedThread = useSelectedThreadProjection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const workspace = useWorkspaceRepositories();
  const { refreshRepositories } = workspace;
  useFocusEffect(
    useCallback(() => {
      if (enabled) refreshRepositories();
    }, [enabled, refreshRepositories]),
  );
  const repositoryFilter = workspace.repositoryFilter;
  // Live and branch review read every declared repository; a plain checkout is its only one.
  const repositories = useMemo(
    () =>
      workspace.repositories.length
        ? workspace.repositories
        : selectedThreadCwd
          ? [{ path: ".", cwd: selectedThreadCwd, available: true }]
          : [],
    [workspace.repositories, selectedThreadCwd],
  );
  const diffPreview = useWorkspaceReviewSources(
    environmentId,
    repositories,
    canReadFiles && enabled,
  );
  const selectedEntries = useMemo(
    () =>
      diffPreview.entries.filter(
        ({ repository }) => repositoryFilter === null || repository.path === repositoryFilter,
      ),
    [diffPreview.entries, repositoryFilter],
  );
  const gitSections = useMemo(
    () =>
      (["working-tree", "branch-range"] as const).flatMap((kind) => {
        const entries = selectedEntries.filter(({ source }) => source.kind === kind);
        const first = entries[0];
        return first
          ? [
              {
                ...first.source,
                ...(entries.length > 1
                  ? { files: undefined, truncated: entries.some(({ source }) => source.truncated) }
                  : {}),
                diff: entries.map(({ source }) => source.diff).join("\n"),
              },
            ]
          : [];
      }),
    [selectedEntries],
  );
  const { loadingTurnIds } = reviewCache.asyncState;

  useEffect(() => {
    if (reviewCache.threadKey && diffPreview.hasData) {
      setReviewGitSections(reviewCache.threadKey, gitSections);
    }
  }, [diffPreview.hasData, gitSections, reviewCache.threadKey]);

  const readyCheckpoints = useMemo(
    () =>
      getReadyReviewCheckpoints(
        selectedThread === null ? [] : deriveThreadCheckpointSummaries(selectedThread.projection),
      ),
    [selectedThread],
  );
  const checkpointBySectionId = useMemo(
    () =>
      Object.fromEntries(
        readyCheckpoints.map((checkpoint) => [
          getReviewSectionIdForCheckpoint(checkpoint),
          checkpoint,
        ]),
      ) as Record<string, ThreadCheckpointSummary>,
    [readyCheckpoints],
  );
  const reviewSections = useMemo(() => {
    const sections = buildReviewSectionItems({
      checkpoints: readyCheckpoints,
      gitSections:
        canReadFiles || fileAccess.isPending
          ? diffPreview.hasData
            ? gitSections
            : reviewCache.gitSections
          : [],
      turnDiffById: reviewCache.turnDiffById,
      loadingTurnIds,
      loadingGitSections: fileAccess.isPending || diffPreview.isPending,
    }).map((section) => {
      if (section.kind === "turn") return section;
      const entries = selectedEntries.filter(({ source }) => source.kind === section.kind);
      return {
        ...section,
        sourceCwd: entries[0]?.repository.cwd,
        subtitle:
          repositoryFilter === null && repositories.length > 1
            ? "All workspace repositories"
            : section.subtitle,
        // Several repositories render as one diff with repository-prefixed paths.
        ...(entries.length > 1
          ? {
              repositoryDiffs: entries.map(({ repository, source }) => ({
                path: repository.path,
                diff: source.diff,
                truncated: source.truncated,
              })),
            }
          : {}),
      };
    });
    // Keep the selected section while its grant loads, without displaying cached host files.
    return fileAccess.isPending
      ? sections.map((section) =>
          section.kind === "turn" ? section : { ...section, diff: null, isLoading: true },
        )
      : sections;
  }, [
    canReadFiles,
    diffPreview.hasData,
    diffPreview.isPending,
    fileAccess.isPending,
    gitSections,
    loadingTurnIds,
    readyCheckpoints,
    repositories.length,
    repositoryFilter,
    reviewCache.gitSections,
    reviewCache.turnDiffById,
    selectedEntries,
  ]);
  const selectedSection = useMemo(
    () =>
      reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
      reviewSections[0] ??
      null,
    [reviewCache.selectedSectionId, reviewSections],
  );
  const fallbackSectionId = useMemo(
    () => getDefaultReviewSectionId(reviewSections),
    [reviewSections],
  );
  const selectedSectionIdExists = useMemo(
    () =>
      reviewCache.selectedSectionId
        ? reviewSections.some((section) => section.id === reviewCache.selectedSectionId)
        : false,
    [reviewCache.selectedSectionId, reviewSections],
  );

  useEffect(() => {
    if (
      reviewSections.length > 0 &&
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId || !selectedSectionIdExists)
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackSectionId);
    }
  }, [
    fallbackSectionId,
    reviewCache.selectedSectionId,
    reviewCache.threadKey,
    reviewSections.length,
    selectedSectionIdExists,
  ]);

  let activeCheckpoint = readyCheckpoints[0] ?? null;
  if (selectedSection?.kind === "turn") {
    activeCheckpoint = checkpointBySectionId[selectedSection.id] ?? activeCheckpoint;
  }
  const activeSectionId = activeCheckpoint
    ? getReviewSectionIdForCheckpoint(activeCheckpoint)
    : null;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: enabled ? (environmentId ?? null) : null,
    threadId: enabled ? (threadId ?? null) : null,
    fromTurnCount:
      enabled && activeCheckpoint ? Math.max(0, activeCheckpoint.checkpointTurnCount - 1) : null,
    toTurnCount: enabled ? (activeCheckpoint?.checkpointTurnCount ?? null) : null,
    ignoreWhitespace: false,
  });

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId) {
      return;
    }
    setReviewTurnDiffLoading(reviewCache.threadKey, activeSectionId, activeTurnDiff.isPending);
  }, [activeSectionId, activeTurnDiff.isPending, reviewCache.threadKey]);

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId || !activeTurnDiff.data) {
      return;
    }
    setReviewTurnDiff(reviewCache.threadKey, activeSectionId, activeTurnDiff.data.diff);
    setReviewAsyncError(reviewCache.threadKey, null);
  }, [activeSectionId, activeTurnDiff.data, reviewCache.threadKey]);

  useEffect(() => {
    if (reviewCache.threadKey && activeTurnDiff.error) {
      setReviewAsyncError(reviewCache.threadKey, activeTurnDiff.error);
    }
  }, [activeTurnDiff.error, reviewCache.threadKey]);

  const refreshSelectedSection = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (selectedSection?.kind === "turn") {
      activeTurnDiff.refresh();
      return;
    }
    refreshRepositories();
    diffPreview.refresh();
  }, [activeTurnDiff, diffPreview, enabled, refreshRepositories, selectedSection?.kind]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }
    },
    [reviewCache.threadKey],
  );

  return {
    repositories,
    repositoryFilter,
    selectRepositoryFilter: workspace.selectRepository,
    error:
      workspace.repositoryError ??
      diffPreview.error ??
      activeTurnDiff.error ??
      reviewCache.asyncState.error ??
      (selectedSection === null && !fileAccess.isPending && !canReadFiles
        ? (fileAccess.error ?? "This connection cannot read local diffs.")
        : null),
    isSelectedSectionPending:
      selectedSection?.kind === "turn" ? activeTurnDiff.isPending : diffPreview.isPending,
    loadingGitDiffs: fileAccess.isPending || diffPreview.isPending,
    diffPreviewRevision: diffPreview.hasData
      ? JSON.stringify(
          selectedEntries.map(({ repository, source }) => [repository.path, source.diffHash]),
        )
      : undefined,
    loadingTurnIds,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
  };
}
