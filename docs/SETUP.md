# One-time setup

About 15 minutes. Steps 1–6 make the factory safe to run unattended; step 7 starts it once the scaffold has merged.

## 1. Pull requests: Settings → General

- Pull Requests: allow **squash merging** only (untick "Allow merge commits" and "Allow rebase merging"). Default commit message: "Pull request title and description".
- Tick **Allow auto-merge**. The factory merges its own PRs this way.
- Tick **Automatically delete head branches**.
- Features: untick **Wikis**; the docs live in `docs/`.

## 2. Pages: Settings → Pages

- Build and deployment → Source: **GitHub Actions**.
- The site is public at https://resner.github.io/Biosphere/ even though the repository is private.
- Leave the `github-pages` environment as it is: its default rule (deploy from `main`) is what the release workflow needs.

## 3. Protect `main`: Settings → Rules → Rulesets → New ruleset → New branch ruleset

The `verify` check can be selected once CI has run on a pull request; the setup PR already did that.

- Name `main`, Enforcement status **Active**, Target branches: **Include default branch**.
- Bypass list: **leave it empty**. Factory runs act as your GitHub account, so an admin bypass would let them skip CI.
- Tick **Restrict deletions**, **Require linear history** and **Block force pushes**.
- Tick **Require a pull request before merging**: required approvals **0**, leave "Require conversation resolution before merging" unticked, Allowed merge methods: **Squash** only.
- Tick **Require status checks to pass**: add `verify` (GitHub Actions). Leave "Require branches to be up to date before merging" **unticked**; it would cost extra CI runs.

## 4. Actions: Settings → Actions → General

- Actions permissions: **Allow Resner, and select non-Resner, actions and reusable workflows**, then tick only **Allow actions created by GitHub** (the workflows use only `actions/*`).
- Workflow permissions: **Read repository contents and packages permissions** (jobs ask for more themselves). Leave "Allow GitHub Actions to create and approve pull requests" unticked.
- Artifact and log retention: **7 days**.

## 5. Security: Settings → Advanced Security (or Code security)

- Enable **Dependabot alerts** and **Dependabot security updates**.

## 6. Spending cap: your avatar → Settings → Billing and licensing → Budgets and alerts

- New budget → Product **Actions** → amount **$0** → alerts on. Personal budgets stop usage at the limit, so CI pauses at the 3,000 included minutes instead of billing you.
- Track usage under Billing and licensing → Usage (filter on Actions).

## 7. The factory schedule

The scheduled task "Factory" runs `/next` in a fresh cloud session: claude.ai/code → Scheduled tasks → Factory.

- Keep it **paused until the scaffold PR has merged**; the scaffold tells you when to resume it. Agents can't toggle a task created in the web UI, so pausing and resuming is up to you.
- Schedule: every 2 hours (edit the task → Custom → `25 */2 * * *`; hourly is the minimum). Hourly can exceed the 3,000 Actions minutes in a busy month.
- Prompt: `Run /next. Open a pull request for the result, enable auto-merge, and see it through until it is merged.`
- Model: the default or Sonnet 5.5. `/next` switches to Sonnet itself, and to Opus for specs and milestone reviews.
- Connectors: none needed. GitHub access comes from your GitHub connection and the Claude GitHub App, so you can remove the defaults (Claude-Docs, visualize).
- Notifications: keep push on. Every run ends with `SHIPPED`, `BLOCKED`, `WAITING` or `IDLE`. GitHub won't notify you about the factory's issues, because they're posted as you.

Every run counts against your Claude plan's usage.

## What only you provide

- **Playtests.** Each release opens a `Playtest: v…` issue with the Pages link and what to check. Milestones marked `gate` in the roadmap wait for your reply; reply with what you found, or just "go".
- **Decisions.** `Blocked: …` issues ask questions the factory couldn't settle. Reply in the issue.
- **Accounts and credentials** (hosting such as Cloudflare, a TURN service, a domain). The factory opens a `Blocked:` issue with the exact steps and the secret name; you add the value under Settings → Secrets and variables → Actions. It never sees the value.
