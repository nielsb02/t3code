import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as WorkspaceRepositories from "../workspace/WorkspaceRepositories.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

type ReviewOperation = "ReviewService.getDiffPreview" | "ReviewService.getDiffFileContents";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  const projectionStore = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  const workspaceRepositories = yield* Effect.serviceOption(
    WorkspaceRepositories.WorkspaceRepositories,
  );

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const detectionError =
    (operation: ReviewOperation, cwd: string, detail: string) => (cause: unknown) =>
      new VcsRepositoryDetectionError({ operation, cwd, detail, cause });

  /**
   * A registered project root or active thread checkout, or an available repository its
   * `t3.json` declares. Checked only after the configured roots, so ordinary reviews never
   * read projects or threads.
   */
  const isRegisteredWorkspaceCwd = Effect.fn("ReviewService.isRegisteredWorkspaceCwd")(function* (
    operation: ReviewOperation,
    cwd: string,
    candidate: string,
  ) {
    if (Option.isNone(projectStore)) return false;
    const projects = yield* projectStore.value
      .listShells()
      .pipe(
        Effect.mapError(
          detectionError(operation, cwd, "Failed to validate registered review workspaces."),
        ),
      );
    const checkRoots = Effect.fn(function* (roots: Iterable<string>) {
      for (const root of roots) {
        const activeCwd = yield* canonicalizePath(root);
        if (candidate === activeCwd) return true;
        if (!isWithinRoot(candidate, activeCwd) || Option.isNone(workspaceRepositories)) continue;
        const repositories = yield* workspaceRepositories.value
          .list(activeCwd, { includeIdentity: false })
          .pipe(
            Effect.mapError(
              detectionError(
                operation,
                cwd,
                "Failed to validate workspace repositories for review.",
              ),
            ),
          );
        for (const repository of repositories) {
          if (!repository.available) continue;
          const repositoryRoot = yield* canonicalizePath(repository.cwd);
          if (isWithinRoot(repositoryRoot, activeCwd) && candidate === repositoryRoot) return true;
        }
      }
      return false;
    });
    if (yield* checkRoots(new Set(projects.map((project) => project.workspaceRoot)))) return true;
    if (Option.isNone(projectionStore)) return false;
    // Thread checkouts outside the managed worktree directories are rare, so the thread
    // shells are read only when no project root matched.
    const snapshot = yield* projectionStore.value
      .getShellSnapshot({ location: "active" })
      .pipe(
        Effect.mapError(
          detectionError(operation, cwd, "Failed to validate registered review workspaces."),
        ),
      );
    const projectIds = new Set(projects.map((project) => project.id));
    return yield* checkRoots(
      new Set(
        snapshot.threads.flatMap((thread) =>
          projectIds.has(thread.projectId) && thread.archivedAt === null && thread.worktreePath
            ? [thread.worktreePath]
            : [],
        ),
      ),
    );
  });

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: ReviewOperation,
    cwd: string,
  ) {
    const worktreesDirectories = yield* settings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ worktreesDirectory: "", previousWorktreesDirectories: [] })),
    );
    const [candidate, workspaceRoot, worktreesRoots] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      // A managed root that cannot be resolved, or resolves to a filesystem
      // root through a symlink, is skipped rather than failing every review.
      Effect.forEach(
        managedWorktreesDirectories(worktreesDirectories, config.worktreesDir, path),
        (directory) => canonicalizePath(directory).pipe(Effect.orElseSucceed(() => null)),
      ).pipe(
        Effect.map((roots) =>
          roots.filter((root): root is string => root !== null && !isFilesystemRoot(root, path)),
        ),
      ),
    ]);

    if (
      isWithinRoot(candidate, workspaceRoot) ||
      worktreesRoots.some((root) => isWithinRoot(candidate, root))
    ) {
      return;
    }

    if (yield* isRegisteredWorkspaceCwd(operation, cwd, candidate)) return;

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : "Review diff file contents cwd must stay within the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  return ReviewService.of({
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);
