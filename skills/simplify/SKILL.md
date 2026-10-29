---
name: simplify
description: Clean up the changed files and the files they depend on or that depend on them — reuse, simplification, efficiency, altitude, meaningless comments and non-user-flow tests — then apply the fixes. Quality only; it does not hunt for bugs. Use only when explicitly invoked.
disable-model-invocation: true
---

# Simplify

Improve the quality of the code in scope, then apply the fixes directly. Do not hunt for correctness bugs, run tests, or write planning or review files. Report in the language the user writes to you in.

## Phase 0 — Scope

1. Pick the changes: a commit, ref, branch, PR or path the user passed; otherwise the working tree's tracked and untracked changes plus `@{upstream}...HEAD` (or `main...HEAD`). If nothing changed, ask what to simplify.
2. Find the dependency files. If the repository has `.codegraph/`, use CodeGraph (`codegraph_explore`, or `codegraph explore "<files or symbols>"`) for each changed file's callers and callees. Otherwise run, from inside the repository:

   ```bash
   python <skill-dir>/scripts/deps.py [FILE ...] [--base REF] [--json]
   ```

   With no FILE it takes the changes from step 1 itself (working tree plus upstream-or-main`...HEAD`). Use `python3` if `python` is missing.
3. Scope = the changed files plus the dependency files, **whole files**, not only the diff hunks; a narrower scope the user names wins. Tests in scope are the test files that cover a file in scope.
4. Preserve unrelated uncommitted user changes and avoid repository-wide refactors.

## Phase 1 — Review (6 agents in parallel)

Launch all six with the Agent tool in a single message, each with the scope file list, the diff, and one angle below, at the model given. Agents only review; they do not edit. Each returns findings as `file`, `line`, a one-line `summary`, and the concrete cost (what is duplicated, wasted, misleading or harder to maintain).

### Reuse — `opus`

Code in scope that re-implements something the codebase already has. Grep shared and utility modules and files near the change; name the existing helper to call instead.

### Altitude — `opus`

Changes that patch a symptom instead of fixing the root cause at the right depth. Special cases layered on shared infrastructure mean the fix is not deep enough; name the simpler, more general change to the underlying mechanism.

### Simplification — `sonnet`

Unnecessary complexity: redundant or derivable state, copy-paste with slight variation, needless branching, wrappers or indirection, deep nesting that guard clauses and early returns would flatten, dead code, functions mixing abstraction levels, unclear names. Name the simpler form that does the same job.

### Efficiency — `sonnet`

Wasted work: redundant computation or repeated I/O, independent operations run sequentially, blocking work on startup or hot paths, long-lived objects built from closures that keep a large enclosing scope alive (prefer a class or struct that copies only the fields it needs). Name the cheaper alternative.

### Tests — `sonnet`

Only tests that walk a user flow stay: one that drives the product from an entry point and checks the outside result (UI interaction, an API endpoint's response or DB state, a CLI command's output, a triggered job's effect). Flag for deletion:

- Tests of internal implementation: private functions, internal state, mock call counts.
- Unit tests of pure functions (parsers, formatters and the like).
- Edge-case tests (empty, null, extreme values), even when a user could reach the input.
- Tests already covered by a user-flow test.
- Tests that only exercise the language or a framework (getters, setters, constructors).
- Snapshot tests — except frontend E2E visual snapshots, which stay.

A regression test for a past bug that is written as a unit test is deleted too, but when no user-flow test covers that bug, flag it as **rewrite as a user-flow test, then delete**. Also flag helpers, fixtures and mocks that nothing uses once the flagged tests are gone.

### Comments — `haiku`

Flag for deletion:

- Comments that restate the code, and docs (JSDoc, docstrings, `///`) that the name already says — on public and internal functions alike.
- Stale comments that no longer match the code.
- Commented-out code.
- Change logs: `changed by`, `fix for #123`, `was: ...` — git records those.
- `TODO` / `FIXME`.
- Reference links (`see https://...`, RFC citations).
- File header descriptions of what the module does.

Keep comments that explain a non-obvious reason, constraint or tradeoff, and comments recording a pitfall someone hit (a workaround, a gotcha, why the obvious approach fails) — even in a file header or doc that the rules above would delete. Keep text the code reads at runtime, such as a docstring used as `--help`. Keep section dividers and tool directives (`eslint-disable`, `@ts-expect-error`, `//go:`, `#pragma`, `// SAFETY:`, `# type: ignore`, license headers).

## Phase 2 — Apply

Wait for all six agents. Dedup findings that point at the same line or mechanism, then fix each one directly, including deleting tests and their orphaned helpers (confirm nothing else references a helper first) and rewriting uncovered regression tests as user-flow tests before deleting them.

Leave a finding unapplied when its fix would change the product's intended behavior, require changes well outside the scope, or when you judge it a false positive. Sort each one by the reason, without arguing with it:

- **建議** — the idea is right, only not for this pass: it is a rewrite that needs testing again, reaches code outside this change, or is cleanup better done later. Say what it would improve and what it would take.
- **跳過** — not worth doing on its merits: the current behavior is intended, it would break an API or test contract, the gain is too small, the current code reads better, or it is a false positive.

## Report

Bullets only, grouped under these headings (in the user's language); omit an empty group. If nothing needed changing, say the code was already clean.

```markdown
## 已清理
- `path:line` — what changed

## 已刪測試
- `path` — test name: why

## 建議
- `path:line` — finding: what it would improve; why not now

## 跳過
- `path:line` — finding: why skipped
```
