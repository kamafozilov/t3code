// @effect-diagnostics nodeBuiltinImport:off
/**
 * Exercises symlink support through the real WorkspaceEntries service, the
 * native index and a real filesystem, because the behaviour under test is the
 * interaction between them rather than any single function.
 *
 * Kept out of WorkspaceEntries.test.ts on purpose: that file belongs to
 * upstream, and a test file of our own can never conflict on sync. The small
 * harness below is duplicated for the same reason.
 */
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-symlinks-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

function symlink(
  cwd: string,
  target: string,
  relativePath: string,
): Effect.Effect<void, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* Effect.promise(() => NodeFSP.symlink(target, path.join(cwd, relativePath)));
  });
}

const listEntries = (cwd: string) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.list({ cwd });
  });

it.layer(TestLayer, { excludeTestServices: true })("workspaceSymlinks", (it) => {
  describe("list", () => {
    it.effect("surfaces symlinked files alongside indexed files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir("t3code-workspace-symlink-");
        yield* writeTextFile(cwd, "AGENTS.md", "# agents\n");
        yield* writeTextFile(cwd, "docs/guide.md", "# guide\n");
        yield* symlink(cwd, "AGENTS.md", "CLAUDE.md");
        yield* symlink(cwd, "../AGENTS.md", "docs/AGENTS.md");

        const result = yield* listEntries(cwd);

        expect(result.entries).toEqual(
          expect.arrayContaining([
            { path: "CLAUDE.md", kind: "file" },
            { path: "docs/AGENTS.md", kind: "file" },
          ]),
        );
      }),
    );

    it.effect("omits dangling, escaping, and directory symlinks", () =>
      Effect.gen(function* () {
        const outside = yield* makeTempDir("t3code-workspace-symlink-outside-");
        yield* writeTextFile(outside, "secret.md", "# secret\n");

        const cwd = yield* makeTempDir("t3code-workspace-symlink-invalid-");
        yield* writeTextFile(cwd, "AGENTS.md", "# agents\n");
        yield* writeTextFile(cwd, "docs/guide.md", "# guide\n");
        yield* symlink(cwd, "MISSING.md", "dangling.md");
        yield* symlink(cwd, `${outside}/secret.md`, "escaping.md");
        yield* symlink(cwd, "docs", "linked-docs");

        const result = yield* listEntries(cwd);
        const paths = result.entries.map((entry) => entry.path);

        // A dangling link would fail on open, and an escaping link is rejected
        // by WorkspaceFileSystem.readFile, so neither belongs in the tree.
        expect(paths).not.toContain("dangling.md");
        expect(paths).not.toContain("escaping.md");
        // Symlinked directories are skipped rather than traversed.
        expect(paths).not.toContain("linked-docs");
        expect(paths.some((entryPath) => entryPath.startsWith("linked-docs/"))).toBe(false);
        expect(paths).toContain("AGENTS.md");
      }),
    );

    it.effect("leaves symlinks inside ignored directories hidden", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir("t3code-workspace-symlink-ignored-");
        yield* writeTextFile(cwd, "AGENTS.md", "# agents\n");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js", "module.exports = {};\n");
        yield* symlink(cwd, "../../AGENTS.md", "node_modules/pkg/LINKED.md");

        const result = yield* listEntries(cwd);

        expect(result.entries.some((entry) => entry.path.startsWith("node_modules"))).toBe(false);
      }),
    );

    it.effect("picks up symlinks created after the index was built", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir("t3code-workspace-symlink-late-");
        yield* writeTextFile(cwd, "AGENTS.md", "# agents\n");

        const before = yield* listEntries(cwd);
        expect(before.entries.map((entry) => entry.path)).not.toContain("CLAUDE.md");

        yield* symlink(cwd, "AGENTS.md", "CLAUDE.md");
        const after = yield* listEntries(cwd);

        expect(after.entries.map((entry) => entry.path)).toContain("CLAUDE.md");
      }),
    );
  });

  describe("search", () => {
    it.effect("finds symlinked files through the composer path search", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir("t3code-workspace-symlink-search-");
        yield* writeTextFile(cwd, "AGENTS.md", "# agents\n");
        yield* symlink(cwd, "AGENTS.md", "CLAUDE.md");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        // Warms the index for this workspace the same way opening a thread does.
        yield* listEntries(cwd);
        const result = yield* workspaceEntries.search({ cwd, query: "claude", limit: 10 });

        expect(result.entries.map((entry) => entry.path)).toContain("CLAUDE.md");
      }),
    );

    it.effect("keeps index ranking when a link is only a weak match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir("t3code-workspace-symlink-ranking-");
        yield* writeTextFile(cwd, "src/guide.md", "# guide\n");
        yield* writeTextFile(cwd, "AGENTS.md", "# agents\n");
        yield* symlink(cwd, "AGENTS.md", "src/LINKED.md");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        yield* listEntries(cwd);
        const result = yield* workspaceEntries.search({ cwd, query: "guide", limit: 10 });

        // The link matches only through its directory, so it must not displace
        // the file the native index ranked first.
        expect(result.entries[0]?.path).toBe("src/guide.md");
      }),
    );
  });
});
