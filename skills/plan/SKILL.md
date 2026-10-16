---
name: plan
description: Create a minimal, repository-grounded implementation plan as .soap/tasks/<feature>/plan.yaml by inspecting the code and clarifying unresolved requirements. Use only when explicitly invoked. Do not use for implementation.
disable-model-invocation: true
---

# Plan

Inspect the current implementation and write a persistent plan. Do not implement the planned change.

## Create the plan

Derive an English kebab-case feature slug and immediately create:

```text
<session root>/.soap/tasks/<slug>/plan.yaml
```

The session root is the primary working directory this session started in; Soap Panel's Spec tab reads plans only there. Write the plan there even when the change lives in a nested project below it or a Bash `cd` moved the current directory. Paths in the plan are relative to the session root, and each `verify` command runs from it (prefix `cd <project> &&` when needed).

Never overwrite an unrelated plan. Update an existing directory only when the user refers to it; otherwise append `-2`, `-3`, and so on.

Use exactly these keys:

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

Only when the user supplies them, add `branch` and/or `issue-number` before `description` as quoted strings, such as `branch: "feature/PROJ-123-change"` and `issue-number: "PROJ-123"`.

Write `description`, `goals` and `constraints` in the language the user writes to you in; keep keys, the slug, paths, commands and identifiers as they are. Ask questions and report in that language too.

Write plain YAML only: top-level `key: value` pairs, `>` or `|` blocks, `- item` lists, and `[]` for an empty list. Quote an item that contains `: ` or starts with a YAML special character. Soap Panel checks the file after every Write or Edit; fix any problems it reports before going on.

## Ground the plan

Read repository instructions, relevant configuration, entry points, call paths, contracts, tests, and established patterns first. Resolve technical facts from the code instead of asking the user.

- `goals`: outcomes, not implementation steps. For frontend changes, describe the rendered state, user interaction, and observable result when they matter.
- `constraints`: only confirmed implementation boundaries; do not invent preferences or exclusions.
- `related`: affected and useful reference files. Include new paths only when existing conventions support them.
- `verify`: only confirmed, relevant automated test commands; no manual checks, acceptance criteria, lint, typecheck, or build commands. For frontend end-to-end tests, use the smallest command scoped to the feature (a single spec, test title, tag, or project), never the full suite unless the user asks. If none can be confirmed, omit it.

When the user supplies a reference image and viewport, save the image under `.soap/tasks/<slug>/assets/` with a descriptive filename, add it to `related`, record the viewport under `constraints`, and have the targeted end-to-end command assert both the post-interaction state and the visual comparison. Do not ask for an image or viewport merely because a task touches the frontend.

## Clarify requirements

Surface every unresolved requirement, ambiguity, conflict, tradeoff, compatibility concern, or verification gap that could affect the plan. Do not silently pick among plausible interpretations or record an assumption as fact.

Ask one focused question at a time with the AskUserQuestion tool, offering two or three concrete options with their tradeoffs, recommended first. Update the YAML with confirmed facts before pausing; never store open questions or conversation history in it.

## Hand off

Once purpose, behavior, scope, constraints, compatibility, affected surfaces, and verification are clear, reread the YAML against the rules above. Report the plan path and its goals without pasting the file, say when `verify` is empty, and mention that the plan is listed in Soap Panel's Spec tab.
