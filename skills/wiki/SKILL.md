---
name: wiki
description: Work on the project wiki under .soap/wiki with the user — add to or reorganize existing pages, or set up the project's goals and other groundwork before work starts — and write every change as a draft in .soap/wiki/.drafts for the user to accept in Soap Panel's Wiki tab. Use only when explicitly invoked.
disable-model-invocation: true
---

# Wiki

Help the user build the project wiki on purpose: add to pages, reorganize them, or lay down the project's goals, scope and other groundwork before the work starts. The wiki is plain Markdown pages under `<session root>/.soap/wiki/`, grouped only by folders. The session root is the primary working directory this session started in, even after a Bash `cd`.

Never write, move or delete a page yourself. Every change is a draft the user accepts or discards in Soap Panel's Wiki tab.

## Pick the pages

Work on, in this order of preference:

1. The pages, folders or topic written after the command.
2. The pages the user sent from the Wiki tab earlier in this conversation (a message that starts "The user sent these pages from this project's wiki").
3. Otherwise list the pages under `.soap/wiki/` (skip folders starting with `.`) and ask which ones, or what to start, with the AskUserQuestion tool.

Read every page you will change, and skim the folder layout so new pages land where they fit.

## Talk it through

Ask one focused question at a time with the AskUserQuestion tool, offering two or three concrete options, recommended first, until you know what the pages should say. Do not use a fixed template: how many pages there are, which folders they go in and what they are called follow what the user tells you. Resolve facts about the code from the repository instead of asking.

Write the pages in the language the user writes to you in. Keep them terse: one fact or rule per bullet, the conclusion first, no filler, no account of this conversation. Prefer adding to an existing page over a new one when the topic fits.

## Write the drafts

Write each change as its own file directly under `<session root>/.soap/wiki/.drafts/`, named `<n>-<short-kebab-topic>.md` (`1-goals.md`, `2-delete-style.md`). The user accepts drafts one at a time, so number them in the order they must be accepted. The first line says what the draft does:

```text
target: project/goals.md

# Goals

- ...
```

`target: <page>.md`, a blank line, then the whole page as it should read afterwards: a new page, or one that replaces the page there.

```text
move: style.md -> conventions/style.md
```

`move: <page>.md -> <new page>.md` moves or renames a page with its text unchanged; nothing else goes in the file. It fails when a page is already at the new path.

```text
delete: naming.md
```

`delete: <page>.md` deletes a page; nothing else goes in the file.

Page paths are relative to `.soap/wiki/`, use `/`, end in `.md`, are lowercase-kebab-case, and have no part starting with a dot. To merge pages, write the merged page with `target:` and then delete each old one. To move a page and change it too, write it at the new path with `target:` and delete the old one, rather than a `move:` plus an edit. Soap Panel checks each draft after every Write or Edit; fix any problem it reports.

## Hand off

List the drafts you wrote, one line each (what it does to which page), and tell the user to open Soap Panel's Spec tab → Wiki to review them: Accept applies one, Discard drops one.
