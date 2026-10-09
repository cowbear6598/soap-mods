import { expect, test } from 'claude-code/testing'

import { parseBranches, parseStatus, statusLabel, toHunks } from './git'

test('the pane draws the Git tab with its three sub tabs on each surface', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'soap-mods',
      surface,
      component: 'Pane',
      requestId: 'soap-panel',
      props: {},
    })
    expect(await ui.find({ key: 'tab:git' })).toBeDefined()
    for (const sub of ['diff', 'branch', 'conflict']) {
      expect(await ui.find({ key: `sub:${sub}` })).toBeDefined()
    }
    await ui.unmount()
  }
})

const ok = (stdout: string) => ({
  value: {
    exitCode: 0,
    stdout,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})

test('the pane lists changes, shows a diff and the branches, and switches sub tabs', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'status') return ok('## main...origin/main [ahead 1]\0 M a.ts\0')
    if (cmd[0] === 'diff') return ok('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n')
    if (cmd[0] === 'for-each-ref') {
      return ok('*\trefs/heads/main\tmain\torigin/main\t\t1 hour ago\tAdd panel\n')
    }

    return ok('')
  })
  await $.command.run({ command: 'soap-panel', args: '' })

  const ui = await $.ui.mount({
    plugin: 'soap-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'soap-panel',
    props: {},
  })
  expect(await ui.find({ key: 'file:a.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeDefined()

  await ui.press({ key: 'sub:branch' })
  expect(await ui.find({ type: 'Text', text: /● main/ })).toBeDefined()

  await ui.press({ key: 'sub:conflict' })
  expect(await ui.find({ type: 'Text', text: /conflict 還沒做/ })).toBeDefined()
  await ui.unmount()
})

test('parseStatus reads the branch line, changes, renames and untracked files', () => {
  const out = [
    '## main...origin/main [ahead 1]',
    ' M src/a.ts',
    'A  b c.ts',
    'R  new.ts',
    'old.ts',
    '?? notes.md',
    '',
  ].join('\0')
  const { head, files } = parseStatus(out)
  expect(head).toBe('main...origin/main [ahead 1]')
  expect(files.map(f => f.path)).toEqual(['src/a.ts', 'b c.ts', 'new.ts', 'notes.md'])
  expect(files.map(statusLabel)).toEqual(['·M', 'A·', 'R·', '??'])
})

test('toHunks drops the diff header and cuts long diffs at a line end', () => {
  const diff = 'diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'
  expect(toHunks(diff)).toEqual({ source: '@@ -1 +1 @@\n-a\n+b\n', isTruncated: false })
  expect(toHunks('Binary files differ').source).toBe('')
  const long = `@@ -1 +1 @@\n${'+x\n'.repeat(40000)}`
  const cut = toHunks(long)
  expect(cut.isTruncated).toBe(true)
  expect(cut.source.endsWith('+x')).toBe(true)
})

test('parseBranches puts the current branch first, locals before remotes, and skips origin/HEAD', () => {
  const out = [
    ' \trefs/heads/zeta\tzeta\t\t\t2 days ago\tlast',
    '*\trefs/heads/main\tmain\torigin/main\t[ahead 1]\t1 hour ago\tAdd panel',
    ' \trefs/remotes/origin/HEAD\torigin\t\t\t1 hour ago\tAdd panel',
    ' \trefs/remotes/origin/main\torigin/main\t\t\t1 hour ago\tAdd panel',
    '',
  ].join('\n')
  const branches = parseBranches(out)
  expect(branches.map(b => b.name)).toEqual(['main', 'zeta', 'origin/main'])
  expect(branches[0]).toMatchObject({ isCurrent: true, isRemote: false, track: '[ahead 1]', subject: 'Add panel' })
  expect(branches[2].isRemote).toBe(true)
})
