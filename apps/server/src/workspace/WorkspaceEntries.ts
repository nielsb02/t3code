// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectListRepositoriesInput,
  ProjectListRepositoriesResult,
  WorkspaceRepository,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import { expandHomePathWith } from "../pathExpansion.ts";
import * as WorkspaceRepositories from "./WorkspaceRepositories.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedErrorClass<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedErrorClass<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedErrorClass<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspaceRepositories.WorkspaceRepositoryDiscoveryError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly listRepositories: (
      input: ProjectListRepositoriesInput,
    ) => Effect.Effect<ProjectListRepositoriesResult, WorkspaceEntriesError>;
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePathWith(input.partialPath, path));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(expandHomePathWith(input.cwd, path), input.partialPath);
});

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const listRepositories: WorkspaceEntries["Service"]["listRepositories"] = Effect.fn(
    "WorkspaceEntries.listRepositories",
  )(function* (input) {
    return { repositories: yield* repositories.list(yield* normalizeWorkspaceRoot(input.cwd)) };
  });

  const members = Effect.fn("WorkspaceEntries.members")(function* (cwd: string) {
    const result = yield* repositories.list(yield* normalizeWorkspaceRoot(cwd), {
      includeIdentity: false,
    });
    return result.filter((repository) => repository.kind === "root" || repository.available);
  });
  const prefix = (repository: WorkspaceRepository, relative: string) =>
    repository.path === "." ? relative : `${repository.path}/${relative}`;
  const owns = (
    repository: WorkspaceRepository,
    relative: string,
    all: ReadonlyArray<WorkspaceRepository>,
  ) => {
    const fullPath = prefix(repository, relative);
    return !all.some(
      (child) =>
        child.path !== repository.path &&
        child.path !== "." &&
        (fullPath === child.path || fullPath.startsWith(`${child.path}/`)) &&
        (repository.path === "." || child.path.startsWith(`${repository.path}/`)),
    );
  };

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      const currentMembers = yield* members(normalizedCwd).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to discover repositories for index refresh", {
            cwd,
            cause,
          }).pipe(Effect.as([])),
        ),
      );
      for (const repository of currentMembers) {
        for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
          const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(repository.cwd, variant);
          if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
            continue;
          }
          const recoverRefreshFailure = (
            cause:
              | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
              | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
              | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
          ) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("Failed to refresh workspace search index", {
                cwd,
                variant,
                cause,
              });
              yield* workspaceSearchIndexes.invalidate(indexKey);
            });
          yield* Effect.gen(function* () {
            const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
            yield* searchIndex.refresh();
          }).pipe(
            Effect.provide(workspaceSearchIndexes.get(indexKey)),
            Effect.catchTags({
              WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
              WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
              WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
            }),
          );
        }
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const all = yield* members(input.cwd);
      const query = normalizeSearchQuery(input.query, { trimLeadingPattern: /^[@./]+/ });
      const results = yield* Effect.forEach(
        all,
        (repository) =>
          Effect.gen(function* () {
            const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
            const repositoryPrefix = repository.path.toLowerCase();
            const localQuery =
              repository.path !== "." &&
              (query === repositoryPrefix || query.startsWith(`${repositoryPrefix}/`))
                ? query.slice(repositoryPrefix.length).replace(/^\//, "")
                : query;
            const result = yield* searchIndex.search(
              localQuery,
              input.limit,
              input.kind,
              input.imageOnly,
            );
            return {
              ...result,
              entries: result.entries
                .filter((entry) => owns(repository, entry.path, all))
                .map((entry) => ({ ...entry, path: prefix(repository, entry.path) })),
            };
          }).pipe(
            Effect.provide(
              workspaceSearchIndexes.get(
                WorkspaceSearchIndex.workspaceSearchIndexKey(repository.cwd, "paths"),
              ),
            ),
          ),
        { concurrency: 4 },
      );
      const entries = [
        ...new Map(
          results.flatMap((result) => result.entries).map((entry) => [entry.path, entry]),
        ).values(),
      ];
      return {
        entries: entries.slice(0, input.limit),
        truncated: entries.length > input.limit || results.some((result) => result.truncated),
      };
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const all = yield* members(input.cwd);
    const results = yield* Effect.forEach(
      all,
      (repository) =>
        Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          const result = yield* searchIndex.searchContents(input);
          return {
            ...result,
            matches: result.matches
              .filter((match) => owns(repository, match.path, all))
              .map((match) => ({ ...match, path: prefix(repository, match.path) })),
          };
        }).pipe(
          Effect.provide(
            workspaceSearchIndexes.get(
              WorkspaceSearchIndex.workspaceSearchIndexKey(repository.cwd, "content"),
            ),
          ),
        ),
      { concurrency: 4 },
    );
    const matches = results.flatMap((result) => result.matches);
    const regexFallbackError = results.find(
      (result) => result.regexFallbackError,
    )?.regexFallbackError;
    return {
      matches: matches.slice(0, input.limit),
      truncated: matches.length > input.limit || results.some((result) => result.truncated),
      ...(regexFallbackError ? { regexFallbackError } : {}),
    };
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const all = yield* members(input.cwd);
      const results = yield* Effect.forEach(
        all,
        (repository) =>
          Effect.gen(function* () {
            const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
            const result = yield* searchIndex.list();
            return {
              ...result,
              entries: result.entries
                .filter((entry) => owns(repository, entry.path, all))
                .map((entry) => ({ ...entry, path: prefix(repository, entry.path) })),
            };
          }).pipe(
            Effect.provide(
              workspaceSearchIndexes.get(
                WorkspaceSearchIndex.workspaceSearchIndexKey(repository.cwd, "paths"),
              ),
            ),
          ),
        { concurrency: 4 },
      );
      const entries = new Map(
        results.flatMap((result) => result.entries).map((entry) => [entry.path, entry]),
      );
      for (const repository of all) {
        if (repository.path === ".") continue;
        const segments = repository.path.split("/");
        for (let count = 1; count <= segments.length; count++) {
          const directory = segments.slice(0, count).join("/");
          entries.set(directory, { path: directory, kind: "directory" });
        }
      }
      return {
        entries: [...entries.values()]
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, 25_000),
        truncated: entries.size > 25_000 || results.some((result) => result.truncated),
      };
    },
  );

  return WorkspaceEntries.of({ listRepositories, browse, list, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(WorkspaceRepositories.layer),
);
