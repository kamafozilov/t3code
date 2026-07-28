// @effect-diagnostics nodeBuiltinImport:off
/**
 * workspaceSymlinks - symlink support for the workspace file index.
 *
 * The native index (`@ff-labs/fff-node`) skips symbolic links entirely, so
 * conventional workspace links such as `CLAUDE.md -> AGENTS.md` never reach the
 * file tree or the composer mention search. This module sweeps them back in.
 *
 * It lives in its own file on purpose. Upstream owns WorkspaceSearchIndex.ts and
 * edits it regularly, so every line this fork adds there is a line that has to
 * be re-merged forever. Keeping the logic here leaves a handful of call sites in
 * the upstream file and nothing else to conflict over. For the same reason the
 * three tiny path helpers below are duplicated rather than imported: a copy of
 * eight trivial lines is cheaper than a permanent coupling to a file we do not
 * control.
 *
 * @module workspaceSymlinks
 */
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { MixedSearchResult } from "@ff-labs/fff-node";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ProjectEntry, ProjectSearchEntriesResult } from "@t3tools/contracts";

const SWEEP_CONCURRENCY = 32;

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function trimDirectorySeparator(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

/**
 * Sweeping only the directories the index already accepted inherits its ignore
 * rules for free: a directory the index excluded is never opened here either,
 * so `node_modules` and friends stay out without duplicating any ignore
 * handling.
 */
function indexedDirectories(result: MixedSearchResult): ReadonlySet<string> {
  // The workspace root itself is always swept; the index does not consistently
  // emit it as a directory item, and root-level links are the common case.
  const directories = new Set<string>([""]);
  for (const item of result.items) {
    const normalizedPath = trimDirectorySeparator(toPosixPath(item.item.relativePath));
    if (item.type === "directory") {
      directories.add(normalizedPath);
      continue;
    }
    // Ancestors of indexed files are real directories even when the index did
    // not return them as items of their own.
    let parentPath = parentPathOf(normalizedPath);
    while (parentPath !== undefined) {
      if (directories.has(parentPath)) break;
      directories.add(parentPath);
      parentPath = parentPathOf(parentPath);
    }
  }
  return directories;
}

function isOutsideRoot(realWorkspaceRoot: string, realTargetPath: string): boolean {
  const relativeRealPath = NodePath.relative(realWorkspaceRoot, realTargetPath);
  return (
    relativeRealPath.startsWith(`..${NodePath.sep}`) ||
    relativeRealPath === ".." ||
    NodePath.isAbsolute(relativeRealPath)
  );
}

const collectCandidates = Effect.fn("workspaceSymlinks.collectCandidates")(function* (
  cwd: string,
  relativeDirectory: string,
) {
  const dirents = yield* Effect.promise(() =>
    NodeFSP.readdir(NodePath.join(cwd, relativeDirectory), { withFileTypes: true }).catch(
      (): NodeFS.Dirent[] => [],
    ),
  );

  const candidates: string[] = [];
  for (const dirent of dirents) {
    if (!dirent.isSymbolicLink()) continue;
    candidates.push(relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name);
  }
  return candidates;
});

/**
 * Only links that resolve to a file inside the workspace root are surfaced.
 * WorkspaceFileSystem.readFile applies the same containment rule, so anything
 * listed here is guaranteed to be openable; dangling links and links escaping
 * the root would otherwise appear in the tree only to fail on click.
 *
 * Symlinked directories are deliberately skipped: traversing them risks cycles
 * and duplicated subtrees, which is a larger decision than surfacing files.
 */
const resolveCandidate = Effect.fn("workspaceSymlinks.resolveCandidate")(function* (
  cwd: string,
  realWorkspaceRoot: string,
  relativePath: string,
) {
  const absolutePath = NodePath.join(cwd, relativePath);
  // stat follows the link, so a dangling link fails here and is dropped.
  const stat = yield* Effect.promise(() => NodeFSP.stat(absolutePath).catch(() => null));
  if (stat === null || !stat.isFile()) return null;

  const realTargetPath = yield* Effect.promise(() =>
    NodeFSP.realpath(absolutePath).catch(() => null),
  );
  if (realTargetPath === null || isOutsideRoot(realWorkspaceRoot, realTargetPath)) return null;

  return { path: relativePath, kind: "file" } satisfies ProjectEntry;
});

/**
 * Never fails: a workspace that cannot be swept degrades to the native index
 * results rather than failing the whole listing.
 */
const sweep = Effect.fn("workspaceSymlinks.sweep")(function* (
  cwd: string,
  result: MixedSearchResult,
) {
  const realWorkspaceRoot = yield* Effect.promise(() => NodeFSP.realpath(cwd).catch(() => cwd));

  const candidateBatches = yield* Effect.forEach(
    [...indexedDirectories(result)],
    (relativeDirectory) => collectCandidates(cwd, relativeDirectory),
    { concurrency: SWEEP_CONCURRENCY },
  );

  const resolved = yield* Effect.forEach(
    candidateBatches.flat(),
    (relativePath) => resolveCandidate(cwd, realWorkspaceRoot, relativePath),
    { concurrency: SWEEP_CONCURRENCY },
  );

  return resolved.filter((entry) => entry !== null);
});

/** Keeps the first occurrence of each path, so ordering decides precedence. */
function dedupeByPath(entries: ReadonlyArray<ProjectEntry>): ProjectEntry[] {
  const seenPaths = new Set<string>();
  const deduped: ProjectEntry[] = [];
  for (const entry of entries) {
    if (seenPaths.has(entry.path)) continue;
    seenPaths.add(entry.path);
    deduped.push(entry);
  }
  return deduped;
}

/**
 * Swept links carry no native relevance score, so they are only allowed ahead
 * of index results when the basename prefix makes the intent unambiguous
 * (typing `CLAUDE` for `CLAUDE.md`). Every weaker match is appended instead, so
 * this can never reorder results the index already ranked.
 */
function partitionMatches(
  symlinkEntries: ReadonlyArray<ProjectEntry>,
  query: string,
): { readonly leading: ProjectEntry[]; readonly trailing: ProjectEntry[] } {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return { leading: [], trailing: [...symlinkEntries] };
  }

  const leading: ProjectEntry[] = [];
  const trailing: ProjectEntry[] = [];
  for (const entry of symlinkEntries) {
    const normalizedPath = entry.path.toLowerCase();
    const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
    if (basename.startsWith(normalizedQuery)) {
      leading.push(entry);
    } else if (normalizedPath.includes(normalizedQuery)) {
      trailing.push(entry);
    }
  }
  return { leading, trailing };
}

export interface WorkspaceSymlinkIndex {
  /** Re-sweeps from a listing the caller already holds and caches the result. */
  readonly resweep: (result: MixedSearchResult) => Effect.Effect<ReadonlyArray<ProjectEntry>>;
  /** Re-sweeps from a listing this module fetches; index failures are ignored. */
  readonly resweepFrom: <E, R>(
    fetchListing: () => Effect.Effect<MixedSearchResult, E, R>,
  ) => Effect.Effect<void, never, R>;
  /** Adds swept links to a full workspace listing. */
  readonly mergeIntoList: (
    entries: ReadonlyArray<ProjectEntry>,
    symlinkEntries: ReadonlyArray<ProjectEntry>,
  ) => ProjectEntry[];
  /** Adds matching cached links to a search result, preserving index ranking. */
  readonly mergeIntoSearch: (
    result: ProjectSearchEntriesResult,
    query: string,
    limit: number,
  ) => Effect.Effect<ProjectSearchEntriesResult>;
}

export const make = Effect.fn("workspaceSymlinks.make")(function* (
  cwd: string,
): Effect.fn.Return<WorkspaceSymlinkIndex> {
  const entriesRef = yield* Ref.make<ReadonlyArray<ProjectEntry>>([]);

  const resweep: WorkspaceSymlinkIndex["resweep"] = Effect.fn("workspaceSymlinks.resweep")(
    function* (result) {
      const symlinkEntries = yield* sweep(cwd, result);
      yield* Ref.set(entriesRef, symlinkEntries);
      return symlinkEntries;
    },
  );

  const resweepFrom: WorkspaceSymlinkIndex["resweepFrom"] = Effect.fn(
    "workspaceSymlinks.resweepFrom",
  )(function* (fetchListing) {
    const result = yield* fetchListing().pipe(Effect.orElseSucceed(() => null));
    if (result === null) return;
    yield* resweep(result);
  });

  const mergeIntoList: WorkspaceSymlinkIndex["mergeIntoList"] = (entries, symlinkEntries) =>
    symlinkEntries.length === 0 ? [...entries] : dedupeByPath([...entries, ...symlinkEntries]);

  const mergeIntoSearch: WorkspaceSymlinkIndex["mergeIntoSearch"] = Effect.fn(
    "workspaceSymlinks.mergeIntoSearch",
  )(function* (result, query, limit) {
    // Reads the cached sweep rather than running one: this path is hit on every
    // keystroke of the composer mention search.
    const { leading, trailing } = partitionMatches(yield* Ref.get(entriesRef), query);
    if (leading.length === 0 && trailing.length === 0) return result;

    const merged = dedupeByPath([...leading, ...result.entries, ...trailing]);
    const entries = merged.slice(0, limit);
    return {
      entries,
      truncated: result.truncated || entries.length < merged.length,
    };
  });

  return { resweep, resweepFrom, mergeIntoList, mergeIntoSearch };
});
