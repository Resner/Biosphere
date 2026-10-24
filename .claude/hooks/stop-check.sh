#!/usr/bin/env bash
# Stop hook: if code on this branch changed and this exact state hasn't passed yet, run
# `npm run check`. A failure exits 2, which sends the output tail back to Claude once;
# stop_hook_active lets the following stop through, so a turn can't loop here.
input=$(cat)
printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -f package.json ] && [ -d node_modules ] || exit 0

# Snapshot the working tree (tracked + untracked, minus ignored files) as a tree object,
# using a scratch index so the real index is untouched.
idx=$(git rev-parse --git-path claude-check-index) || exit 0
cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || rm -f "$idx"
tree=$(GIT_INDEX_FILE="$idx" git add -A 2>/dev/null && GIT_INDEX_FILE="$idx" git write-tree) || exit 0

# Only code counts: skip when nothing outside docs/, .claude/ and *.md differs from main.
base=$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD)
git diff --name-only "$base" "$tree" | grep -qvE '^(docs/|\.claude/)|\.md$' || exit 0

stamp=$(git rev-parse --git-path claude-check-stamp)
[ "$(cat "$stamp" 2>/dev/null)" = "$tree" ] && exit 0

if out=$(npm run check --if-present 2>&1); then
  printf '%s\n' "$tree" > "$stamp"
  exit 0
fi
{
  echo "npm run check failed; fix it before finishing. Last 40 lines:"
  printf '%s\n' "$out" | tail -n 40
} >&2
exit 2
