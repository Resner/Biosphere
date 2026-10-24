#!/usr/bin/env bash
# SessionStart hook.
# 1. Commits belong to the repository owner: replace the cloud container's default
#    "Claude <noreply@anthropic.com>" identity with the owner's (repo-local git config).
# 2. Cloud sessions start from a fresh clone: install npm dependencies once the toolchain exists.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

case "$(git config user.email)" in
  "" | noreply@anthropic.com)
    git config user.name "Brian Resner"
    git config user.email "32853884+Resner@users.noreply.github.com"
    ;;
esac

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
[ -f package-lock.json ] || exit 0
# npm rewrites node_modules/.package-lock.json on every install; newer than the lockfile = up to date.
[ node_modules/.package-lock.json -nt package-lock.json ] && exit 0
if ! out=$(npm ci --no-audit --no-fund 2>&1); then
  echo "SessionStart: npm ci failed, so tests won't run until dependencies install:"
  printf '%s\n' "$out" | tail -n 20
fi
exit 0
