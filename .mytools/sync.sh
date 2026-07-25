#!/usr/bin/env bash
#
# Pull updates from upstream (pingdotgg/t3code) and rebase the `my` branch on top.
#
#   .mytools/sync.sh          — full sync
#   .mytools/sync.sh status   — show state only, change nothing
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

WORK_BRANCH="my"
BASE_BRANCH="main"

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓ %s%s\n' "$c_ok" "$*" "$c_off"; }
warn() { printf '%s! %s%s\n' "$c_warn" "$*" "$c_off"; }
die()  { printf '%s✗ %s%s\n' "$c_err" "$*" "$c_off" >&2; exit 1; }

git fetch upstream --tags --quiet
git fetch origin --quiet

behind=$(git rev-list --count "$BASE_BRANCH..upstream/main")
mine=$(git rev-list --count "upstream/main..$WORK_BRANCH")

say ""
say "  behind upstream/main : ${behind} commit(s)"
say "  your own commits     : ${mine}"
say ""

if [ "${1:-}" = "status" ]; then
  if [ "$behind" -gt 0 ]; then
    say "${c_dim}New upstream commits:${c_off}"
    git log --oneline --no-decorate "$BASE_BRANCH..upstream/main" | head -20
    [ "$behind" -gt 20 ] && say "${c_dim}  ... and $((behind - 20)) more${c_off}"
  fi
  exit 0
fi

# --- Safety checks --------------------------------------------------------
gitdir=$(git rev-parse --git-dir)
if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; then
  die "A rebase is already in progress. Run 'git rebase --continue' or 'git rebase --abort' first."
fi
if [ -f "$gitdir/MERGE_HEAD" ]; then
  die "A merge is already in progress. Run 'git merge --abort' first."
fi

if [ -n "$(git status --porcelain)" ]; then
  die "You have uncommitted changes. Commit or stash them first."
fi

if [ "$behind" -eq 0 ]; then
  ok "Already in sync with upstream. Nothing to do."
  exit 0
fi

start_branch=$(git rev-parse --abbrev-ref HEAD)
backup="backup/${WORK_BRANCH}-$(git rev-parse --short "$WORK_BRANCH")"
git branch -f "$backup" "$WORK_BRANCH"
ok "Backup created: $backup  ${c_dim}(to undo: git reset --hard $backup)${c_off}"

# --- Step 1: fast-forward main to upstream --------------------------------
git checkout --quiet "$BASE_BRANCH"
git merge --ff-only upstream/main --quiet || die "main could not fast-forward — you have probably committed to main."
git push --quiet origin "$BASE_BRANCH"
ok "main updated (+${behind} commits) and pushed to origin"

# --- Step 2: rebase my onto main ------------------------------------------
git checkout --quiet "$WORK_BRANCH"

if [ "$mine" -eq 0 ]; then
  git merge --ff-only "$BASE_BRANCH" --quiet
  git push --quiet --force-with-lease origin "$WORK_BRANCH"
  ok "my updated (you have no personal commits yet)"
  exit 0
fi

if git rebase "$BASE_BRANCH"; then
  ok "Rebase completed with no conflicts"
else
  # Resolve lockfile conflicts automatically: take upstream's version, then
  # `pnpm install` re-applies any dependency changes of your own.
  while true; do
    conflicts=$(git diff --name-only --diff-filter=U)
    [ -z "$conflicts" ] && break

    if [ "$conflicts" = "pnpm-lock.yaml" ]; then
      git checkout --ours pnpm-lock.yaml
      git add pnpm-lock.yaml
      warn "pnpm-lock.yaml conflict resolved automatically (took upstream's version)"
      GIT_EDITOR=true git rebase --continue || continue
    else
      say ""
      warn "Conflicts that need manual resolution:"
      printf '%s\n' "$conflicts" | sed 's/^/    /'
      say ""
      say "  After resolving : git add <file> && git rebase --continue"
      say "  To back out     : git rebase --abort"
      say "  To reset fully  : git rebase --abort && git reset --hard $backup"
      say ""
      exit 1
    fi
  done
  ok "Rebase completed (lockfile resolved automatically)"
fi

git push --force-with-lease origin "$WORK_BRANCH"
ok "my branch pushed to origin"

# --- Step 3: dependency check ---------------------------------------------
say ""
if git diff --quiet "$backup" -- pnpm-lock.yaml package.json 2>/dev/null; then
  say "${c_dim}Dependencies unchanged — no need to run pnpm install.${c_off}"
else
  warn "Dependencies changed — run 'pnpm install'."
fi

[ "$start_branch" != "$WORK_BRANCH" ] && git checkout --quiet "$start_branch"
say ""
ok "Sync complete."
