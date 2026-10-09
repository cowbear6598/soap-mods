import { expect, test } from 'claude-code/testing'

import { fileKind, formatTrack, groupFiles, parseBranches, parseStatus, splitPath, toHunks } from './git'

// 面板的 props：引擎畫面板時一定會給，測試照實給一份。
const PANE_PROPS = {
  title: 'Soap Panel',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('the pane draws the Git tab with its three sub tabs on each surface', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'soap-mods',
      surface,
      component: 'Pane',
      requestId: 'soap-panel',
      props: PANE_PROPS,
    })
    expect(await ui.find({ key: 'tab:git' })).toBeDefined()
    for (const sub of ['diff', 'branch', 'conflict']) {
      expect(await ui.find({ key: `sub:${sub}` })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('the bottom of the pane shows 5h and weekly remaining, half each', async ($, on) => {
  const now = Date.parse('2026-10-09T10:00:00Z')
  on('clock.now', () => ({ value: now }))
  on('session.usage', () => ({
    value: {
      startedAt: now,
      context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-09T12:13:00Z' },
        { kind: 'seven_day', percentUsed: 85, resetsAt: '2026-10-12T13:00:00Z' },
      ],
    },
  }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'soap-mods', surface, component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
    expect(await ui.find({ key: 'usage:five_hour' })).toBeDefined()
    expect(await ui.find({ key: 'usage:seven_day' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5h · ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '77%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Weekly · ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '15%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · 2h 13m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · 3d 3h 0m' })).toBeDefined()
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

const SWITCH_FAILED = "fatal: a branch named 'main' already exists"

test('the pane lists changes, shows a diff and the branches, and switches sub tabs', async ($, on) => {
  const diffOpens: string[] = []
  on('ui.open', (_$, e) => {
    if (e.id === 'soap-diff') diffOpens.push(e.title ?? '')

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'switch') return { value: { ...ok('').value, exitCode: 128, stderr: SWITCH_FAILED } }
    if (cmd[0] === 'status') return ok('## main...origin/main [ahead 1]\0 M a.ts\0')
    if (cmd[0] === 'diff') return ok('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n')
    if (cmd[0] === 'for-each-ref') {
      return ok(
        [
          '*\trefs/heads/main\tmain\torigin/main\t\t1 hour ago\tAdd panel',
          ' \trefs/heads/dev\tdev\t\t\t2 days ago\tWip',
          ' \trefs/remotes/origin/main\torigin/main\t\t\t1 hour ago\tAdd panel',
          '',
        ].join('\n'),
      )
    }

    return ok('')
  })
  await $.command.run({
    command: 'soap-panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  const ui = await $.ui.mount({
    plugin: 'soap-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'soap-panel',
    props: PANE_PROPS,
  })
  expect(await ui.find({ key: 'file:unstaged:a.ts' })).toBeDefined()

  // 沒點之前不顯示差異；點了才在自己的面板裡看。
  await ui.press({ key: 'file:unstaged:a.ts' })
  const diff = await $.ui.mount({
    plugin: 'soap-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'soap-diff',
    props: PANE_PROPS,
  })
  expect(await diff.find({ type: 'Code' })).toBeDefined()
  await diff.unmount()

  // 桌面版整行都是按鈕：同一個 key 疊在整行上面，按下去一樣開差異面板。
  const desk = await $.ui.mount({
    plugin: 'soap-mods',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'soap-panel',
    props: PANE_PROPS,
  })
  expect(await desk.find({ type: 'Text', text: 'a.ts' })).toBeDefined()
  await desk.press({ key: 'file:unstaged:a.ts' })
  await desk.unmount()
  // 同一個檔案點兩次，兩次都是打開（不會變成收起來）。
  expect(diffOpens).toEqual(['a.ts', 'a.ts'])

  await ui.press({ key: 'sub:branch' })
  // 目前分支也算在 Local 裡，跟其他分支一樣是一列按鈕（點了不會被換掉，面板才不會丟焦點）。
  expect(await ui.find({ type: 'Text', text: 'Local · 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '●' })).toBeDefined()
  expect(await ui.find({ key: 'switch:l:main' })).toBeDefined()
  expect(await ui.find({ key: 'switch:l:dev' })).toBeDefined()
  // 遠端分支預設收起，按一下才展開。
  expect(await ui.find({ key: 'switch:r:origin/main' })).toBeUndefined()
  await ui.press({ key: 'remote:toggle' })
  expect(await ui.find({ key: 'switch:r:origin/main' })).toBeDefined()
  // 切換失敗的訊息顯示在 branch 頁，換分頁就清掉。
  await ui.press({ key: 'switch:r:origin/main' })
  expect(await ui.find({ type: 'Text', text: SWITCH_FAILED })).toBeDefined()
  await ui.press({ key: 'sub:diff' })
  await ui.press({ key: 'sub:branch' })
  expect(await ui.find({ type: 'Text', text: SWITCH_FAILED })).toBeUndefined()

  await ui.press({ key: 'sub:conflict' })
  expect(await ui.find({ type: 'Text', text: /Conflict view is not implemented/ })).toBeDefined()
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
  expect(files.map(f => `${f.x}${f.y}`)).toEqual([' M', 'A ', 'R ', '??'])
  // 差異面板的標題和檔案列的狀態字母用同一套分類。
  expect(files.map(fileKind)).toEqual(['modified', 'added', 'renamed', 'added'])
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
  expect(branches[2]?.isRemote).toBe(true)
})

test('groupFiles splits staged, unstaged and untracked, listing a file changed on both sides twice', () => {
  const { files } = parseStatus(['MM both.ts', 'A  new.ts', ' D gone.ts', 'UU clash.ts', '?? notes.md', ''].join('\0'))
  const groups = groupFiles(files)
  const show = (id: 'staged' | 'unstaged' | 'untracked') => groups[id].map(e => `${e.letter} ${e.file.path} ${e.kind}`)
  expect(show('staged')).toEqual(['M both.ts modified', 'A new.ts added'])
  expect(show('unstaged')).toEqual(['M both.ts modified', 'D gone.ts deleted', '! clash.ts conflict'])
  expect(show('untracked')).toEqual(['U notes.md added'])
})

test('splitPath and formatTrack', () => {
  expect(splitPath('hooks/git.ts')).toEqual({ name: 'git.ts', dir: 'hooks' })
  expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' })
  expect(formatTrack('[ahead 1, behind 2]')).toBe('↑1 ↓2')
  expect(formatTrack('[behind 3]')).toBe('↓3')
  expect(formatTrack('[gone]')).toBe('upstream gone')
  expect(formatTrack('')).toBe('')
})
