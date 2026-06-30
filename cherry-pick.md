# Reimplementation Workflow (a.k.a. "Cherry-Pick")

> **This file is named `cherry-pick.md` for historical reasons.** Despite the name, the actual workflow is **reimplementation** — not `git cherry-pick`. Read the next section to understand why.

## Context

This repository is a secure drop-in replacement for **`allure-framework/allure-action`** (the upstream named in `src/main.ts` inside `validateSubscription`, and the repo configured in `.github/workflows/auto_cherry_pick.yml` as `original-owner: allure-framework`, `repo-name: allure-action`).

**Upstream has no LICENSE file.** `gh api repos/allure-framework/allure-action` returns `"license": null`. Without a permission grant, we are **not allowed to copy upstream's source code, tests, fixtures, comments, or commit messages** into this repo. That rules out `git cherry-pick` as a literal operation, because cherry-pick copies code verbatim.

So our workflow is: **read upstream as a specification of intended behavior, then implement the same behavior ourselves from scratch.** The initial port on 2026-01-28/29 was done this way — upstream's `src/index.ts`/`github.ts`/`table.ts`/`utils.ts` was reimplemented as our consolidated `src/main.ts` + `src/helpers.ts`, with all identifiers renamed (`run` → `executeAction`, `getInput` → `retrieveActionInput`, `getOctokit` → `initializeGitHubClient`, `stripColors` → `removeColorCodes`, etc.). Continue that pattern for every subsequent update.

## What "reimplement" means

- **Never copy code verbatim.** Not source files, not test fixtures, not snapshots, not error strings, not comments. Not even commit messages or PR descriptions.
- **Read for behavior, write from scratch.** Open the upstream diff, understand *what changed and why*, close the upstream tab, then implement the same behavior in our codebase using our naming, layout, and style.
- **Rename identifiers.** Match the verbose, descriptive naming already used in this repo (`createReportMarkdownSummary`, `upsertPullRequestComment`, `fetchWorkflowContext`, etc.) — not upstream's shorter names.
- **Keep our file layout.** Upstream uses many small files (`github.ts`, `table.ts`, `quality-gate.ts`, `sections.ts`, …). We consolidate into `src/main.ts` + `src/helpers.ts`. New behavior goes into `helpers.ts` (or a new helper module with our naming) — do **not** mirror upstream's filenames.
- **Re-derive tests.** Write our own tests under `test/spec/` covering the same behavior. Don't port upstream's test names, fixtures, or snapshots.
- **Author/branding stays ours.** `action.yml` `author: "step-security"`, `package.json` `repository` field (`step-security/...`), README banner — never overwrite from upstream.

## How to discover what needs reimplementing

1. The `.github/workflows/auto_cherry_pick.yml` workflow (in `verify` mode) posts a **Verification Report** comment on PRs labeled `review-required`. That report lists upstream commits that are not yet reflected in our repo. Treat it as a **change inventory** — a list of upstream commits to study, *not* to apply.
2. Cross-check against upstream release tags:
   ```
   gh api repos/allure-framework/allure-action/git/refs/tags
   ```
   Compare the last baseline tag we matched (recorded in the most recent reimplementation PR description) against upstream `HEAD`.
3. For each upstream commit in scope, open `https://github.com/allure-framework/allure-action/commit/<sha>` to read the diff and understand the behavior change. Don't keep that tab open while typing.

## Reimplementation procedure (per upstream change)

1. **Identify** the upstream commit/PR (sha + PR number from the verification report or `gh api repos/allure-framework/allure-action/commits`).
2. **Read** the upstream diff to understand *behavior* — what input/output changed, what edge case is fixed, what new feature is added.
3. **Describe it in your own words** (in your notes or the PR description) — e.g. "quality-gate JSON now uses a `rules[]` array instead of a flat list."
4. **Locate** the equivalent code in our repo (`src/main.ts`, `src/helpers.ts`, `action.yml`, `package.json`, `allurerc.mjs`).
5. **Write the change from scratch** using our naming and style. Do not have the upstream code open while typing.
6. **Add or update tests** under `test/spec/` to lock in the new behavior. Use our existing test patterns (Vitest, `test/mocks.ts`).
7. **For dependency bumps**: match upstream's intent (i.e., bump the same package) but pick the current safe version — don't blindly pin to upstream's exact version if a newer patch is available.

## Always reimplement

- **Behavioral changes**: new features, bug fixes, behavior tweaks.
- **Dependency upgrades** in `package.json` (apply manually; our `npm-audit-fix` flow handles security bumps but not feature-driven version bumps).
- **Module-system / build changes** if upstream restructures (e.g. ESM conversion, tsconfig changes) — only when our build genuinely needs the same change.
- **Action surface changes** (`action.yml` inputs/outputs) where the user-visible contract changed. Evaluate backward-compat carefully (see Use judgment).

## Never reimplement

- **Author / maintainer / branding** — `action.yml` `author`, `package.json` `repository`, README banner stay ours.
- **Markdown docs** — `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `CHANGELOG.md`, and similar meta-docs are ours; do not import upstream's wording.
- **Our release / CI files** — `.github/workflows/actions_release.yml`, `audit_package.yml`, `auto_cherry_pick.yml`, `claude_review.yml`, `codeql.yml`, `dependency-review.yml`, `scorecards.yml`, `ci.yml` are ours. Workflow files are not handled by the verification report and must not be replaced from upstream.
- **`validateSubscription` and the StepSecurity subscription-check logic** in `src/main.ts` — that's our addition; never overwrite.
- **Files upstream has but we deliberately don't** — `tsdown.config.ts`, `lefthook.yml`, `.oxlintrc.json`, `.oxfmtrc.json`, `plugin-ci-version.cjs`, etc. Don't reintroduce unless we have a specific reason.

## Use judgment

- Some upstream files don't exist in our repo by design. Don't recreate them just because upstream changed them.
- If upstream splits a module into smaller files, we keep our consolidated structure; just port the behavior into `helpers.ts`.
- If upstream renames an `action.yml` input, evaluate whether to follow the rename or keep our existing name for backward compatibility with users who already pin to us.

## After reimplementing

- Run `npm install && npm run build` — the `dist/` artifact must be rebuilt (ncc bundles `src/main.ts` to `dist/index.js`).
- Run `npm test` (Vitest with allure).
- Commit `dist/` changes alongside source changes — consumers use `dist/index.js` at runtime.
- Record the upstream baseline tag we now match (e.g. "matches upstream v0.7.0") in the PR description so the next reimplementation knows where to start.

## Pending reimplementation backlog (snapshot as of 2026-06-30)

Our current baseline: upstream **v0.7.0** (released 2026-05-15).
Upstream `HEAD`: **v0.8.0** (released 2026-06-30).

Items to reimplement (newest last), from `gh api repos/allure-framework/allure-action/commits`:

| Upstream commit / PR | Type | What to reimplement |
|---|---|---|
| Escape markdown symbols (#53) — v0.7.1 | fix | Add `\|` escaping for summary names in markdown table cells. In our `generateSummaryMarkdownTable` equivalent in `src/helpers.ts`, escape `|` characters in the report name before rendering to prevent broken table rows. |
| fix: use path.posix for consistent path handling (#54) — v0.7.2 | fix | Replace `path.join` with `path.posix.join` in `src/main.ts` for all path operations (report dir, quality-gate file, summary file glob). Fixes path separator issues on Windows runners. |
| Bump shell-quote 1.8.3 → 1.8.4 (#56) | deps | Bump `shell-quote` in `package.json` if present in our dep tree. |
| Bump @actions/core 3.0.0 → 3.0.1, @actions/github 9.0.0 → 9.1.1, @actions/glob 0.6.1 → 0.7.0 (#61) | deps | Bump these three packages in `package.json` `dependencies`. |
| Bump @allurereport/core-api, plugin-api, plugin-awesome, allure, allure-vitest (#58) | deps | Bump all `@allurereport/*` packages to `^3.13.1` and `allure-vitest` to `^3.10.1` in `package.json`. |
| Bump vitest, @vitest/runner, @vitest/snapshot and related (#62) | deps | Bump `vitest`, `@vitest/runner`, `@vitest/snapshot` to `^4.1.9` in `package.json`. |
| Fix vulnerabilities (#69) | security | Add `resolutions` overrides in `package.json` for: `ip-address: 10.1.1`, `brace-expansion: 5.0.6`, `dompurify: 3.4.11`, `form-data: 4.0.6`, `tar: 7.5.16`, `undici: 6.27.0`, `vite: 8.0.16`. |
| Fix ANSI escape regex in quality-gate (#53 side-effect) | fix | In our `removeColorCodes` in `src/helpers.ts`, fix the ANSI escape regex — upstream fixed `\^[\[\d+m` (broken) to a properly constructed pattern: `new RegExp(\`${String.fromCharCode(27)}\\[\\d+m\`, "g")`. |
| Render external checks (#63) — v0.8.0 (large) | feature | Major feature with several sub-parts — implement all in `src/main.ts`: **(1)** Add `debug` input to `action.yml` (`description: "Print additional diagnostic information"`, `default: "false"`). Also update `github-token` description to "GitHub token for creating checks and comments". **(2)** Remove the early-return guard that aborted on non-PR events — the run should now continue for quality-gate checks and external checks on any event; only PR comment posting stays gated on `isPullRequest`. **(3)** Read `sha` from `getGithubContext()` as a fallback `headSha` when there is no pull request (`headSha = pullRequest?.head.sha ?? sha`). **(4)** Add `isDebugEnabled(debugInput: string): boolean` (truthy values: `"1"`, `"true"`, `"yes"`, `"on"`, case-insensitive). **(5)** Add `printDebugInfo(...)` that logs action diagnostics via `core.info("[debug] ...")` when debug is on. **(6)** Collect all `checks[]` arrays from parsed `summary.json` files — deduplicate by `check.id` into a map of `{ name, conclusion, sources[] }` (conclusion is `"failure"` if any source failed, else `"success"`). **(7)** For each collected check, call `octokit.rest.checks.create` with `name: \`Allure external check: ${checkRun.name}\``, `head_sha: headSha`, `status: "completed"`, and mapped conclusion. Await these in parallel via `Promise.all`. Log each creation when debug is on. |

Follow-up PR title suggestion: **"Reimplement upstream changes v0.7.0 → v0.8.0"**.

## Known inconsistency to fix separately

The GitHub repo "About" line currently says *"Secure drop-in replacement for simple-elf/allure-report-action"*, but our actual upstream is `allure-framework/allure-action` (`src/main.ts` says so, and that's the action this repo's API surface mirrors — `summary.json`, `quality-gate.json`, Allure Report 3). `simple-elf/allure-report-action` is a different, older Docker-based Allure 2 action. The About line should be updated to point at `allure-framework/allure-action`. Not part of any reimplementation PR — fix in repo settings directly.
