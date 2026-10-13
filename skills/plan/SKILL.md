---
name: plan
description: Create a minimal, repository-grounded implementation plan as .soap/tasks/<feature>/plan.yaml by inspecting the code and clarifying unresolved requirements. Use only when explicitly invoked. Do not use for implementation.
disable-model-invocation: true
---

# Plan

Inspect the current implementation and write a persistent plan directly. Do not implement the planned change.

## Create the plan

Derive an English kebab-case feature slug and immediately create:

```text
.soap/tasks/<slug>/plan.yaml
```

Never overwrite an unrelated plan. Update an existing directory only when the user refers to it; otherwise append `-2`, `-3`, and so on.

Use these required keys:

```yaml
description: >
  Explain the current problem or opportunity, why the change is needed, and
  the value the intended outcome provides.
goals:
  - Add the user-visible outcome.
constraints: []
related:
  - src/path/affected-file.ts
verify:
  - npm test -- src/path/feature.spec.ts
```

When supplied by the user, add either or both company metadata fields before `description` and preserve their values as strings:

```yaml
branch: "feature/PROJ-123-change"
issue-number: "PROJ-123"
```

Do not request, infer, or add these metadata fields when they are absent. `description` must be a non-empty string. `goals`, `constraints`, `related`, and `verify` must be lists. The key is `goals` (plural), never `goal`. Add no other keys or nested task tracking.

Write plain YAML only: top-level `key: value` pairs, `>` or `|` blocks, `- item` lists, and `[]` for an empty list. Quote an item that contains `: ` or starts with a YAML special character. Soap Panel checks the file after every Write or Edit; when it reports problems, fix them before going on.

## Ground the plan

- Read repository instructions, relevant configuration, entry points, call paths, contracts, tests, and established patterns before finalizing the plan.
- Write outcomes rather than implementation steps under `goals`. For frontend changes, describe the rendered state, user interaction, and observable result when they matter to the feature.
- Record only confirmed implementation boundaries under `constraints`; do not invent preferences or exclusions. Use `constraints: []` when none are known.
- Record affected and useful reference files under `related` using repository-relative paths. Include new paths only when existing conventions support them.
- Put only confirmed, relevant automated test commands under `verify`; exclude manual checks, acceptance criteria, lint, typecheck, and build commands.
- Reuse facts and paths already discovered during the same planning session.

For frontend end-to-end verification, choose the smallest command scoped to the affected feature, such as a single spec, test title, tag, or project. Never substitute the full frontend end-to-end suite unless the user explicitly requests it. If no targeted frontend command can be confirmed, omit it; use `verify: []` and tell the user only when no other relevant automated test command exists.

When the user supplies a reference image and viewport for frontend verification:

- Save the image under `.soap/tasks/<slug>/assets/` with a stable descriptive filename.
- Add the saved repository-relative image path to `related`.
- Record the exact viewport under `constraints`.
- Use the targeted frontend end-to-end command in `verify` to cover both the relevant interaction result and visual comparison. A screenshot comparison does not replace assertions for the post-interaction state.

Do not ask for a reference image or viewport merely because a task touches the frontend.

## Clarify requirements

Investigate the repository before deciding whether the request is clear. Resolve technical facts from the code when possible instead of asking the user to supply information the repository already contains.

After inspection, surface every unresolved requirement, ambiguity, conflict, tradeoff, compatibility concern, constraint, or verification gap that could affect the plan. Do not silently choose among plausible interpretations or record an uncertain assumption as fact.

Ask one focused question at a time with the AskUserQuestion tool. When alternatives exist, offer two or three concrete options with their relevant tradeoffs, and put the recommended one first. Update the YAML with confirmed facts before pausing; do not store unanswered questions or conversation history in it.

Proceed to handoff only when the feature purpose, expected behavior, scope, constraints, compatibility, affected surfaces, and verification are clear.

## Validate and hand off

Before handoff, read the complete YAML and confirm:

- It contains the five required keys and only the optional `branch` and `issue-number` metadata when supplied.
- Its description explains the motivation and intended value.
- Its goals are outcomes, its constraints are confirmed, and its paths are grounded in the repository.
- Every verification entry is a supported, relevant automated test command, with frontend end-to-end commands scoped to the affected feature.
- No unresolved concern remains hidden in the plan.

Report the plan path and resolved goals without pasting the whole file unless asked. State when `verify` is empty. Mention that the plan is listed in Soap Panel's Spec tab.
