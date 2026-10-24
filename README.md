# Biosphere

A browser game built by an unattended Claude Code "factory" and released milestone by milestone to GitHub Pages:
https://resner.github.io/Biosphere/ (live after the first release).

## How it runs

| Step | Who | Model | What happens |
|------|-----|-------|--------------|
| Setup | you, once | — | Apply the GitHub settings in [docs/SETUP.md](docs/SETUP.md). |
| Scaffold | you + Claude, once | Opus 5.5 with `/effort xhigh` (or `max`) | `/scaffold <brief>`: the brief becomes a roadmap timeline to v1.0, architecture ADRs and a toolchain, and v0.1.0 goes live. |
| Factory | a scheduled task, unattended | Sonnet 5.5; spec and milestone steps switch to Opus 5.5 | Each run does `/next`: one step, one PR, auto-merged once CI is green. |
| Release | automatic | — | A merged `VERSION` bump runs the full tests, deploys to Pages, and tags the release with notes. |

`/next` reads `docs/ROADMAP.md` to decide the step: write the next milestone's spec, implement the next task, or close the milestone. Before a task merges, its tests are written first, then it passes `npm run check`, `/simplify`, `/code-review` and CI.

## Steering

- Play the build and **open an issue** for any bug or idea. Bugs get fixed in the next run; ideas get folded into the next spec.
- **`Blocked: …` issues** need your answer. Reply in the issue, and the next run picks it up.
- **`Playtest: …` issues** come with each release. Try the build and reply with what you found; milestones marked `gate` wait for that reply.
- To change direction, edit `docs/BRIEF.md` or `docs/ROADMAP.md` (through a PR), or describe the change in an issue.
- Pause or resume the factory by disabling or enabling its scheduled task.

## Keeping an eye on it

- Progress: `docs/ROADMAP.md` (milestone status and windows) and the repository's Releases page.
- Decisions: `docs/decisions/`.
- GitHub Actions minutes: Settings → Billing and licensing → Usage. A CI run costs about 4–6 minutes; slow the schedule if a month passes about 2,000.
- Claude usage: https://claude.ai/settings/usage

## Working by hand

Start a Claude Code session and run `/next` to advance one step yourself. For a quick fix, just describe it. Keep each change to one PR, and `/clear` between unrelated tasks.
