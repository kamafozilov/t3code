# Fork maintenance guide

This directory is **yours only** — upstream (`pingdotgg/t3code`) has no such
directory, so it can never cause a merge conflict.

---

## Branch strategy

```
upstream/main  ──────●───●───●───●───●      ← Theo's repo
                                    │
main           ──────●───●───●───●───●      ← clean mirror, NEVER commit here
                                     ╲
my             ──────────────────────●──●   ← your work, rebased onto main
```

| Branch | Purpose | Rule |
|---|---|---|
| `main` | Exact mirror of upstream | **Never commit here.** Only the sync script touches it. |
| `my` | All of your changes | Always work here. Rebased onto `main` on every sync. |
| `backup/my-<hash>` | Automatic backup before each sync | Your escape hatch. Delete old ones periodically. |

---

## Daily workflow

```bash
git checkout my
# ... write code ...
git add -A && git commit -m "feat(web): ..."
git push
```

## Pulling upstream updates

```bash
.mytools/sync.sh status    # how many commits are we behind?
.mytools/sync.sh           # sync
```

The script will:

1. Fetch from `upstream`
2. Back up `my` as `backup/my-<hash>`
3. Fast-forward `main` to upstream and push it to `origin`
4. Rebase `my` onto `main`
5. Resolve `pnpm-lock.yaml` conflicts **automatically** (takes upstream's version)
6. Stop and tell you if any other conflict appears

Sync often. Upstream lands roughly 20 commits a day — at **once or twice a week**
you will almost never hit a conflict. Wait a month and it becomes painful.

---

## Rules for avoiding conflicts

The long-term survival of this fork depends on these five rules:

1. **Prefer adding a new file over editing an existing one.** A new file can
   never conflict. Creating `packages/shared/src/foo.ts` beats changing 50 lines
   of `packages/shared/src/index.ts`.

2. **When you must touch an existing file, keep the diff minimal.** One import,
   one function call. Do not rewrite whole blocks.

3. **Do not reformat.** Never run `pnpm fmt` across the whole repo — only on the
   files you actually changed. Otherwise you create a diff thousands of lines
   long and every future sync turns into hell.

4. **Do not rename packages (`@t3tools/*`) or the CLI (`t3`).** That is a global
   rename and would produce hundreds of conflicts on every sync.

5. **Keep your commits small and atomic.** When a conflict shows up during
   rebase, a small commit is easy to resolve; an 800-line commit is misery.

---

## When things go wrong

```bash
# Rebase stopped halfway and I'm lost
git rebase --abort

# Everything is broken, go back to the backup
git branch -a | grep backup/          # list backups
git checkout my
git reset --hard backup/my-<hash>

# I accidentally committed to main
git checkout main
git reset --hard upstream/main

# Clean up old backups
git branch -d backup/my-abc1234
```

`git rerere` is enabled — once you resolve a conflict, git remembers it and
resolves the same conflict automatically next time.

---

## Configuration (already applied)

```
rerere.enabled       true      ← remember resolved conflicts
rerere.autoupdate    true
pull.rebase          true      ← keep history free of merge commits
rebase.autoStash     true
merge.conflictStyle  zdiff3    ← show the common ancestor in conflicts
remote.pushDefault   origin    ← pushes always go to your fork
branch.main.remote   upstream  ← main fetches from upstream
```

The push URL for `upstream` is set to **DISABLED**, so you cannot accidentally
push to Theo's repository.

---

## License

Upstream is MIT licensed. You are free to fork, modify and distribute. The only
requirement is to keep the `LICENSE` file and its copyright line intact.
