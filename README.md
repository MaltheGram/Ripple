# Ripple

**Review GitLab merge requests inside VS Code**, with the tools the GitLab web UI doesn't have:

- real **CMD+click / go to definition / find references** in every diff
- a review list with **filters, progress and a suggested reading order**
- **noise detection**: lockfiles, renames, whitespace-only, import-only, moved code and big rename refactors are recognised and hidden
- **trace any changed function**: who calls it (up to controllers, React components, jobs and tests) and what it calls, across frontend → HTTP → backend
- **cross-service impact**: which other repositories use the DTOs, routes and events the MR changes
- full **GitLab commenting**: inline and multi-line comments, drafts, replies, resolve, submit review, approve
- **optional AI** (Claude, through each developer's own subscription): MR summary, review units, risk hotspots, "explain this code against the MR", suggested review comments

Everything runs locally. Your own clones are never touched; there is no server, no database and no telemetry.

Works with gitlab.com and self-managed GitLab, in VS Code and VS Code-based editors (Insiders, VSCodium, Cursor). Ripple is an independent open-source project, not affiliated with or endorsed by GitLab or Anthropic.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Signing in](#signing-in)
- [The sidebar](#the-sidebar)
  - [Merge Requests](#merge-requests)
  - [Review](#review)
  - [Explain](#explain)
  - [Comments](#comments)
  - [Impact](#impact)
  - [Cross-service](#cross-service)
- [In the editor](#in-the-editor)
  - [Diffs and code navigation](#diffs-and-code-navigation)
  - [Commenting](#commenting)
  - [MR Overview](#mr-overview)
  - [Trace](#trace)
  - ["Affected by this MR" hover](#affected-by-this-mr-hover)
- [AI features](#ai-features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Commands](#commands)
- [Settings](#settings)
- [How it works](#how-it-works)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Requirements

| What | Why |
|---|---|
| VS Code 1.90 or newer | the extension host |
| `git` 2.31 or newer on PATH | clones, worktrees and diffs |
| A GitLab account (gitlab.com or self-managed) with access to the projects | everything runs as you |
| GitLab **Premium** or higher with Advanced Search | only for the Cross-service view |
| [Claude Code](https://docs.anthropic.com/claude-code) CLI (`claude`), signed in | only for AI features (optional) |

For the best code navigation, install the language extensions you normally use (TypeScript support is built in).

## Install

Download the latest `ripple-<version>.vsix` from the [Releases](../../releases) page, then either drag it onto the Extensions view, use **Extensions → … → Install from VSIX…**, or run:

```bash
code --install-extension ripple-<version>.vsix
```

Ripple checks GitHub Releases once a day and offers to install a newer version (**Ripple: Check for Updates** to check now; `ripple.checkForUpdates` to turn it off).

Or build it yourself; see [Development](#development).

## Quick start

A **Get started** walkthrough opens the first time (and any time via **Ripple: Get Started**).

1. Click the **Ripple** icon (pull request symbol) in the activity bar.
2. **Merge Requests → Sign in to GitLab.** Paste a personal access token, or sign in through the browser if you set up an OAuth app; see [Signing in](#signing-in). On self-managed GitLab, first set `ripple.gitlab.baseUrl`.
3. Pick a merge request in the **Merge Requests** list. The first time for a project, Ripple downloads it (this takes a moment for big repositories); later MRs only fetch what changed.
4. The **Review** list fills with the MR's files. Click a file to open its diff. The right side is the real file, so CMD+click works.
5. Tick files as **viewed**, leave comments with the `+` in the gutter, and finish with **Submit Review** (✈) in the Review toolbar.

## Signing in

Ripple acts as **you** on GitLab: comments, drafts and approvals are made with your account. There are two ways to sign in.

### Personal access token (simplest)

Without any setup, **Sign in to GitLab** opens GitLab's token page with the right scope filled in. Create a token with the `api` scope and paste it into the prompt at the top of the window. The token is stored in your OS keychain through VS Code's secret storage.

### OAuth app (browser sign-in)

Nicer for teams: no tokens to create or rotate. Ripple can't ship a shared OAuth app, because an OAuth app belongs to a GitLab instance or group, so you (or your GitLab admin) register one once and everyone uses its Application ID.

1. GitLab → **your group → Settings → Applications → Add new application** (or **User settings → Applications** for a personal one, or **Admin → Applications** for a whole self-managed instance).
2. Name: `Ripple`.
3. Redirect URIs, one per line, for the editors you use:
   ```
   vscode://malthegram.ripple/auth-callback
   vscode-insiders://malthegram.ripple/auth-callback
   ```
   Add `vscodium://malthegram.ripple/auth-callback` or `cursor://malthegram.ripple/auth-callback` for those editors.
4. **Untick Confidential** (GitLab ticks it by default). Ripple is a public client using PKCE, so there is no client secret anywhere.
5. Scopes: `api`, `read_user`.
6. Everyone sets the Application ID once in their **user** settings:
   ```json
   "ripple.gitlab.clientId": "<application id>"
   ```
   The ID is not a secret, but Ripple only reads it from user settings, so a repository can't swap in its own app.

**Why that redirect URI?** After you approve in the browser, GitLab sends you back to `<editor>://<extension id>/auth-callback`. The editor opens links on its own scheme (`vscode://`, `cursor://` …) and hands them to the extension whose ID is in the path. Ripple's ID is `malthegram.ripple` (publisher `malthegram`, name `ripple`). If you build and publish your own fork under another publisher, use that publisher in the URI instead.

---

## The sidebar

All views live in the Ripple activity bar container. Only **Merge Requests** is visible until you open an MR.

### Merge Requests

Lists open merge requests you can review. Click one to review it in the **current window**; picking another MR switches to it and closes the previous MR's diff tabs.

| Section | Contents |
|---|---|
| **Review requested** | MRs where you are a reviewer |
| **Assigned to me** | MRs assigned to you |
| **Created by me** | your own open MRs |
| **All open in &lt;group&gt;** | every open MR in the group, grouped by project, most recently updated first. The groups are your top-level GitLab groups, or the ones in `ripple.gitlab.groups`. |

Each row shows the author and how long ago the MR was updated; drafts have their own icon, and the MR you're reviewing shows **● reviewing**. Hover a row for branches and comment count; the ↗ button opens it in GitLab.

**Toolbar:** refresh · open an MR by pasting its URL · (… menu) sign out.

### Review

The heart of the extension: the files of the MR, organised so a 200-file MR stays manageable.

**Top rows**

- **Progress:** `███████░░░ 70% · 28/40 substantive · 162 trivial`. Click to open the [MR Overview](#mr-overview).
- **N files changed since your review:** appears when the author pushed after you last submitted a review or approved. Click it to list only those files, with diffs that show **just the changes since the version you reviewed**. **Compare With Version…** (… menu) picks any earlier push instead.
- **Pipeline:** status of the MR's latest pipeline (and whether it ran on the current version), failed jobs underneath (click to open the job log), and the share of **changed lines covered by tests**.
- **Approvals:** approval rules with how many approvals each has and who can approve.
- **AI review:** run it, or (once done) the AI summary with its number of review units and risks. See [AI review](#ai-review).
- **Refactor: `oldName → newName` · N files:** when the same identifier rename explains every changed line in at least 3 files, those files are shown as one item. Skim one or two, then tick the checkbox to mark them all viewed.

**Groups**

Files are grouped by **feature folder**: `dto/`, `entities/`, `__tests__/` and similar folders are folded into their feature. With an AI review, you can group by **AI review units** instead (for example *"1. Pagination contracts · 2. Service logic · 3. Endpoints · 4. Tests"*), in the suggested reading order. Tick a group's checkbox to mark all its files viewed; the 🎯 button focuses on that group only.

**File rows**

- The icon shows the change: added, modified, deleted or renamed.
- The description shows the size (`+12 −3`), why a file is **trivial** (see below), `🧪 3 untested` when changed lines didn't run in the pipeline's tests, `👤` when you are a code owner, and, after an AI review, a risk badge such as `🔴 error handling`.
- **Checkbox = viewed.** Viewed state is tied to the file's content, so a new push to a file makes it unviewed again.
- Click to open the diff.

**Trivial files** are hidden by default (the eye button toggles them):

| Label | Meaning |
|---|---|
| generated / lockfile | matches `ripple.trivialGlobs` (lockfiles, snapshots, `dist/`, `*.generated.*` …) |
| rename only | the file moved without content changes |
| file mode only | only the permission bits changed |
| whitespace only | only indentation or spacing changed |
| imports only | only import/export/require lines changed |
| moved code | every changed line was moved from/to another file in the MR |
| rename refactor | only identifier renames that repeat across ≥3 files |

These rules are deliberately cautious: wrongly hiding a real change is worse than showing some noise.

**Toolbar** (left to right):

| Button | Action |
|---|---|
| ✨ AI review | generate or open the [AI review](#ai-review) |
| → Next unviewed | open the next unviewed file in the current order (`Alt+N`) |
| Filter | change type (e.g. **modified only**), hide trivial, only unviewed / viewed, hide tests / only tests, **only files I own** (CODEOWNERS), path text or glob |
| Sort | **suggested order** (migrations → types/DTOs → repositories → services → controllers → other → tests), path, or size |
| 👁 Trivial | show or hide trivial files |
| ✈ Submit review | publish all your draft comments, optionally approving at the same time |
| ↻ Refresh | fetch new pushes and reload comments |

**… menu:** compare with version · mark this version as reviewed · group files by (folder / AI review units) · mark all trivial files viewed · clear focus · approve · revoke approval · open MR in GitLab · post AI summary to MR · AI options · install dependencies · close review.

### Explain

A list of your **explanations**, newest first. See [Explain selection](#explain-selection) for what an explanation contains.

- Each row shows what was explained (e.g. `OrderController.list`), its file and line, and a verdict icon: **changed** (yellow), **affected by changes elsewhere** (orange), **not affected** (green), **unclear** (grey). Hover a row for the summary.
- **Click a row** to open the full explanation document beside your code.
- **Expand a row** to see its effects (click one to open the diff at the line that causes it), its checks and its follow-up questions.
- **Row buttons:** ask a follow-up · add as a review comment · remove. Single effects and checks can be added as comments too.
- **Toolbar:** explain the selection · explain the whole file · clear the list.

The list holds up to 30 explanations and is cleared when you switch MRs.

### Comments

Every discussion on the MR in one place. The badge counts unresolved threads.

| Section | Contents |
|---|---|
| **General** | comments on the MR as a whole (not tied to a line) |
| **Unresolved** | open line threads, grouped by file |
| **Your drafts** | your not-yet-published comments |
| **Resolved** | closed threads (collapsed) |

Click a thread to jump to its line in the diff, or to the [MR Overview](#mr-overview) for general comments. Labelled comments show their label (`nit`, `question`, `issue (blocking)` …). **`Alt+U`** jumps to the next unresolved thread in review order. **Toolbar:** next unresolved thread · open the MR Overview · refresh.

### Impact

Follows the diff you have open. For each function or method the MR changed in that file, it lists **who calls it**.

- Callers that are **not part of the MR** get a warning icon: they may break without anyone reviewing them.
- Click a function or caller to jump to it.
- The ⧉ button on a function opens its [trace](#trace).

It uses the language server (call hierarchy, falling back to references), so it works for any language VS Code has good support for.

### Cross-service

Finds **other services and repositories** that use what the MR changes. Click **Scan Other Repositories**; results are kept for the current MR version.

**What it looks for in the MR:**

| Kind | Detected from |
|---|---|
| **Types** | exported classes, interfaces, enums and types in folders like `dto/`, `events/`, `types/`, `contracts/`, `shared/`, or with names ending in `Dto`, `Event`, `Payload`, `Request`, `Response`, `Message`, `Command` … |
| **Routes** | NestJS `@Get/@Post/…` combined with the `@Controller('…')` prefix (e.g. `GET /orders/:id/stats`), and Express `router.get(…)` |
| **Events** | names in `@EventPattern`, `@MessagePattern`, `@OnEvent`, `.emit(…)`, `.publish(…)`, `.send(…)` |

Each contract gets an **impact**: new · additive (fields only added) · modified · **possibly breaking** (fields, enum values or routes removed or renamed) · removed. The tooltip shows the details, e.g. *"removed: status; added: budget?"*.

**Where it searches:** your GitLab group's code search (Advanced Search, Premium), covering other repos and this repo's default branch (useful in monorepos). It skips partial name matches and files the MR itself changes; routes must match the full path, including `${id}`-style parameters. At most 15 searches run per scan, spaced out to respect GitLab's rate limit; if GitLab still limits the scan, it says the results are partial.

**In the list:** contract → project → file:line. Click a usage to open it in GitLab at that line; click the contract to open its declaration in the diff. The 💬 button adds a draft review comment on the declaration, listing the affected consumers.

---

## In the editor

### Diffs and code navigation

Clicking a file opens a normal VS Code diff: left = the target branch version, right = **the real file** in the MR's checkout. Because it's a real file, **go to definition, find references, peek, rename preview and call hierarchy all work**, just like in your own clone.

- The first CMD+click after opening an MR can take a few seconds while the language server loads the project.
- For navigation into `node_modules`, the dependencies must be installed in the MR checkout. Ripple offers this once per project (or **Install Dependencies in Review Checkout** in the … menu). It runs your lockfile's package manager in a terminal with lifecycle scripts and pnpm hooks off (`--ignore-scripts`, `--ignore-pnpmfile`), and it **refuses** when the MR changes a package manifest, lockfile or package-manager config (`.npmrc`, `.yarnrc*`, `.pnpmfile.cjs`, `.yarn/`), since those can run code. The install is reused for every MR of that project.

### Commenting

Hover a line in the diff and click the **`+`** in the gutter (select several lines first for a **multi-line comment**). Write markdown, then:

- **Add to Review** saves it as a GitLab **draft**, visible only to you until you submit.
- **Comment Now** posts it immediately.

Existing GitLab threads appear inline on the right lines, including multi-line ones. You can reply (as a draft or directly), **resolve / unresolve**, and delete your drafts. Threads from an earlier MR version are labelled *Earlier version*, or ***Code changed since this comment: maybe addressed?*** when the file changed after the comment. Code suggestions work too: write a ```` ```suggestion ```` block as you would in GitLab.

**Comment labels** ([Conventional Comments](https://conventionalcomments.org)): start a comment with a shorthand and it's posted with a bold label.

| Type | Posted as |
|---|---|
| `n:` / `nit:` | **nit:** |
| `q:` / `question:` | **question:** |
| `s:` / `suggestion:` | **suggestion:** (add `(non-blocking)` if you like) |
| `i:` / `issue:` · `b:` / `blocking:` | **issue:** · **issue (blocking):** |
| `p:` / `praise:` · `t:` / `thought:` · `c:` / `chore:` · `todo:` | **praise:** · **thought:** · **chore:** · **todo:** |

**Submit Review** (✈ in the Review toolbar) publishes all drafts at once and can approve the MR in the same step. **Approve** always sends the MR's current commit, so you never approve a version you haven't seen. Submitting or approving also records **the version you reviewed**, for *changes since your review* next time.

### Coverage and line history

- **Untested changed lines:** when the MR's pipeline has a test job whose artifacts contain an lcov report (by default `coverage/<app>/lcov.info` or `coverage/lcov.info`; see `ripple.coverage.paths`), changed lines that no test ran get a red mark in the diff and an overview-ruler tick. Hover the line for details.
- **Line history:** hover a changed line (or any line on the old side) to see when the code it replaces last changed, by whom, and in which MR, e.g. *"Previously: last changed by Anna, 3 weeks ago, in !512 Add pagination"*. It uses GitLab's blame API, so nothing heavy runs locally.

### MR Overview

A read-only document with the MR title, branches, file statistics, description and, once generated, the AI summary, review order and risk hotspots. It also holds the MR's **general discussion**: general comments appear as threads on the *General discussion* line, and you start a new one with the `+` on that line. Open it by clicking the progress row in Review, or the 💬 button in Comments.

### Trace

Follow what happens around **one changed function**: who calls it and what it calls, across files, services, the HTTP boundary and React.

**Start a trace**
- click **⧉ Trace callers & callees** above any function the MR changed (a CodeLens in the diff), or
- put the cursor in any function and press **`Alt+T`** (or right-click → **Trace Callers & Callees**), or
- click ⧉ next to a function in the [Impact](#impact) view.

**What it follows**

| Direction | Links |
|---|---|
| **Up (callers)** | function calls · React `<Component />` renders · component → RTK Query hook → **API endpoint** · endpoint → **backend controller over HTTP** (matched by method + route, preferring the service the endpoint's `baseUrl` points to) |
| **Down (callees)** | function calls · component → hooks and child components · RTK hook → endpoint → **HTTP → controller** in the service |

Callers are followed up to 4 levels, stopping at natural entry points (tests, jobs, migrations); callees 2 levels. For frontend code, what matters downstream is which APIs it calls, so child components and hooks are shown one level deep while API endpoints always continue across HTTP to their controller. Endpoints of services outside the repository (e.g. an identity provider) end in an *external* box.

**The picture**
- One box per **app / service** (`web`, `orders-service`, `libs/nest` …), so crossing a service boundary is obvious.
- Cards show the **layer** (Component, Hook, API endpoint, Controller, Service, Repository, Job, Test …), `class · file:line`, the HTTP route for endpoints and handlers, **changed** when the MR touches it, and **tracing** on the function you started from.
- Edges: calls (solid), uses a hook (dotted), **HTTP** (dashed, labelled with the route).
- **Click** a card for details (callers, callees, open diff or file, mark viewed) and to highlight its paths; **Trace from here** re-centres the trace on that function. **Double-click** opens the code. The `+` on a card's left or right loads more callers or callees.
- **Toolbar:** search (`/`), show/hide tests, zoom, fit (`F`), **Copy Mermaid** (paste the trace into the MR description).

Routes and endpoints are read from the MR's own checkout, so **new routes and endpoints added in the MR are included**: a new route nothing calls yet shows no frontend callers, and a frontend call to a route that doesn't exist stays unresolved. The route index is built once per MR version (`git grep` + parsing; NestJS `@Controller`/`@Get…` and RTK Query `createApi`/`injectEndpoints`). Traces use the language server and this index only; no AI.

### "Affected by this MR" hover

Hover a name (function, class, type) in code that **did not change**, whose **definition the MR changed**, and the tooltip gains a line:

> **Affected by this MR**: `findAll` changed in `order.service.ts:20-31`
> [Open the change] · [Explain how this is affected (Alt+E)]

That tells you: this line looks untouched, but something it uses behaves differently now. It uses the language server only (no AI), and stays silent everywhere else. Turn it off with `ripple.hoverHints`.

---

## AI features

AI is **optional** and runs through the **`claude` CLI with each developer's own Claude login**. The extension never sees or stores Claude credentials.

**Setup:** install Claude Code and sign in once in a terminal (`claude`, then `/login`). If the CLI is missing or signed out, AI buttons explain what to do.

### AI review

Click **✨** in the Review toolbar. An options menu shows a **live token estimate**; pick **Generate AI review** to run it. You get:

- a **summary** (what the MR does, main changes, anything surprising),
- **review units**: the files split into logical steps in a suggested reading order, used for grouping the Review list,
- **risk hotspots**: specific files and lines to look at closely (auth, money, migrations, concurrency, error handling, security, performance, breaking API changes, missing tests), shown as badges in the Review list.

The result appears in the Review list and the MR Overview. **Post Summary to MR** (… menu) publishes it as a comment after asking.

### AI options

Chosen in the menu before each AI review (your choices become the defaults for next time; **AI Options…** changes them without running anything). Explain and Suggest use the same saved options.

| Option | Choices |
|---|---|
| **Model** | `sonnet` (balanced) · `haiku` (lightest on your usage) · `opus` (strongest, heaviest) |
| **File depth** | changed lines only · changed lines + context (default) · full changed files · **deep**: Claude may read other files of the MR checkout, read-only |
| **Max tokens** | 10k · 30k · 60k · 100k · custom. The largest diffs are left out first; in deep mode it also caps how much Claude may read. |
| **Scope** | all substantive files, or only the files currently shown in the Review list |
| **Test files** | included or left out |
| **Focus** | any of: security, performance, correctness, error handling, tests, API compatibility, data and migrations |

### Explain selection

Select any code, or just put the cursor in a function, and press **`Alt+E`** (or right-click → **AI: Explain (vs this MR)**). It works on the new side of a diff, on the old side (*what did the MR do to this code?*), and on files the MR didn't touch.

Before asking Claude, Ripple gathers the evidence itself (no AI):

1. the MR's changes **inside** the selection,
2. functions and types the selection **uses** that the MR changed (via go to definition and go to type definition),
3. callers, when the selected function itself changed,
4. the AI summary, if one exists.

For code without a language server (YAML, SQL, the old side), names are matched against the MR's changed lines instead, and marked *approximate*.

The explanation document shows a **verdict** (changed / affected by changes elsewhere / not affected / unclear), a short summary, **effects** each with a link to the line that causes it, a **checklist**, follow-up answers and the context that was used. **Ask a follow-up** from the Explain list: it reuses the same context, so follow-ups are cheap. **AI: Explain What This MR Does to This File** does the same for a whole file.

### Suggest review comments

Right-click in a diff (or the diff toolbar) → **AI: Suggest Review Comments for This File**. Up to 8 suggestions appear inline as **AI suggestion** threads, labelled Issue, Suggestion, Question or Nit. **✓** turns a suggestion into your GitLab draft; **🗑** discards it. Nothing is ever posted automatically.

### Cost and repeat protection

- Nothing AI-related runs on its own; every call is a click.
- **Each result is generated once** per MR version, target and options. Clicking again shows the existing result; a click while it's running joins that run. It only regenerates after new commits, with different options, or after a window reload (results are kept in memory only).
- Typical sizes: AI review up to your *max tokens* (default 30k); Explain 3–8k; Suggest 2–8k. Explain's evidence gathering and the hover hint use no AI at all.
- **View → Output → Ripple** logs every call with its tokens in and out, and a running total for the window; the AI summary row's tooltip shows the total too.

---

## Keyboard shortcuts

| Key | Action | When |
|---|---|---|
| `Alt+N` | open the next unviewed file | an MR is open |
| `Alt+Shift+N` | mark the current file viewed and open the next | an MR is open |
| `Alt+E` | explain the selection (or the function at the cursor) against the MR | an MR is open, editor focused |
| `Alt+T` | trace the function at the cursor (callers & callees) | an MR is open, editor focused |
| `Alt+U` | go to the next unresolved thread | an MR is open |

Inside a trace: `/` search · `F` fit · `+`/`−` zoom · `Enter` open · `Esc` clear.

## Commands

All commands are in the command palette under **Ripple:**.

| Area | Commands |
|---|---|
| Account | Sign in to GitLab · Sign out of GitLab |
| Getting started | Get Started (walkthrough) · Install Dependencies in Review Checkout |
| Merge requests | Open Merge Request by URL… · Refresh Merge Requests · Close Review · Remove Worktrees of Closed MRs |
| Review | Refresh · Filter Files… · Sort Files… · Group Files By… · Show Only Changes Since My Review · Compare With Version… · Mark This Version as Reviewed · Show/Hide Trivial Files · Mark All Trivial Files Viewed · Clear Focus · Open Next Unviewed File · Mark Viewed & Open Next · Open MR in GitLab |
| Comments | Go to Next Unresolved Thread · Open MR Overview & General Comments · Submit Review (publish drafts) · Approve MR · Revoke Approval |
| Code understanding | Trace Callers & Callees · Scan Cross-service Impact |
| AI | Generate AI Review… · AI Options… · AI: Post Summary to MR · AI: Explain (vs this MR) · AI: Explain What This MR Does to This File · AI: Ask a Follow-up About the Current Explanation… · AI: Add Current Explanation as Review Comment · AI: Suggest Review Comments for This File · Clear Explanations |

## Settings

| Setting | Default | Description |
|---|---|---|
| `ripple.gitlab.baseUrl` | `https://gitlab.com` | GitLab instance. User setting only. |
| `ripple.gitlab.clientId` | *(empty)* | Application ID of your GitLab OAuth app (not a secret; see [GitLab OAuth app](#signing-in)). Empty = sign in with a personal access token. |
| `ripple.gitlab.groups` | `[]` | Groups listed under *All open in …* and searched by Cross-service. Empty = your top-level groups / the MR's group. |
| `ripple.storageRoot` | `~/.ripple` | Where repository clones and review checkouts are kept. Machine setting. |
| `ripple.trivialGlobs` | lockfiles, snapshots, `dist/**` … | Files matching these globs are marked trivial. |
| `ripple.hoverHints` | `true` | Show the "Affected by this MR" hover. |
| `ripple.historyHover` | `true` | Show when the code a changed line replaces last changed (GitLab blame). |
| `ripple.commentLabels` | `true` | Expand `nit:`, `q:`, `b:` … into Conventional Comments labels. |
| `ripple.coverage.paths` | `coverage/{dir}/lcov.info`, `coverage/lcov.info` | Where lcov reports are in test jobs' artifacts; `{dir}` is the app/lib folder, e.g. `apps/web`. |
| `ripple.coverage.decorate` | `true` | Mark untested changed lines in diffs. |
| `ripple.checkForUpdates` | `true` | Check GitHub Releases once a day for a newer version. |
| `ripple.installDependencies` | `ask` | Offer once per project to install dependencies in the review checkout (`never` to turn off). |
| `ripple.traceCodeLens` | `true` | Show "Trace callers & callees" above every function the MR changed. |
| `ripple.ai.model` | `sonnet` | Default model in the AI options. |
| `ripple.ai.fastModel` | `haiku` | Model alias for lighter tasks. |
| `ripple.ai.maxInputTokens` | `30000` | Default *max tokens* in the AI options. |
| `ripple.ai.claudePath` | *(auto)* | Path to the `claude` CLI if it isn't found automatically. Machine setting. |

Settings that decide where your token goes or what gets executed (`gitlab.baseUrl`, `gitlab.clientId`, `storageRoot`, `ai.claudePath`) can't be overridden by a repository's `.vscode/settings.json`.

---

## How it works

```
~/.ripple/
  repos/<group>/<project>.git          bare partial clone per project (file contents downloaded on demand)
  worktrees/<group>__<project>/        one review checkout per project, moved to each MR's head commit
```

- Opening an MR fetches only its commits into the bare clone and moves the project's review checkout to the MR's head. Re-opening an MR that is already fetched needs no network.
- Diffs use GitLab's own comparison (merge base → head), so they match the MR's *Changes* tab.
- If you edit files in the review checkout, Ripple asks before discarding those edits when switching MRs.
- **Local data**: viewed state and filters per MR are small JSON files in VS Code's extension storage; your AI option defaults are a VS Code preference; GitLab tokens are in the OS keychain. AI results, traces and search results live in memory only. There is no database.
- **Remove Worktrees of Closed MRs** deletes checkouts whose last MR was merged or closed.

## Privacy and security

The checked-out MR is treated as **untrusted**: anyone who can open an MR controls its code, file names, CI artifacts and text.

- **GitLab:** all requests run as you (OAuth with PKCE; no secret is shipped in the extension). Git uses the same token through an in-memory header scoped to the GitLab host only (so helpers like git-lfs can't send it elsewhere); it is never written to `.git/config` or shown in the process list. LFS smudging, git tracing and diff text-conversion are off.
- **Checkout:** symlinks from the MR are checked out as plain files, and every file the extension reads (for AI prompts, route parsing, contracts) refuses symlinks and paths outside the checkout. Large CI artifacts are capped at 20 MB.
- **Settings:** settings that decide where your token goes, what runs, or what is hidden from review (`gitlab.baseUrl`, `gitlab.clientId`, `storageRoot`, `ai.claudePath`, `trivialGlobs`, `coverage.paths`) can only be set in user settings, never by a repository's `.vscode/settings.json`.
- **Claude:** code is sent only when you click an AI action. Every call runs sandboxed: no tools (or, in *deep* mode, only read-only Read/Grep/Glob confined to the MR checkout, with a spending cap), no MCP servers, no saved session, and none of your personal Claude Code settings, hooks or plugins. Because MR content can try prompt injection, AI answers are stripped of images and HTML before they are shown (no data can leave through an image URL), and nothing AI-generated is posted without your click. Check that your Claude plan's terms allow this kind of scripted use.
- **Webviews** use a strict Content Security Policy, and AI text is escaped before display.
- **Network:** Ripple only talks to your GitLab instance, to Claude through the `claude` CLI when you use AI, and to `api.github.com` for the daily update check (no identifiers sent; turn off with `ripple.checkForUpdates`). There is no telemetry.

## Troubleshooting

| Problem | What to check |
|---|---|
| No pipeline / coverage row | The MR has no pipeline yet, or no test job with an lcov report in its artifacts (check `ripple.coverage.paths`). |
| Something is slow | **View → Output → Ripple** shows how long each step took (API, fetch, checkout, diff, AI). |
| Sign-in page doesn't open | Is `ripple.gitlab.clientId` set? Without it, sign-in asks for a personal access token (scope `api`) at the top of the window. |
| Sign-in fails with `invalid_client` (401) | The OAuth app is marked *Confidential* (GitLab's default). Edit it, untick **Confidential**, save. Also check `ripple.gitlab.clientId` is the Application ID, not the secret. |
| GitLab says the redirect URI is invalid | The OAuth app is missing the URI for your editor; see [Signing in](#signing-in). |
| CMD+click does nothing at first | Wait a few seconds while the language server loads the project. For `node_modules`, install dependencies in the review checkout. |
| AI says the CLI is missing or signed out | Run `claude` in a terminal and `/login`; or set `ripple.ai.claudePath`. |
| Cross-service says search is not available | Advanced Search must be enabled for the group (gitlab.com Premium), and you need access to it. |
| Cross-service results are *partial* | GitLab's search rate limit was hit; scan again in a minute. |
| The hover never shows | It only appears on names whose definition the MR changed, on lines that didn't change themselves. |
| An MR won't switch | The review checkout has local edits; Ripple asks before discarding them. |

---

## Development

```bash
npm install
npm run build       # extension + webview bundles (or: npm run watch)
npm run typecheck
npm test            # vitest: core logic + a real git integration test
npm run test:e2e    # smoke test in a real VS Code against a fake GitLab and a fake claude
npm run test:visual # trace webview in headless Chrome: layout invariants + screenshot vs baseline (-- --update)
npm run package     # → ripple-<version>.vsix
```

**Releasing:** bump `version` in `package.json`, commit, then push a matching tag (`git tag v0.2.0 && git push --tags`). The Release workflow runs the tests, builds the `.vsix` and publishes a GitHub release; installed copies offer the update within a day.

Press **F5** in VS Code to start an Extension Development Host. *Run Extension (only Ripple)* disables your other extensions for a clean console; *Run Extension (with all my extensions)* keeps them.

```
src/
  extension.ts            activation: providers, command registration, first-run walkthrough
  app.ts                  shared state (views, session, store), friendly error handling
  commands/               commands per area: account, merge requests, review, comments, AI, code
  log.ts                  Output channel + timings
  auth/gitlabAuth.ts      OAuth (PKCE) / PAT sign-in, VS Code Accounts provider
  gitlab/                 typed REST client (MRs, discussions, drafts, approvals, pipelines, artifacts, blame, search); retries reads
  repo/                   git runner, bare clones and review worktrees
  core/                   pure logic, no vscode: diff parsing, classification, refactors, filters,
                          line mapping, dependencies, contract detection, HTTP endpoints/routes, layers, CODEOWNERS,
                          coverage, comment labels
  analysis/               changed symbols, impact, trace + route index, cross-service scan, review meta (CI, approvals, owners)
  ai/                     claude CLI runner, prompts, options, AI review, explain
  state/store.ts          per-MR JSON state, worktree registry
  ui/                     sidebar views, diffs, comments, MR overview, hover, explain documents, trace panel + CodeLens
  webview/                trace webview (runs in the browser sandbox)
media/walkthrough/        Get started pages
test/
  core.test.ts            unit tests
  visual/                 trace webview checks (fixtures, per-OS baselines)
  git.test.ts             integration test on a real git repository
  e2e/                    VS Code smoke test, fake GitLab server, fake claude CLI
```

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `npm run typecheck`, `npm test` and `npm run test:e2e`; if you change the trace panel, also `npm run test:visual` (update baselines with `-- --update` when the change is intended). Keep tests small and focused on behaviour that matters.

**Security issues:** please don't open a public issue. Report them privately through GitHub's **Security → Report a vulnerability** on this repository.

## License

See [LICENSE](LICENSE).
