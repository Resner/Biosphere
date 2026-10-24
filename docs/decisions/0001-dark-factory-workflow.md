# 0001: Dark-factory workflow, branching and releases

- Status: accepted
- Date: 2026-10-24

## Context

One owner who doesn't review PRs. Development runs for weeks in Claude Code cloud sessions, and each run starts in a fresh container, so anything that lives only on a machine is lost. The repository is private, with 3,000 GitHub Actions minutes a month. Pages should deploy only finished, fully tested milestones, and every commit is authored by the owner.

## Decision

- **One loop, skills for phases.** Each run is a single agent loop. `/next` routes to the `spec` skill, a task, or the `milestone` skill. There are no custom subagents; only disposable review passes (`/simplify`, `/code-review`) use them.
- **Model by phase.** Specs: Opus 5.5 at xhigh. Tasks: Sonnet 5.5 at high. Milestone review: Opus 5.5 at high. Scaffold: Opus 5.5 at xhigh, or max if the owner chooses.
- **Memory in the repo.** BRIEF (intent) → ROADMAP (ordered milestones to v1.0, no time estimates) → one spec per milestone, written just in time → ADRs → CLAUDE.md and path-scoped rules.
- **Trunk-based.** `main` plus one short-lived branch per step, squash-merged. One factory PR is open at a time, and it auto-merges when the single required check, `verify`, passes.
- **Releases from `VERSION`.** A merged `VERSION` change runs the full test suite, deploys Pages from `main`, and tags `v<VERSION>`. Each milestone bumps the minor version; v1.0.0 means finished.
- **CI on a budget.** One job (GitHub rounds every job up to a whole minute). Drafts skip it, docs-only changes skip the build, slow E2E runs only at release, jobs have timeouts, and an Actions budget of $0 caps the spend.
- **Owner-only authorship.** The session hook sets the owner's git identity, and Claude Code's commit and PR attribution is turned off.

## Consequences

- The factory runs on a schedule with no human in the loop. Quality depends on tests written before the code, the review passes, and CI.
- The factory makes product decisions and records them as ADRs. The owner steers through issues and `Blocked:` replies.
- Rejected:
  - specialist subagents per domain (lossy handoffs, extra cost);
  - writing every spec up front (they go stale);
  - a human release gate (it contradicts the dark factory);
  - running the agent inside GitHub Actions (it would spend the minutes budget).

## Evidence

- Anthropic: [Building agents: When to fold subagents into your main agent loop](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop), [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [The new rules of context engineering for Claude 5 generation models](https://claude.dev/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models/), [Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5)
- Claude Code docs: [best practices](https://code.claude.com/docs/en/best-practices), [costs](https://code.claude.com/docs/en/costs), [model configuration](https://code.claude.com/docs/en/model-config), [memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [scheduled tasks](https://code.claude.com/docs/en/routines), [settings: attribution](https://code.claude.com/docs/en/settings-reference#attribution)
- DORA: [trunk-based development](https://dora.dev/capabilities/trunk-based-development/), [working in small batches](https://dora.dev/capabilities/working-in-small-batches/)
- GitHub docs: [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), [skipped but required checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks), [auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request), [budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets)
