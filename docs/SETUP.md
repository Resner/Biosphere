# One-time setup

About 15 minutes. Steps 1–6 make the factory safe to run unattended; step 7 starts it once the scaffold has merged; step 8 (Cloudflare) is needed before the first playtest.

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

- New budget → Product **Actions** → amount **$0** → alerts on. The repository is public, so standard runners cost nothing; the $0 budget guards against anything that would bill.
- Track usage under Billing and licensing → Usage (filter on Actions).

## 7. The factory schedule

The scheduled task "Factory" runs `/next` in a fresh cloud session: claude.ai/code → Scheduled tasks → Factory.

- Keep it **paused until the scaffold PR has merged**; the scaffold tells you when to resume it. Agents can't toggle a task created in the web UI, so pausing and resuming is up to you.
- Schedule: hourly (edit the task → Custom → `54 * * * *`; hourly is the minimum).
  - Runs also chain: when a run's PR merges, it fires the task again, so the factory works back to back until your Claude usage limit (ADR 0015).
  - The hourly schedule restarts the chain after usage limits, playtest gates and failures.
  - Pausing the task stops the chain after the current run.
- Prompt: `Run /next. Open a pull request for the result, enable auto-merge, and see it through until it is merged.`
- Model: the default or Sonnet 5.5. `/next` switches to Sonnet itself, and to Opus for specs and milestone reviews.
- Connectors: none needed. GitHub access comes from your GitHub connection and the Claude GitHub App, so you can remove the defaults (Claude-Docs, visualize).
- Notifications: every run ends with `SHIPPED`, `BLOCKED`, `WAITING` or `IDLE`. With chained runs that's a push every few minutes, so turn push off if it's too much; `BLOCKED` and `WAITING` also show up as GitHub issues. GitHub won't notify you about the factory's issues, because they're posted as you.

Every run counts against your Claude plan's usage.

## 8. Cloudflare: needed before the first playtest (M2)

The game's minimal authority (signaling, short-lived TURN relay credentials, and later the lineage ledger) runs as a Cloudflare Worker on the free plan (ADR 0008). Do this any time before M2 ships; if the factory reaches the deploy step first, it opens a `Blocked:` issue pointing here.

1. Create a free account at https://dash.cloudflare.com/sign-up. No domain is needed.
2. Open **Workers & Pages** once, so the account gets a `workers.dev` subdomain. Note the subdomain and your **Account ID** (shown on the account overview).
3. **My Profile → API Tokens → Create Token** → template **Edit Cloudflare Workers** → Account Resources: your account → Create. Copy the token.
4. **Realtime** (formerly Calls) **→ TURN Server → Create**, named `biosphere`. Copy the **TURN Key ID** and its **API token**.
5. GitHub → Settings → Secrets and variables → Actions:
   - **Secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN`.
   - **Variables**: `AUTHORITY_URL` = `https://biosphere-authority.<your-subdomain>.workers.dev`.

The free plan stops at its daily limits instead of billing you, and the game queues new players before it gets there. Switching to the $5 Workers Paid plan is optional and only raises capacity (`docs/CAPACITY.md`, from M13).

## What only you provide

- **Playtests.** Each release opens a `Playtest: v…` issue with the Pages link and what to check. Milestones marked `gate` in the roadmap wait for your reply; reply with what you found, or just "go".
- **Decisions.** `Blocked: …` issues ask questions the factory couldn't settle. Reply in the issue.
- **Accounts and credentials** (hosting such as Cloudflare, a TURN service, a domain). The factory opens a `Blocked:` issue with the exact steps and the secret name; you add the value under Settings → Secrets and variables → Actions. It never sees the value.
