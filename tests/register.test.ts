import { expect, mock, test } from 'claude-code/testing'

import type { ScanResult } from '../types'
import { DANGER, GOOD, SWITCH_ARMED_HINT, WARN, DIFF_PAGE_ROWS, CODE_MAX_CHARS, RESTART_CHECK_MS } from '../hooks/config'
import {
  CONFLICTED,
  MAC_ARGS_OUT,
  MAC_FILES_OUT,
  MAC_PPIDS_OUT,
  MAC_ROOT,
  MAC_SCAN_OUT,
  ROOT,
  SCAN,
  type Pane,
  type TestOn,
  branchLine,
  endTurn,
  fail,
  fsEntry,
  gitRepo,
  mountPane,
  ok,
  openPanel,
  openTool,
  posix,
  proc,
  stubPanel,
  waitFor,
} from './test-fixtures'

test('the bottom of the pane shows 5h and weekly remaining, half each, on both surfaces', async ($, on) => {
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
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'tab:git' })).toBeDefined()
    expect(await ui.find({ key: 'usage:five_hour' })).toBeDefined()
    expect(await ui.find({ key: 'usage:seven_day' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5h · ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '77%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Weekly · ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '15%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · 2h 13m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · 3d 3h 0m' })).toBeDefined()
    // 終端機的 bar 是一段 █ 接一段 ░，顏色跟剩下的多少走。
    if (surface === 'terminal') {
      expect((await ui.findAll({ type: 'Text', text: /^█+$/ })).map(t => t.props.color)).toEqual(['success', 'error'])
    }
    await ui.unmount()
  }
})

// 5h、weekly 的用量讀數，用了幾 %；給 [] 是還沒有讀數。
function usage(on: TestOn) {
  const state = { used: [] as number[] }
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: state.used.map((percentUsed, i) => ({ kind: i === 0 ? 'five_hour' : 'seven_day', percentUsed })),
    },
  }))

  return state
}

test('the usage bar shows — until there is a reading, then colors what is left: green above half, yellow above a fifth, red below', async ($, on) => {
  const state = usage(on)
  // 每一半的百分比，和下面那條 bar 剩餘那段的填色。
  const colors = async () => ({
    percents: (await ui.findAll({ type: 'Text', text: /%$/ })).map(t => [t.text, t.props.color]),
    bars: (await ui.findAll({ type: 'Svg' }))
      .filter(svg => String(svg.props.alt).endsWith(' left'))
      .map(svg => [...String(svg.props.source).matchAll(/fill="([^"]+)"/g)].at(-1)?.[1]),
  })

  const ui = await mountPane($, 'desktop')
  expect(await ui.findAll({ type: 'Text', text: '—' })).toHaveLength(2)
  expect((await colors()).bars).toEqual([])

  // 剩一半不算多於一半：黃。
  state.used = [40, 50]
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: '—' })).toBeUndefined()
  expect(await colors()).toEqual({ percents: [['60%', 'success'], ['50%', 'warning']], bars: [GOOD.hex, WARN.hex] })

  state.used = [79, 80]
  await ui.redraw()
  expect(await colors()).toEqual({ percents: [['21%', 'warning'], ['20%', 'error']], bars: [WARN.hex, DANGER.hex] })
  await ui.unmount()
})

// ───── diff、branch ─────

test('pressing a changed file shows its diff over the tabs, Next/Previous step through the files, and Back returns', async ($, on) => {
  const diffArgs: string[][] = []
  stubPanel(on)
  gitRepo(on, {
    status: '## main...origin/main [ahead 1]\0R  new.ts\0old.ts\0 M a.ts\0?? b.ts\0',
    run: cmd => {
      if (cmd[0] !== 'diff') return undefined
      diffArgs.push(cmd)

      return ok('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n')
    },
  })
  await openPanel($)

  const ui = await mountPane($)
  expect(await ui.find({ key: 'file:unstaged:a.ts' })).toBeDefined()
  // 改名的檔案只列新名字。
  expect(await ui.find({ key: 'file:staged:new.ts' })).toBeDefined()
  expect(await ui.find({ key: 'file:staged:old.ts' })).toBeUndefined()
  // 沒點之前不顯示差異；點了在 Soap Panel 裡蓋掉分頁看，Back 回來。
  expect(await ui.find({ key: 'diff' })).toBeUndefined()
  await ui.press({ key: 'file:unstaged:a.ts' })
  expect(await ui.find({ key: 'diff' })).toBeDefined()
  expect(await ui.find({ key: 'tab:git' })).toBeUndefined()
  // Previous／Next 照 diff 分頁的順序走：new.ts → a.ts → b.ts（未追蹤的對空檔案），到頭了不動。
  expect(await ui.find({ type: 'Text', text: '2 of 3 files' })).toBeDefined()
  await ui.press({ key: 'diff:next' })
  expect(await ui.find({ type: 'Text', text: '3 of 3 files' })).toBeDefined()
  expect(diffArgs.at(-1)).toContain('--no-index')
  const reads = diffArgs.length
  await ui.press({ key: 'diff:next' })
  expect(diffArgs).toHaveLength(reads)
  await ui.press({ key: 'diff:prev' })
  expect(await ui.find({ type: 'Text', text: '2 of 3 files' })).toBeDefined()
  await ui.press({ key: 'diff:back' })
  expect(await ui.find({ key: 'diff' })).toBeUndefined()
  expect(await ui.find({ key: 'file:unstaged:a.ts' })).toBeDefined()
  await ui.unmount()
})

test('a diff longer than DIFF_PAGE_ROWS keeps its rows and pages through them, uncut past CODE_MAX_CHARS', async ($, on) => {
  // 兩段，各 DIFF_PAGE_ROWS 行加一行標頭：三頁；每行夠長，整份超過 CODE_MAX_CHARS，一頁還放得下 DIFF_PAGE_ROWS 行（含行號）。
  const line = 'x'.repeat(Math.floor(CODE_MAX_CHARS / DIFF_PAGE_ROWS) - 10)
  const hunk = (at: number) => `@@ -${at},${DIFF_PAGE_ROWS} +${at},${DIFF_PAGE_ROWS} @@\n${`-${line}a\n+${line}b\n`.repeat(DIFF_PAGE_ROWS / 2)}`
  const total = 2 * (DIFF_PAGE_ROWS + 1)
  stubPanel(on)
  gitRepo(on, {
    status: '## main\0 M a.ts\0',
    run: cmd => (cmd[0] === 'diff' ? ok(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n${hunk(1)}${hunk(2000)}`) : undefined),
  })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'file:unstaged:a.ts' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ key: 'diff:0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: `1–${DIFF_PAGE_ROWS} of ${total}` })).toBeDefined()
  expect(await ui.find({ key: 'diffpage:prev' })).toBeUndefined()

  await ui.press({ key: 'diffpage:next' })
  expect(await ui.find({ key: 'diff:0' })).toBeUndefined()
  expect(await ui.find({ key: `diff:${DIFF_PAGE_ROWS}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: `${DIFF_PAGE_ROWS + 1}–${2 * DIFF_PAGE_ROWS} of ${total}` })).toBeDefined()

  await ui.press({ key: 'diffpage:next' })
  expect(await ui.find({ key: `diff:${2 * DIFF_PAGE_ROWS + 1}` })).toBeDefined()
  expect(await ui.find({ key: 'diffpage:next' })).toBeUndefined()

  await ui.press({ key: 'diffpage:prev' })
  await ui.press({ key: 'diffpage:prev' })
  expect(await ui.find({ key: 'diff:0' })).toBeDefined()
  await ui.unmount()
})

const WORD_DIFF = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -10,4 +10,4 @@ fn',
  ' keep',
  '-const timeout = 3000',
  '-alpha beta',
  '+const timeout = 5000',
  '+gamma delta',
  '\\ No newline at end of file',
  '',
].join('\n')

test('a diff numbers each line, marks only the words that changed, and leaves a rewritten line unmarked', async ($, on) => {
  stubPanel(on)
  gitRepo(on, { status: '## main\0 M a.ts\0', run: cmd => (cmd[0] === 'diff' ? ok(WORD_DIFF) : undefined) })
  await openPanel($)

  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'file:unstaged:a.ts' })
  const rows = (await ui.findAll({ type: 'Box' })).filter(b => /^diff:\d+$/.test(b.key ?? '')).map(b => b.text)
  expect(rows).toEqual([
    '@@ -10,4 +10,4 @@ fn',
    '10   keep',
    '11 - const timeout = 3000',
    '12 - alpha beta',
    '11 + const timeout = 5000',
    '12 + gamma delta',
  ])
  const marked = (await ui.findAll({ type: 'Text' })).filter(t => t.props.backgroundColor !== undefined).map(t => t.text)
  expect(marked).toEqual(['3000', '5000'])
  await ui.unmount()
})

test('a diff tab row asks with a check first: the trash only deletes the file, rollback only takes it back to HEAD', async ($, on) => {
  const runs: string[] = []
  stubPanel(on)
  // 不是 Windows：用 rm -rf 刪。
  on('env.get', () => ({ value: undefined }))
  const isDone = (r: string) => runs.includes(r)
  gitRepo(on, {
    status: () =>
      [
        '## main',
        'R  new.ts\0old.ts',
        'A  c.ts',
        ...(isDone('git restore --source=HEAD --staged --worktree -- a.ts') ? [] : [' M a.ts']),
        isDone('rm -rf -- /repo/d.ts') ? ' D d.ts' : ' M d.ts',
        ...(isDone('rm -rf -- /repo/b.ts') ? [] : ['?? b.ts']),
        '?? nested/',
        '',
      ].join('\0'),
    run: (cmd, e) => {
      if (e.argv[0] === 'rm') {
        runs.push(e.argv.join(' '))

        return ok('')
      }
      if (cmd[0] !== 'restore') return undefined
      runs.push(`git ${cmd.join(' ')}`)

      return ok('')
    },
  })
  await openPanel($)

  const ui = await mountPane($)
  // 改名的、未追蹤的、新加的沒有 rollback；未追蹤的、新加的、改名的都還有垃圾桶。
  expect(await ui.find({ key: 'rollback:staged:new.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'rollback:untracked:b.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'rollback:staged:c.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'remove:staged:c.ts' })).toBeDefined()
  // 結尾是 / 的是裡面另一個 repo：整個資料夾不給刪。
  expect(await ui.find({ key: 'file:untracked:nested/' })).toBeDefined()
  expect(await ui.find({ key: 'remove:untracked:nested/' })).toBeUndefined()

  // 按一下只換成打勾，再按才刪。
  await ui.press({ key: 'remove:untracked:b.ts' })
  expect(runs).toEqual([])
  await ui.press({ key: 'remove:untracked:b.ts' })
  expect(runs).toEqual(['rm -rf -- /repo/b.ts'])
  expect(await ui.find({ key: 'file:untracked:b.ts' })).toBeUndefined()

  // 有追蹤的也只刪檔案：之後列成刪除，只剩 rollback。
  await ui.press({ key: 'remove:unstaged:d.ts' })
  await ui.press({ key: 'remove:unstaged:d.ts' })
  expect(runs.at(-1)).toBe('rm -rf -- /repo/d.ts')
  expect(await ui.find({ key: 'remove:unstaged:d.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'rollback:unstaged:d.ts' })).toBeDefined()

  // 按了 rollback 再按垃圾桶，打勾換到垃圾桶，不會刪。
  await ui.press({ key: 'rollback:unstaged:a.ts' })
  await ui.press({ key: 'remove:unstaged:a.ts' })
  expect(runs).toHaveLength(2)
  await ui.press({ key: 'rollback:unstaged:a.ts' })
  await ui.press({ key: 'rollback:unstaged:a.ts' })
  expect(runs.at(-1)).toBe('git restore --source=HEAD --staged --worktree -- a.ts')
  expect(await ui.find({ key: 'file:unstaged:a.ts' })).toBeUndefined()
  await ui.unmount()
})

const SWITCH_FAILED = "fatal: a branch named 'main' already exists"

test('the branch tab lists the branches, opens Remote, shows why a switch failed, and searches by name', async ($, on) => {
  stubPanel(on)
  gitRepo(on, {
    status: '## main...origin/main [ahead 1]\0',
    branches: [branchLine('main', { isCurrent: true, upstream: 'origin/main' }), branchLine('dev'), branchLine('origin/main')],
    run: cmd => (cmd[0] === 'switch' ? fail(SWITCH_FAILED) : undefined),
  })
  await openPanel($)

  const ui = await mountPane($)
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
  await ui.press({ key: 'switch:r:origin/main' })
  expect(await ui.find({ type: 'Text', text: SWITCH_FAILED })).toBeDefined()
  await ui.press({ key: 'sub:diff' })
  await ui.press({ key: 'sub:branch' })
  expect(await ui.find({ type: 'Text', text: SWITCH_FAILED })).toBeUndefined()

  // 搜尋：只留名稱符合的分支（不分大小寫），Remote 收著也直接列出來；換分頁就清掉。
  await ui.press({ key: 'remote:toggle' })
  await ui.input({ key: 'branch:search', text: 'MAIN', kind: 'change' })
  expect(await ui.find({ key: 'switch:l:main' })).toBeDefined()
  expect(await ui.find({ key: 'switch:l:dev' })).toBeUndefined()
  expect(await ui.find({ key: 'switch:r:origin/main' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Local · 1' })).toBeDefined()
  await ui.input({ key: 'branch:search', text: 'nope', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'No matching branches.' })).toBeDefined()
  // Clear（Enter）清空搜尋，全部分支回來。
  await ui.input({ key: 'branch:search', text: 'nope' })
  expect(await ui.find({ key: 'switch:l:dev' })).toBeDefined()
  await ui.input({ key: 'branch:search', text: 'dev', kind: 'change' })
  await ui.press({ key: 'sub:diff' })
  await ui.press({ key: 'sub:branch' })
  expect(await ui.find({ key: 'switch:l:dev' })).toBeDefined()
  expect(await ui.find({ key: 'switch:r:origin/main' })).toBeUndefined()
  await ui.unmount()
})

test('switching to another branch moves the current marker there, and the log tab then follows it', async ($, on) => {
  const switches: string[] = []
  const logRefs: string[] = []
  let current = 'main'
  stubPanel(on)
  gitRepo(on, {
    status: () => `## ${current}\0`,
    branches: () => [branchLine('main', { isCurrent: current === 'main' }), branchLine('dev', { isCurrent: current === 'dev' })],
    run: cmd => {
      if (cmd[0] === 'switch') {
        switches.push(cmd.join(' '))
        current = cmd[1] ?? ''

        return ok('')
      }
      if (cmd[0] !== 'log') return undefined
      logRefs.push(cmd[1] ?? '')

      return ok(`${'a'.repeat(40)}\taaaaaaa\t${'b'.repeat(40)}\tCptSoap\t0\tWip\n`)
    },
  })
  await openPanel($)
  // ● 畫在目前分支那列的最前面。
  const marked = async (branch: string) => (await ui.find({ key: `switch:l:${branch}:row` }))?.text.startsWith('●')

  const ui = await mountPane($)
  await ui.press({ key: 'sub:log' })
  expect(await ui.find({ type: 'Text', text: 'main · 1' })).toBeDefined()

  await ui.press({ key: 'sub:branch' })
  expect(await marked('main')).toBe(true)
  // 按一次只把那列標成再按一次，還不切；再按同一列才切。
  await ui.press({ key: 'switch:l:dev' })
  expect(switches).toEqual([])
  expect((await ui.find({ key: 'switch:l:dev:row' }))?.text.includes(SWITCH_ARMED_HINT)).toBe(true)
  await ui.press({ key: 'switch:l:dev' })
  expect(switches).toEqual(['switch dev'])
  expect(await ui.find({ type: 'Text', text: SWITCH_ARMED_HINT })).toBeUndefined()
  // ● 移到 dev；main 變成一般的分支，多了垃圾桶，dev 的垃圾桶不見了。
  expect(await marked('dev')).toBe(true)
  expect(await marked('main')).toBe(false)
  expect(await ui.find({ key: 'delete:l:main' })).toBeDefined()
  expect(await ui.find({ key: 'delete:l:dev' })).toBeUndefined()

  // log 一直跟著目前分支（HEAD），現在看的是 dev。
  await ui.press({ key: 'sub:log' })
  expect(await ui.find({ type: 'Text', text: 'dev · 1' })).toBeDefined()
  expect(logRefs.at(-1)).toBe('HEAD')
  await ui.unmount()
})

test('deleting a local branch asks with a check first, and forces the delete when it has unmerged commits', async ($, on) => {
  const deletes: string[] = []
  stubPanel(on)
  gitRepo(on, {
    status: '## main\0',
    branches: () => [branchLine('main', { isCurrent: true }), ...(deletes.includes('branch -D -- dev') ? [] : [branchLine('dev')])],
    run: cmd => {
      if (cmd[0] !== 'branch') return undefined
      deletes.push(cmd.join(' '))

      return cmd[1] === '-d' ? fail("error: the branch 'dev' is not fully merged", 1) : ok('')
    },
  })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:branch' })
  expect(await ui.find({ key: 'delete:l:main' })).toBeUndefined()

  // 按一下只換成打勾，再按才刪；-d 被拒（沒合併）就換成強制刪除的打勾，再按才 -D。
  await ui.press({ key: 'delete:l:dev' })
  expect(deletes).toEqual([])
  await ui.press({ key: 'delete:l:dev' })
  expect(deletes).toEqual(['branch -d -- dev'])
  expect(await ui.find({ type: 'Text', text: 'dev has unmerged commits; press again to force delete and lose them.' })).toBeDefined()
  await ui.press({ key: 'delete:l:dev' })
  expect(deletes).toEqual(['branch -d -- dev', 'branch -D -- dev'])
  expect(await ui.find({ key: 'switch:l:dev' })).toBeUndefined()
  await ui.unmount()
})

test('deleting a remote branch asks with a check first, then runs git push origin :refs/heads/feature/x', async ($, on) => {
  const pushes: string[] = []
  stubPanel(on)
  gitRepo(on, {
    status: '## main\0',
    branches: () => [
      branchLine('main', { isCurrent: true }),
      ...(pushes.length > 0 ? [] : [[' ', 'refs/remotes/origin/feature/x', 'origin/feature/x', '', '', '1 day ago', 'Wip'].join('\t')]),
    ],
    run: cmd => {
      if (cmd[0] === 'remote') return ok('origin\n')
      if (cmd[0] !== 'push') return undefined
      pushes.push(cmd.join(' '))

      return ok('')
    },
  })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:branch' })
  await ui.press({ key: 'remote:toggle' })

  await ui.press({ key: 'delete:r:origin/feature/x' })
  expect(pushes).toEqual([])
  await ui.press({ key: 'delete:r:origin/feature/x' })
  expect(pushes).toEqual(['push origin :refs/heads/feature/x'])
  expect(await ui.find({ key: 'switch:r:origin/feature/x' })).toBeUndefined()
  await ui.unmount()
})

test('an armed branch switch moves to the row pressed next and wears off after 3s', async ($, on) => {
  const clock = mock.clock(on)
  const switches: string[] = []
  stubPanel(on, { now: null })
  gitRepo(on, {
    status: '## main\0',
    branches: [branchLine('main', { isCurrent: true }), branchLine('dev'), branchLine('origin/main')],
    run: cmd => {
      if (cmd[0] !== 'switch') return undefined
      switches.push(cmd.join(' '))

      return ok('')
    },
  })
  await openPanel($)
  const hinted = async (key: string) => (await ui.find({ key: `${key}:row` }))?.text.includes(SWITCH_ARMED_HINT)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:branch' })
  await ui.press({ key: 'remote:toggle' })
  // 按 dev 再按 origin/main：標記移到 origin/main，dev 回復原樣；這時按 dev 只會重新標 dev。
  await ui.press({ key: 'switch:l:dev' })
  await ui.press({ key: 'switch:r:origin/main' })
  expect(await hinted('switch:l:dev')).toBe(false)
  expect(await hinted('switch:r:origin/main')).toBe(true)
  await ui.press({ key: 'switch:l:dev' })
  expect(switches).toEqual([])
  // 3 秒沒再按就收回去，再按又只是標記。
  await clock.advance(3_000)
  expect(await hinted('switch:l:dev')).toBe(false)
  await ui.press({ key: 'switch:l:dev' })
  expect(switches).toEqual([])
  // 遠端分支一樣按兩次，用 --track 切。
  await ui.press({ key: 'switch:r:origin/main' })
  await ui.press({ key: 'switch:r:origin/main' })
  expect(switches).toEqual(['switch --track origin/main'])
  await ui.unmount()
})

test('copying a branch name turns its copy button into a check for 2s', async ($, on) => {
  const clock = mock.clock(on)
  const copies: string[] = []
  stubPanel(on, { now: null })
  on('ui.copy', (_$, e) => {
    copies.push(e.text)

    return { value: { isCopied: true } }
  })
  gitRepo(on, { status: '## main\0', branches: [branchLine('main', { isCurrent: true }), branchLine('dev')] })
  await openPanel($)

  // 綠底是畫在圖示按鈕的外框上，只有桌面版有（終端機的按鈕吃不到顏色）。
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'sub:branch' })
  await ui.press({ key: 'copy:l:dev' })
  expect(copies).toEqual(['dev'])
  // 按了的那顆變成綠底，別顆不變；2 秒後換回來。
  expect((await ui.find({ key: 'copy:l:dev:box' }))?.props.backgroundColor).toBe(GOOD.hex)
  expect((await ui.find({ key: 'copy:l:main:box' }))?.props.backgroundColor).toBeUndefined()
  await clock.advance(2_000)
  expect((await ui.find({ key: 'copy:l:dev:box' }))?.props.backgroundColor).toBeUndefined()
  await ui.unmount()
})

const PULL_FAILED = 'fatal: Not possible to fast-forward, aborting.'

test('Fetch and Pull run git without asking for a password, toast when done, and show why a pull failed', async ($, on) => {
  const syncs: string[] = []
  const toasts: string[] = []
  let isDiverged = false
  mock.clock(on)
  stubPanel(on, { now: null })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  gitRepo(on, {
    status: '## main\0',
    branches: [branchLine('main', { isCurrent: true, upstream: 'origin/main' })],
    run: (cmd, e) => {
      if (cmd[0] !== 'fetch' && cmd[0] !== 'pull') return undefined
      syncs.push(`${cmd.join(' ')} prompt=${e.init?.env?.GIT_TERMINAL_PROMPT}`)
      if (cmd[0] === 'pull' && isDiverged) return fail(PULL_FAILED)

      return ok(cmd[0] === 'pull' ? 'Already up to date.\n' : '')
    },
  })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:branch' })
  // 按了才跑。
  expect(syncs).toEqual([])

  await ui.press({ key: 'branch:fetch' })
  await ui.press({ key: 'branch:pull' })
  expect(syncs).toEqual(['fetch --all --prune prompt=0', 'pull --ff-only prompt=0'])
  expect(toasts).toEqual(['Fetched', 'Already up to date'])

  // 跟遠端分岔了：只快轉的 pull 失敗，顯示 git 的訊息，換分頁就清掉。
  isDiverged = true
  await ui.press({ key: 'branch:pull' })
  expect(await ui.find({ type: 'Text', text: PULL_FAILED })).toBeDefined()
  expect(await ui.find({ key: 'branch:pull' })).toBeDefined()
  await ui.press({ key: 'sub:diff' })
  await ui.press({ key: 'sub:branch' })
  expect(await ui.find({ type: 'Text', text: PULL_FAILED })).toBeUndefined()
  await ui.unmount()
})

test('long file and branch lists draw the first 50, with pages of 50 for files and search for branches', async ($, on) => {
  const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`)
  stubPanel(on)
  gitRepo(on, {
    status: `## main\0${names('m', 10).map(f => ` M ${f}.ts\0`).join('')}${names('f', 70).map(f => `?? ${f}.ts\0`).join('')}`,
    branches: [branchLine('main', { isCurrent: true }), ...names('origin/b', 60).map(b => branchLine(b))],
  })
  await openPanel($)

  const ui = await mountPane($)
  // 三組加起來一頁 50 列：10 個 Unstaged 加 40 個 Untracked。
  expect(await ui.find({ key: 'file:unstaged:m09.ts' })).toBeDefined()
  expect(await ui.find({ key: 'file:untracked:f39.ts' })).toBeDefined()
  expect(await ui.find({ key: 'file:untracked:f40.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'file:prev' })).toBeUndefined()
  // Next 換成下一頁，不是接著多畫：一頁最多 50 列，畫太多桌面版會卡住。
  await ui.press({ key: 'file:next' })
  expect(await ui.find({ key: 'file:untracked:f40.ts' })).toBeDefined()
  expect(await ui.find({ key: 'file:untracked:f69.ts' })).toBeDefined()
  expect(await ui.find({ key: 'file:untracked:f39.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'file:unstaged:m00.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'file:next' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '51–80 of 80' })).toBeDefined()
  await ui.press({ key: 'file:prev' })
  expect(await ui.find({ key: 'file:unstaged:m00.ts' })).toBeDefined()
  expect(await ui.find({ key: 'file:untracked:f40.ts' })).toBeUndefined()

  await ui.press({ key: 'sub:branch' })
  await ui.press({ key: 'remote:toggle' })
  expect(await ui.find({ key: 'switch:r:origin/b49' })).toBeDefined()
  expect(await ui.find({ key: 'switch:r:origin/b50' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '… 10 more; search to narrow down' })).toBeDefined()
  await ui.input({ key: 'branch:search', text: 'b55', kind: 'change' })
  expect(await ui.find({ key: 'switch:r:origin/b55' })).toBeDefined()
  await ui.unmount()
})

test('branches with / in their name group into folders that open and close', async ($, on) => {
  stubPanel(on)
  gitRepo(on, {
    status: '## soap/feature/login\0',
    branches: [
      branchLine('soap/feature/login', { isCurrent: true }),
      branchLine('feature/a'),
      branchLine('feature/b'),
      branchLine('main'),
      branchLine('origin/main'),
      branchLine('origin/feature/x'),
    ],
  })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:branch' })
  // 目前分支固定在最上面寫全名；其他分支收在資料夾裡，預設收起。
  expect(await ui.find({ key: 'switch:l:soap/feature/login' })).toBeDefined()
  expect(await ui.find({ key: 'switch:l:main' })).toBeDefined()
  expect(await ui.find({ key: 'switch:l:feature/a' })).toBeUndefined()
  await ui.press({ key: 'folder:l:feature/' })
  expect(await ui.find({ key: 'switch:l:feature/a' })).toBeDefined()
  await ui.press({ key: 'folder:l:feature/' })
  expect(await ui.find({ key: 'switch:l:feature/a' })).toBeUndefined()
  // Remote 只有 origin/ 一個資料夾：不畫它，直接列它裡面的。
  await ui.press({ key: 'remote:toggle' })
  expect(await ui.find({ key: 'folder:r:origin/' })).toBeUndefined()
  expect(await ui.find({ key: 'folder:r:origin/feature/' })).toBeDefined()
  expect(await ui.find({ key: 'switch:r:origin/main' })).toBeDefined()
  await ui.press({ key: 'remote:toggle' })
  // 搜尋時資料夾全部打開；打好幾個字要全部都有。
  await ui.input({ key: 'branch:search', text: 'b', kind: 'change' })
  expect(await ui.find({ key: 'switch:l:feature/b' })).toBeDefined()
  await ui.input({ key: 'branch:search', text: 'feature b', kind: 'change' })
  expect(await ui.find({ key: 'switch:l:feature/b' })).toBeDefined()
  expect(await ui.find({ key: 'switch:l:feature/a' })).toBeUndefined()
  expect(await ui.find({ key: 'switch:l:soap/feature/login' })).toBeUndefined()
  await ui.unmount()
})

test('a session folder holding several repos gets a repo bar with counts, and pressing one switches the Git tab to it', async ($, on) => {
  const logCwds: (string | undefined)[] = []
  stubPanel(on, { root: '/company' })
  // Bash 在回合中 cd 進 a 去 commit，shell 的 cwd 跟著跑，但專案根目錄不變：repo bar 還是要列出 a、b。
  on('session.cwd', () => ({ value: '/company/a' }))
  // company/ 底下：a、b 是 repo，docs 不是，.cache 是隱藏資料夾；各 repo 的 .git 裡沒有進行中的操作。
  on('fs.list', (_$, e) => ({ value: posix(e.path) === '/company' ? [fsEntry('b', 'dir'), fsEntry('a', 'dir'), fsEntry('docs', 'dir'), fsEntry('.cache', 'dir')] : [] }))
  on('fs.exists', (_$, e) => ({ value: ['/company/a/.git', '/company/b/.git'].includes(posix(e.path) ?? '') }))
  on('process.run', (_$, e) => {
    const cwd = posix(e.init?.cwd)
    const args = e.argv.slice(3)
    if (args[0] === 'rev-parse') return cwd === '/company' ? fail('fatal: not a git repository (or any of the parent directories): .git') : ok(`${cwd}\n${cwd}/.git\n`)
    if (args[0] === 'log') logCwds.push(cwd)
    if (args[0] === 'status' && cwd === '/company/a') return ok('## main\0 M a1.ts\0 M a2.ts\0')
    if (args[0] === 'status' && cwd === '/company/b') return ok('## main\0UU b1.ts\0')

    return ok('')
  })
  await openPanel($)

  const ui = await mountPane($)
  // 照名稱排，一開始看第一個；有變更、有衝突標在名稱後面，不是 repo 的資料夾不列。
  expect((await ui.find({ key: 'repo:a' }))?.props).toMatchObject({ label: 'a*', variant: 'primary' })
  expect((await ui.find({ key: 'repo:b' }))?.props).toMatchObject({ label: 'b* !', variant: 'secondary' })
  expect(await ui.find({ key: 'repo:docs' })).toBeUndefined()
  expect(await ui.find({ key: 'file:unstaged:a1.ts' })).toBeDefined()
  await ui.press({ key: 'sub:log' })
  expect(logCwds.at(-1)).toBe('/company/a')

  await ui.press({ key: 'repo:b' })
  expect((await ui.find({ key: 'repo:b' }))?.props).toMatchObject({ variant: 'primary' })
  // log 也換成 b 的。
  expect(logCwds.at(-1)).toBe('/company/b')
  await ui.press({ key: 'sub:diff' })
  expect(await ui.find({ key: 'file:unstaged:a1.ts' })).toBeUndefined()
  await ui.press({ key: 'sub:conflict' })
  expect(await ui.find({ key: 'conflict:b1.ts' })).toBeDefined()
  await ui.unmount()
})

// ───── log ─────

// main 有 40 筆 commit（Commit 0 最新），都是 CptSoap 三天前寫的；有 upstream，領先兩筆。
const LOG_NOW = Date.parse('2026-10-11T00:00:00Z')
const short = (i: number) => String(i).padStart(7, '0')
const sha = (i: number) => `${short(i)}${'f'.repeat(33)}`

function logRepo(on: TestOn) {
  const logArgs: string[][] = []
  const revListArgs: string[][] = []
  const diffTreeArgs: string[][] = []
  const time = LOG_NOW / 1000 - 3 * 86400
  stubPanel(on, { now: LOG_NOW })
  gitRepo(on, {
    status: '## main...origin/main [ahead 2]\0',
    branches: [branchLine('main', { isCurrent: true, upstream: 'origin/main', track: '[ahead 2]' }), branchLine('dev'), branchLine('origin/main')],
    run: cmd => {
      if (cmd[0] === 'log') {
        logArgs.push(cmd)
        // 照 --skip、--max-count 給；沒給就是整條（搜尋）。
        const arg = (name: string) => cmd.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
        const skip = Number(arg('skip') ?? 0)
        const count = Math.min(Number(arg('max-count') ?? Infinity), 40 - skip)
        const lines = Array.from({ length: count }, (_, n) => skip + n).map(i => `${sha(i)}\t${short(i)}\t${sha(i + 1)}\tCptSoap\t${time}\tCommit ${i}`)

        return ok(`${lines.join('\n')}\n`)
      }
      if (cmd[0] === 'rev-list') {
        revListArgs.push(cmd)

        return ok(`${sha(0)}\n${sha(1)}\n`)
      }
      if (cmd[0] === 'diff-tree') {
        diffTreeArgs.push(cmd)
        // 每個 commit 都改了 src/a.ts、把 old.ts 改名成 new.ts。
        if (cmd.includes('--name-status')) return ok(['M', 'src/a.ts', 'R100', 'old.ts', 'new.ts', ''].join('\0'))

        return ok('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n')
      }

      return undefined
    },
  })

  return { logArgs, revListArgs, diffTreeArgs }
}

test('the log tab lists the latest 30 commits of the branch, marks the unpushed ones, and pages with Previous / Next', async ($, on) => {
  const { revListArgs } = logRepo(on)
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:log' })
  // 預設看目前分支：先列 30 筆，還有更多；標題寫分支名稱。
  expect(await ui.find({ type: 'Text', text: 'main · 30+' })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(29)}` })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(30)}` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: short(0) })).toBeDefined()
  // 作者、時間各一欄。
  expect(await ui.find({ type: 'Text', text: 'CptSoap' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3d' })).toBeDefined()
  // 有 upstream：跟 upstream 比哪些還沒 push，那兩筆標 ↑。
  expect(revListArgs.at(-1)).toEqual(['rev-list', '--max-count=30', 'HEAD', '--not', 'origin/main', '--'])
  expect(await ui.findAll({ type: 'Text', text: '↑' })).toHaveLength(2)

  expect(await ui.find({ key: 'log:prev' })).toBeUndefined()
  // Next 換成下一頁（跳過前 30 筆），不是接著多畫。
  await ui.press({ key: 'log:next' })
  expect(await ui.find({ type: 'Text', text: 'main · 40' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '31–40' })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(30)}` })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(29)}` })).toBeUndefined()
  expect(await ui.find({ key: 'log:next' })).toBeUndefined()
  await ui.press({ key: 'log:prev' })
  expect(await ui.find({ key: `commit:${sha(0)}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'main · 30+' })).toBeDefined()
  await ui.unmount()
})

test('pressing a commit lists its files, a file shows its diff in that commit, and Back walks back out', async ($, on) => {
  logRepo(on)
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:log' })
  // 點 commit：列表換成它改了哪些檔案；點檔案在 Soap Panel 裡看它在這個 commit 的差異。
  await ui.press({ key: `commit:${sha(0)}` })
  expect(await ui.find({ type: 'Text', text: 'Files · 2' })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(1)}` })).toBeUndefined()
  await ui.press({ key: 'commit-file:src/a.ts' })
  expect(await ui.find({ key: 'diff' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: `@ ${short(0)}` })).toBeDefined()
  // Back 回到 commit 的檔案列表，再 Back 回 commit 列表。
  await ui.press({ key: 'diff:back' })
  expect(await ui.find({ type: 'Text', text: 'Files · 2' })).toBeDefined()
  await ui.press({ key: 'log:back' })
  expect(await ui.find({ key: `commit:${sha(1)}` })).toBeDefined()
  await ui.unmount()
})

test('Select range opens the commits between two presses together, and Next/Previous step through its files', async ($, on) => {
  const { diffTreeArgs } = logRepo(on)
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:log' })
  // 點起點（再點一次取消）、再點終點，兩筆之間（含）一起打開：最舊那筆之前 → 最新那筆。
  await ui.press({ key: 'log:range' })
  expect(await ui.find({ type: 'Text', text: 'Press the first commit of the range.' })).toBeDefined()
  await ui.press({ key: `commit:${sha(0)}` })
  await ui.press({ key: `commit:${sha(0)}` })
  expect(await ui.find({ type: 'Text', text: 'Press the first commit of the range.' })).toBeDefined()
  await ui.press({ key: `commit:${sha(0)}` })
  expect(await ui.find({ type: 'Text', text: 'Press the other end of the range.' })).toBeDefined()
  await ui.press({ key: `commit:${sha(2)}` })
  expect(diffTreeArgs.at(-1)?.slice(-2)).toEqual([sha(3), sha(0)])
  expect(await ui.find({ type: 'Text', text: `3 commits · ${short(2)}…${short(0)}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Files · 2' })).toBeDefined()
  await ui.press({ key: 'commit-file:src/a.ts' })
  expect(diffTreeArgs.at(-1)).toContain(sha(3))
  expect(await ui.find({ type: 'Text', text: `@ ${short(2)}…${short(0)}` })).toBeDefined()
  // 差異的 Previous／Next（n／m）：換成同一批的上一個／下一個檔案，改名兩個路徑都給，到頭了不動。
  expect(await ui.find({ type: 'Text', text: '1 of 2 files' })).toBeDefined()
  await ui.press({ key: 'diff:next' })
  expect(await ui.find({ type: 'Text', text: 'new.ts' })).toBeDefined()
  expect(diffTreeArgs.at(-1)?.slice(-2)).toEqual(['old.ts', 'new.ts'])
  expect(await ui.find({ type: 'Text', text: '2 of 2 files' })).toBeDefined()
  const reads = diffTreeArgs.length
  await ui.press({ key: 'diff:next' })
  expect(diffTreeArgs).toHaveLength(reads)
  await ui.press({ key: 'diff:prev' })
  expect(await ui.find({ type: 'Text', text: '1 of 2 files' })).toBeDefined()
  // Back 回檔案列表，再 Back 回 commit 列表，選範圍結束。
  await ui.press({ key: 'diff:back' })
  await ui.press({ key: 'log:back' })
  expect(await ui.find({ type: 'Text', text: 'Press the first commit of the range.' })).toBeUndefined()
  // Cancel 也結束。
  await ui.press({ key: 'log:range' })
  await ui.press({ key: 'log:range' })
  expect(await ui.find({ type: 'Text', text: 'Press the first commit of the range.' })).toBeUndefined()
  await ui.unmount()
})

test('the log search finds commits across the whole branch, and the log icon of a branch row opens that branch', async ($, on) => {
  const { logArgs, revListArgs } = logRepo(on)
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:log' })
  // 搜整條分支（包括還沒列出來的），比對 subject、作者、sha，每個字都要有、不分大小寫。
  await ui.input({ key: 'log:search', text: 'COMMIT 3', kind: 'change' })
  // 3、13、23、30–39。
  expect(await ui.find({ type: 'Text', text: 'main · 13' })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(39)}` })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(1)}` })).toBeUndefined()
  await ui.input({ key: 'log:search', text: 'commit 39', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'main · 1' })).toBeDefined()
  await ui.input({ key: 'log:search', text: short(39), kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'main · 1' })).toBeDefined()
  await ui.input({ key: 'log:search', text: 'nope', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'No matching commits.' })).toBeDefined()
  // 符合的超過 30 筆一樣分頁。
  await ui.input({ key: 'log:search', text: 'cptsoap', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'main · 30+' })).toBeDefined()
  await ui.press({ key: 'log:next' })
  expect(await ui.find({ type: 'Text', text: 'main · 40' })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(39)}` })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(0)}` })).toBeUndefined()
  // Clear（Enter）清空，回到最近 30 筆。
  await ui.input({ key: 'log:search', text: 'cptsoap' })
  expect(await ui.find({ type: 'Text', text: 'main · 30+' })).toBeDefined()
  // 換分頁也清掉。
  await ui.input({ key: 'log:search', text: 'commit 39', kind: 'change' })
  await ui.press({ key: 'sub:diff' })
  await ui.press({ key: 'sub:log' })
  expect(await ui.find({ type: 'Text', text: 'main · 30+' })).toBeDefined()

  // branch 分頁每一列右邊的 log：跳到 log 分頁看那個分支。沒有 upstream 就跟所有遠端分支比。
  await ui.press({ key: 'sub:branch' })
  await ui.press({ key: 'log:l:dev' })
  expect(await ui.find({ type: 'Text', text: 'dev · 30+' })).toBeDefined()
  expect(logArgs.at(-1)?.[1]).toBe('refs/heads/dev')
  expect(revListArgs.at(-1)).toEqual(['rev-list', '--max-count=30', 'refs/heads/dev', '--not', '--remotes', '--'])
  // 按目前分支那列的 log：回到跟著目前分支。
  await ui.press({ key: 'sub:branch' })
  await ui.press({ key: 'log:l:main' })
  expect(await ui.find({ type: 'Text', text: 'main · 30+' })).toBeDefined()
  expect(logArgs.at(-1)?.[1]).toBe('HEAD')
  await ui.unmount()
})

// ───── Files ─────

test('the Files tab lists the session folder, folders first, opens a folder and goes back up', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.list', (_$, e) => {
    const path = posix(e.path)
    if (path === '/proj') return { value: [fsEntry('README.md', 'file', 4300), fsEntry('src', 'dir')] }
    if (path === '/proj/src') return { value: [fsEntry('main.ts', 'file', 120)] }

    return { value: [] }
  })
  on('process.run', () => ok(''))

  const ui = await mountPane($)
  await ui.press({ key: 'tab:files' })
  expect(await ui.find({ key: 'sub:diff' })).toBeUndefined()
  expect(await ui.find({ key: 'files:dir:src' })).toBeDefined()
  expect(await ui.find({ key: 'files:file:README.md' })).toBeDefined()
  // 大小那欄：數字、單位分兩格。
  expect(await ui.find({ type: 'Text', text: '4.2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'KB' })).toBeDefined()
  // session 資料夾本身：沒有路徑、沒有 Back。
  expect(await ui.find({ key: 'files:back' })).toBeUndefined()

  await ui.press({ key: 'files:dir:src' })
  expect(await ui.find({ type: 'Text', text: 'src/' })).toBeDefined()
  expect((await ui.find({ key: 'files:back' }))?.props).toMatchObject({ label: '← Back', hotkey: 'b' })
  expect(await ui.find({ key: 'files:file:main.ts' })).toBeDefined()

  await ui.press({ key: 'files:back' })
  expect(await ui.find({ key: 'files:dir:src' })).toBeDefined()
  await ui.unmount()
})

test('the Files search finds file names in every folder below the session folder, skips node_modules, opens a match, and Clear goes back', async ($, on) => {
  const tree: Record<string, ReturnType<typeof fsEntry>[]> = {
    '/proj': [fsEntry('src', 'dir'), fsEntry('node_modules', 'dir'), fsEntry('Login.md')],
    '/proj/src': [fsEntry('login', 'dir'), fsEntry('app.ts')],
    '/proj/src/login': [fsEntry('form.tsx')],
    '/proj/node_modules': [fsEntry('login.js')],
  }
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.list', (_$, e) => ({ value: tree[posix(e.path) ?? ''] ?? [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 4, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'form' }))
  on('process.run', () => ok(''))

  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'tab:files' })
  await ui.input({ key: 'files:search', text: 'LOGIN', kind: 'change' })
  // 檔名符合的排前面，資料夾符合的在後；node_modules 不找；搜尋時不列資料夾內容。
  expect(await waitFor(() => ui.find({ key: 'files:found:src/login/form.tsx' }))).toBeDefined()
  expect(await ui.find({ key: 'files:found:Login.md' })).toBeDefined()
  expect(await ui.find({ key: 'files:found:node_modules/login.js' })).toBeUndefined()
  expect(await ui.find({ key: 'files:dir:src' })).toBeUndefined()

  await ui.input({ key: 'files:search', text: 'nope', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'No files match.' })).toBeDefined()

  await ui.input({ key: 'files:search', text: 'form', kind: 'change' })
  await ui.press({ key: 'files:found:src/login/form.tsx' })
  expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ path: 'src/login/form.tsx' })
  await ui.press({ key: 'fileview:back' })

  await ui.input({ key: 'files:search', text: 'form' })
  expect(await ui.find({ key: 'files:dir:src' })).toBeDefined()
  expect(await ui.find({ key: 'files:found:src/login/form.tsx' })).toBeUndefined()
  await ui.unmount()
})

test('the panel opens on the Files tab; on the terminal the whole search box focuses it and a Clear button sits after it', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.list', () => ({ value: [fsEntry('Login.md')] }))
  on('process.run', () => ok(''))
  on('ui.focus', () => ({}))

  const ui = await mountPane($, 'terminal', 'files')
  expect((await ui.find({ key: 'tab:files' }))?.props).toMatchObject({ variant: 'primary' })
  expect(await ui.find({ key: 'sub:diff' })).toBeUndefined()

  // 框底下墊一顆一樣大的透明按鈕：點框裡字以外的地方，它把焦點移到框上。
  expect((await ui.find({ key: 'files:search:focus' }))?.props).toMatchObject({ plain: true })
  await ui.press({ key: 'files:search:focus' })

  await ui.input({ key: 'files:search', text: 'login', kind: 'change' })
  expect(await waitFor(() => ui.find({ key: 'files:found:Login.md' }))).toBeDefined()
  await ui.press({ key: 'files:search:clear' })
  expect(await ui.find({ key: 'files:found:Login.md' })).toBeUndefined()
  expect((await ui.find({ key: 'files:search' }))?.props).toMatchObject({ value: '' })
  await ui.unmount()
})

test('on the terminal a search result is one button from its name through its folder, the name padded to one width', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.list', (_$, e) => ({ value: posix(e.path) === '/proj' ? [fsEntry('CLAUDE.md'), fsEntry('skills', 'dir')] : [fsEntry('SKILL.md')] }))
  on('process.run', () => ok(''))

  const ui = await mountPane($, 'terminal', 'files')
  await ui.input({ key: 'files:search', text: '.md', kind: 'change' })
  const button = await waitFor(() => ui.find({ key: 'files:found:skills/SKILL.md' }))
  const texts = JSON.stringify(button)
  expect(texts).toContain('SKILL.md      ')
  expect(texts).toContain(' skills')
  expect(await ui.find({ key: 'files:found:CLAUDE.md' })).toBeDefined()
  await ui.unmount()
})

test('pressing a .md file in the Files tab draws it as Markdown, not Code', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.list', () => ({ value: [fsEntry('README.md', 'file', 12)] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 12, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: '# Hi\n**bold**\n' }))
  on('process.run', () => ok(''))

  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'tab:files' })
  await ui.press({ key: 'files:file:README.md' })
  expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: '# Hi\n**bold**\n' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.unmount()
})

test('pressing a file in the Files tab shows its text over the tabs, steps with Next, and Back returns', async ($, on) => {
  const texts: Record<string, string> = { '/proj/a.ts': 'const a = 1\r\n', '/proj/b.png': 'PNG\0\0' }
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.list', () => ({ value: [fsEntry('b.png', 'file', 6), fsEntry('a.ts', 'file', 12), fsEntry('big.log', 'file', 5_000_000)] }))
  on('fs.stat', (_$, e) => ({ value: { kind: 'file', size: posix(e.path) === '/proj/big.log' ? 5_000_000 : 12, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_$, e) => ({ value: texts[posix(e.path) ?? ''] ?? '' }))
  on('process.run', () => ok(''))

  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'tab:files' })
  await ui.press({ key: 'files:file:a.ts' })
  // 蓋掉分頁：沒有分頁圖示，換成 Back 和內容（CRLF 換成 LF、有行號）。
  expect(await ui.find({ key: 'tab:files' })).toBeUndefined()
  expect((await ui.find({ key: 'fileview:back' }))?.props).toMatchObject({ hotkey: 'b' })
  expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'const a = 1\n', path: 'a.ts', startLine: 1 })
  expect(await ui.find({ type: 'Text', text: '1 of 3 files' })).toBeDefined()

  await ui.press({ key: 'fileview:next' })
  expect(await ui.find({ type: 'Text', text: 'Binary file; nothing to show.' })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'fileview:next' })
  expect(await ui.find({ type: 'Text', text: 'Too large to show (4.8 MB).' })).toBeDefined()

  await ui.press({ key: 'fileview:back' })
  expect(await ui.find({ key: 'fileview:back' })).toBeUndefined()
  expect(await ui.find({ key: 'files:file:a.ts' })).toBeDefined()
  await ui.unmount()
})

test('the ⋯ of a Files row opens a menu: Show in Explorer selects it in Explorer, Delete asks once more and then deletes it', async ($, on) => {
  const entries = [fsEntry('src', 'dir'), fsEntry('a.ts', 'file', 12)]
  const runs: { argv: string[]; path?: string }[] = []
  let isFailing = false
  stubPanel(on, { root: '/proj' })
  on('env.get', (_$, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.list', (_$, e) => ({ value: posix(e.path) === '/proj' ? entries : [] }))
  on('process.run', (_$, e) => {
    // Show in Explorer 給反斜線路徑、Delete 給原本的 / 路徑，都經過 PowerShell。
    const path = e.init?.env?.SOAP_PATH
    if (path === undefined) return ok('')
    runs.push({ argv: [...e.argv], path })
    if (path.includes('\\')) return ok('')
    if (isFailing) return fail('Access denied', 1)
    entries.splice(entries.findIndex(x => `/proj/${x.name}` === e.init?.env?.SOAP_PATH), 1)

    return ok('')
  })
  on('ui.toast', () => ({ value: undefined }))

  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'tab:files' })
  expect(await ui.find({ key: 'files:reveal:src' })).toBeUndefined()

  // 按 ⋯ 展開那列的選單，按另一列的 ⋯ 換過去，再按一次收起來。
  await ui.press({ key: 'files:more:src' })
  // 選單是浮在 src 那列下面的卡片，不推動底下的列。
  expect((await ui.find({ key: 'files:menu' }))?.props).toMatchObject({ position: 'absolute', top: 1, right: 0 })
  expect(await ui.find({ key: 'files:reveal:src' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Show in Explorer' })).toBeDefined()
  await ui.press({ key: 'files:more:a.ts' })
  expect(await ui.find({ key: 'files:reveal:src' })).toBeUndefined()
  await ui.press({ key: 'files:more:a.ts' })
  expect(await ui.find({ key: 'files:reveal:a.ts' })).toBeUndefined()

  // Show in Explorer：PowerShell 用一般視窗開 explorer /select,（反斜線路徑），選單收起來。
  await ui.press({ key: 'files:more:src' })
  await ui.press({ key: 'files:reveal:src' })
  expect(runs.map(r => [r.argv[0], r.path])).toEqual([['powershell', '\\proj\\src']])
  expect(await ui.find({ key: 'files:reveal:src' })).toBeUndefined()

  // Delete 按一次只換成紅字；刪不掉寫原因，那列還在。
  runs.length = 0
  await ui.press({ key: 'files:more:a.ts' })
  await ui.press({ key: 'files:delete:a.ts' })
  expect(runs).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Press again to delete' })).toBeDefined()
  isFailing = true
  await ui.press({ key: 'files:delete:a.ts' })
  expect(await ui.find({ type: 'Text', text: /^Couldn't delete a\.ts: .*Access denied/ })).toBeDefined()

  // 再按兩次：刪掉，那列和選單都不見了。
  isFailing = false
  await ui.press({ key: 'files:delete:a.ts' })
  await ui.press({ key: 'files:delete:a.ts' })
  expect(runs.at(-1)?.argv[0]).toBe('powershell')
  expect(runs.at(-1)?.path).toBe('/proj/a.ts')
  expect(await ui.find({ key: 'files:file:a.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'files:delete:a.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'files:dir:src' })).toBeDefined()
  await ui.unmount()
})

test('in the Files tab Previous steps back through the files, and inside a folder Previous/Next stay on its files', async ($, on) => {
  const reads: string[] = []
  stubPanel(on, { root: '/proj' })
  on('fs.list', (_$, e) => ({
    value:
      posix(e.path) === '/proj/src'
        ? [fsEntry('lib', 'dir'), fsEntry('x.ts'), fsEntry('y.ts')]
        : [fsEntry('src', 'dir'), fsEntry('a.ts'), fsEntry('b.ts')],
  }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_$, e) => {
    reads.push(posix(e.path) ?? '')

    return { value: `// ${posix(e.path)}\n` }
  })
  on('process.run', () => ok(''))
  const path = async () => (await ui.find({ type: 'Code' }))?.props.path

  const ui = await mountPane($)
  await ui.press({ key: 'tab:files' })
  await ui.press({ key: 'files:file:b.ts' })
  expect(await ui.find({ type: 'Text', text: '2 of 2 files' })).toBeDefined()
  // Previous（n）：上一個檔案；到第一個了再按不動。
  expect((await ui.find({ key: 'fileview:prev' }))?.props.hotkey).toBe('n')
  await ui.press({ key: 'fileview:prev' })
  expect(await path()).toBe('a.ts')
  expect(await ui.find({ type: 'Text', text: '1 of 2 files' })).toBeDefined()
  const count = reads.length
  await ui.press({ key: 'fileview:prev' })
  expect(reads).toHaveLength(count)
  await ui.press({ key: 'fileview:back' })

  // 子資料夾裡：只在它自己的檔案之間走（資料夾不算，外層的檔案也不算）。
  await ui.press({ key: 'files:dir:src' })
  await ui.press({ key: 'files:file:x.ts' })
  expect(await ui.find({ type: 'Text', text: '1 of 2 files' })).toBeDefined()
  expect((await ui.find({ key: 'fileview:next' }))?.props.hotkey).toBe('m')
  await ui.press({ key: 'fileview:next' })
  expect(await path()).toBe('src/y.ts')
  expect(reads.at(-1)).toBe('/proj/src/y.ts')
  await ui.press({ key: 'fileview:next' })
  expect(await path()).toBe('src/y.ts')
  await ui.press({ key: 'fileview:prev' })
  expect(await path()).toBe('src/x.ts')
  await ui.unmount()
})

// ───── Services ─────

test('the Services tab lists the running services and stops one by killing its tree', async ($, on) => {
  const calls: string[][] = []
  const kills: string[] = []
  on('clock.now', () => ({ value: 1000 + 12 * 60_000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    if (e.init?.env?.SOAP_PID !== undefined) {
      kills.push(e.init.env.SOAP_PID)

      return ok('')
    }
    if (e.argv[0] === 'powershell') return ok(JSON.stringify(SCAN))

    return ok('')
  })

  const ui = await mountPane($)
  await openTool(ui, 'services')
  // Services 是 Tools 的子分頁：上層只剩 Files、Git、Tools、Docs，子分頁列是 Tools 的，沒有 Git 的。
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('tab:'))).toEqual(['tab:files', 'tab:git', 'tab:tools', 'tab:spec'])
  expect(await ui.find({ key: 'sub:db' })).toBeDefined()
  expect(await ui.find({ key: 'sub:http' })).toBeDefined()
  expect(await ui.find({ key: 'sub:diff' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Running' })).toBeDefined()
  // 一行：工具 · 專案名 · port。
  expect(await ui.find({ type: 'Text', text: 'npm' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'web' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ':5000 :5001' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pid/ })).toBeUndefined()
  expect(await ui.find({ key: 'svc:restart:21' })).toBeDefined()

  await ui.press({ key: 'svc:stop:21' })
  expect(kills).toEqual([])
  expect((await ui.find({ key: 'svc:stop:21' }))?.props.label).toBe('Confirm')
  await ui.press({ key: 'svc:stop:21' })
  // 不用 taskkill /T（PID 被重用時會砍到無關的程序），交給 PowerShell 照啟動時間找子孫。
  expect(kills).toEqual(['21'])
  expect(calls.some(c => c[0] === 'taskkill')).toBe(false)
  await ui.press({ key: 'tab:git' })
  expect(await ui.find({ key: 'sub:diff' })).toBeDefined()
  await ui.unmount()
})

test('restart kills the tree, then relaunches the same command in the same folder', async ($, on) => {
  const launches: Record<string, string>[] = []
  const kills: string[] = []
  on('clock.now', () => ({ value: 0 }))
  on('clock.sleep', () => ({ value: undefined }))
  runRestartChecks(on)
  on('session.root', () => ({ value: ROOT }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('process.run', (_$, e) => {
    if (e.init?.env?.SOAP_PID !== undefined) {
      kills.push(e.init.env.SOAP_PID)

      return ok('')
    }
    if (e.argv[0] === 'powershell' && e.init?.env?.SOAP_CMD !== undefined) {
      launches.push(e.init.env)

      return ok('4321\r\n')
    }
    // 重開的程序 4321 一直活著。
    if (e.argv[0] === 'powershell') return ok(JSON.stringify({ ...SCAN, pids: [...SCAN.pids, 4321] }))

    return ok('')
  })

  const ui = await mountPane($, 'desktop')
  await openTool(ui, 'services')
  await ui.press({ key: 'svc:restart:11' })
  expect(kills).toEqual(['11'])
  expect(launches).toHaveLength(1)
  expect(launches[0]?.SOAP_DIR).toBe('C:\\proj\\web')
  expect(launches[0]?.SOAP_CMD).toContain('npm-cli.js" run dev')
  expect(await ui.find({ type: 'Text', text: /Restart failed/ })).toBeUndefined()
  await ui.unmount()
})

test('a restart that dies right away says so, and the next scan does not wipe the message', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('clock.sleep', () => ({ value: undefined }))
  runRestartChecks(on)
  on('session.root', () => ({ value: ROOT }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'powershell' && e.init?.env?.SOAP_CMD !== undefined) return ok('4321\r\n')
    // 重開的程序 4321 不在活著的 PID 裡：一開就掛了。
    if (e.argv[0] === 'powershell') return ok(JSON.stringify(SCAN))

    return ok('')
  })

  const ui = await mountPane($, 'desktop')
  await openTool(ui, 'services')
  await ui.press({ key: 'svc:restart:11' })
  // 重跑後的檢查在計時器裡跑，等它寫進畫面。
  expect(await waitFor(() => ui.find({ type: 'Text', text: /Restart failed: npm · web exited right after starting/ }))).toBeDefined()
  // 定時掃描成功也不能把重跑失敗的提示洗掉。
  await ui.press({ key: 'tab:git' })
  await openTool(ui, 'services')
  expect(await ui.find({ type: 'Text', text: /Restart failed/ })).toBeDefined()
  // 按 × 才關掉。
  await ui.press({ key: 'svc:dismiss-error' })
  expect(await ui.find({ type: 'Text', text: /Restart failed/ })).toBeUndefined()
  await ui.unmount()
})

// 重跑後的檢查（RESTART_CHECK_MS）立刻跑；其他計時器（要按兩次的按鈕 DELETE_ARM_MS 後收回）交給測試時鐘，
// 不然 Stop 一變成 Confirm 就被收回去。
function runRestartChecks(on: TestOn) {
  on('clock.after', (_$, e, next) => (RESTART_CHECK_MS.includes(e.ms) ? { value: undefined } : next(e)) as never)
}

// Windows 上的 Services：PowerShell 掃描回 scan（重跑的 4321 一直活著）；記下砍的 PID 和重跑時給的環境變數。
function winServices(on: TestOn, scan: ScanResult, root = ROOT) {
  const kills: string[] = []
  const launches: Record<string, string>[] = []
  on('clock.now', () => ({ value: 0 }))
  on('clock.sleep', () => ({ value: undefined }))
  runRestartChecks(on)
  on('session.root', () => ({ value: root }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('process.run', (_$, e) => {
    if (e.init?.env?.SOAP_PID !== undefined) {
      kills.push(e.init.env.SOAP_PID)

      return ok('')
    }
    if (e.argv[0] === 'powershell' && e.init?.env?.SOAP_CMD !== undefined) {
      launches.push(e.init.env)

      return ok('4321\r\n')
    }
    if (e.argv[0] === 'powershell') return ok(JSON.stringify({ ...scan, pids: [...scan.pids, 4321] }))

    return ok('')
  })

  return { kills, launches }
}

// 每一列服務畫出來的字：● 工具 · 專案名 · port。
const serviceRows = async (ui: Pane) => (await ui.findAll({ type: 'Box' })).filter(b => /^svc:\d+$/.test(b.key ?? '')).map(b => b.text.replace(/^●|Restart.*$/g, ''))

test('the Services tab matches the session folder in any case, and restarts go -C from the folder it was run in', async ($, on) => {
  const { launches } = winServices(on, SCAN, 'C:\\Proj\\')

  const ui = await mountPane($)
  await openTool(ui, 'services')
  expect(await serviceRows(ui)).toEqual(['go · go-server · :8081', 'node · proj · :4000', 'dotnet · Api · :5000 :5001', 'cargo · app · :7000', 'npm · web · :5173'])
  await ui.press({ key: 'svc:restart:70' })
  expect(launches[0]?.SOAP_DIR).toBe('C:\\proj')
  await ui.unmount()
})

test('a service wrapped in cmd /c shows the real tool, and restart reruns the wrapper as is', async ($, on) => {
  const WRAPPER = 'cmd.exe /d /s /c "set ASPNETCORE_ENVIRONMENT=Development && dotnet run --project dotnet/InventoryApi"'
  const procs = [
    proc({ pid: 7, ppid: 1, name: 'Claude.exe' }),
    proc({ pid: 8, ppid: 7, name: 'cmd.exe', cmd: WRAPPER, cwd: 'C:\\proj\\' }),
    proc({ pid: 9, ppid: 8, name: 'dotnet.exe', cmd: '"C:\\Program Files\\dotnet\\dotnet.exe" run --project dotnet/InventoryApi', cwd: 'C:\\proj\\', started: 2000 }),
    proc({
      pid: 10,
      ppid: 9,
      name: 'InventoryApi.exe',
      exe: 'C:\\proj\\dotnet\\InventoryApi\\bin\\Debug\\net10.0\\InventoryApi.exe',
      cwd: 'C:\\proj\\dotnet\\InventoryApi\\',
      started: 3000,
    }),
  ]
  const { kills, launches } = winServices(on, { self: [], pids: procs.map(p => p.pid), procs, ports: [{ port: 5001, pid: 10 }] })

  const ui = await mountPane($)
  await openTool(ui, 'services')
  expect(await serviceRows(ui)).toEqual(['dotnet · InventoryApi · :5001'])
  // 砍最上層的 cmd（整棵）；重跑照原樣跑 cmd，set 環境變數那段才不會掉。
  await ui.press({ key: 'svc:restart:8' })
  expect(kills).toEqual(['8'])
  expect(launches[0]).toMatchObject({ SOAP_CMD: WRAPPER, SOAP_DIR: 'C:\\proj' })
  await ui.unmount()
})

const GO_TEMP = 'C:\\Temp\\go-build1\\b001\\exe\\inventory-service.exe'
// 一串程序（最上層在前，最後一個開著 port）：指令、工作目錄、執行檔 → Services 分頁上的名字。session 資料夾是 C:\company。
const NAMED: [chain: [cmd: string, cwd: string, exe?: string][], name: string][] = [
  [[['go run ./inventory-service', 'C:\\company\\test2'], [GO_TEMP, 'C:\\company\\test2', GO_TEMP]], 'inventory-service'],
  [[['go run .', 'C:\\company\\test2']], 'test2'],
  [[['cargo run --bin api', 'C:\\company\\ws'], ['', 'C:\\company\\ws', 'C:\\company\\ws\\target\\debug\\api.exe']], 'api'],
  [[['cargo run --manifest-path services/billing/Cargo.toml', 'C:\\company\\ws']], 'billing'],
  [
    [
      ['dotnet run --project src/Acme.Orders.Api', 'C:\\company\\test'],
      ['', 'C:\\company\\test\\src\\Acme.Orders.Api', 'C:\\company\\test\\src\\Acme.Orders.Api\\bin\\Debug\\net8.0\\Acme.Orders.Api.exe'],
    ],
    'Acme.Orders.Api',
  ],
  [[['"C:\\jdk\\bin\\java.exe" -cp C:\\company\\orders\\target\\classes;C:\\Users\\me\\.m2\\spring-core-6.1.0.jar com.acme.App', 'C:\\company']], 'orders'],
  [
    [
      [
        '"C:\\jdk\\bin\\java.exe" -classpath "C:\\maven\\boot\\plexus-classworlds-2.8.0.jar" -Dmaven.multiModuleProjectDirectory=C:\\company\\shop org.codehaus.plexus.classworlds.launcher.Launcher spring-boot:run',
        'C:\\company\\shop',
      ],
    ],
    'shop',
  ],
  [
    [
      ['C:\\WINDOWS\\system32\\cmd.exe /d /s /c "pnpm --filter web dev"', 'C:\\company\\mono'],
      ['node C:\\company\\mono\\apps\\web\\node_modules\\vite\\bin\\vite.js', 'C:\\company\\mono\\apps\\web'],
    ],
    'web',
  ],
  [[['node node/notify-svc/server.js', 'C:\\company\\test3']], 'notify-svc'],
  [[['app --config conf/dev/app.json --url http://localhost:3000/api', 'C:\\company\\svc']], 'svc'],
  [[['python -m uvicorn app.main:app', 'C:\\company\\py-api', 'C:\\company\\py-api\\.venv\\Scripts\\python.exe']], 'py-api'],
  [[['node server.js', 'C:\\company']], 'company'],
]

for (const [chain, name] of NAMED) {
  test(`the Services tab names ${chain[0]?.[0]} after ${name}`, async ($, on) => {
    const procs = chain.map(([cmd, cwd, exe], i) => proc({ pid: i + 1, ppid: i, name: 'x.exe', cmd, cwd, exe: exe ?? null }))
    winServices(on, { self: [], pids: procs.map(p => p.pid), procs, ports: [{ port: 8080, pid: procs.length }] }, 'C:\\company')

    const ui = await mountPane($)
    await openTool(ui, 'services')
    expect((await serviceRows(ui))[0]?.split(' · ')[1]).toBe(name)
    await ui.unmount()
  })
}

// macOS 上的 Services：ps、lsof 照 MAC_* 回；argsOut 是 ps -o pid=,args= 讀到的指令。記下 kill 和重跑。
function macServices(on: TestOn, argsOut = MAC_ARGS_OUT) {
  const kills: string[][] = []
  const launches: Record<string, string>[] = []
  on('clock.now', () => ({ value: 0 }))
  on('clock.sleep', () => ({ value: undefined }))
  runRestartChecks(on)
  on('session.root', () => ({ value: MAC_ROOT }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'kill') kills.push([...e.argv])
    if (e.argv[0] === 'ps') return ok(e.argv.includes('pid=,args=') ? argsOut : MAC_PPIDS_OUT)
    if (e.argv[0] === 'lsof') return ok(MAC_FILES_OUT)
    if (e.argv[0] === '/bin/sh' && e.init?.env?.SOAP_CMD !== undefined) {
      launches.push(e.init.env)

      return ok('4321\n')
    }
    if (e.argv[0] === '/bin/sh') return ok(MAC_SCAN_OUT)

    return ok('')
  })

  return { kills, launches }
}

test('on macOS the Services tab scans with ps and lsof, stops with kill -9 on the tree, and restarts with sh', async ($, on) => {
  const { kills, launches } = macServices(on)

  const ui = await mountPane($, 'desktop')
  await openTool(ui, 'services')
  expect(await ui.find({ type: 'Text', text: 'npm' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'web' })).toBeDefined()
  // npm → sh -c → node 是同一個服務；引擎自己（100）和它的 MCP server（30）不算。
  expect(await ui.find({ key: 'svc:stop:30' })).toBeUndefined()
  expect(await ui.find({ key: 'svc:stop:100' })).toBeUndefined()
  await ui.press({ key: 'svc:stop:11' })
  await ui.press({ key: 'svc:stop:11' })
  expect(kills).toEqual([['kill', '-9', '11', '12', '13', '99']])
  await ui.press({ key: 'svc:restart:11' })
  expect(launches).toEqual([{ SOAP_CMD: 'npm run dev', SOAP_DIR: `${MAC_ROOT}/web` }])
  await ui.unmount()
})

for (const cmd of ['npm run dev -- --host "$HOST"', 'node server.js --banner $(whoami)', 'sh -c vite; rm -rf x', 'ls *']) {
  test(`on macOS a service run as ${cmd} is not restarted, and the pane says why`, async ($, on) => {
    // ps 讀到的指令已經沒有原本的引號了，交給 sh 重跑會變成別的意思。
    const { kills, launches } = macServices(on, MAC_ARGS_OUT.replace('npm run dev', cmd))

    const ui = await mountPane($)
    await openTool(ui, 'services')
    await ui.press({ key: 'svc:restart:11' })
    expect(kills).toEqual([])
    expect(launches).toEqual([])
    expect(await ui.find({ type: 'Text', text: /^Restart failed: Cannot rerun .*: its command has quotes or shell characters/ })).toBeDefined()
    expect(await ui.find({ key: 'svc:restart:11' })).toBeDefined()
    await ui.unmount()
  })
}

test('on macOS a service whose command has only letters, paths and flags restarts as it was run', async ($, on) => {
  const cmd = 'node /Users/me/專案/web/server.js --port=5173'
  const { launches } = macServices(on, MAC_ARGS_OUT.replace('npm run dev', cmd))

  const ui = await mountPane($)
  await openTool(ui, 'services')
  await ui.press({ key: 'svc:restart:11' })
  expect(launches).toEqual([{ SOAP_CMD: cmd, SOAP_DIR: `${MAC_ROOT}/web` }])
  await ui.unmount()
})

test('services group under the repo they run in, in repo order, with the ones outside any repo under Other last', async ($, on) => {
  // fs 的 C:\ 路徑在這台電腦上會被接在別的資料夾後面，比對前只留 C: 之後、換成 /。
  const win = (p: string | undefined) => p?.replace(/^.*C:/, 'C:').replace(/\\/g, '/')
  stubPanel(on, { root: ROOT })
  on('env.get', (_$, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  // C:\proj 本身不是 repo，底下的 web、api 是；rs、go-server 和 proj 本身跑的服務不在任何 repo 裡。
  on('fs.list', (_$, e) => ({ value: win(e.path) === 'C:/proj' ? ['web', 'api', 'rs', 'go-server'].map(n => fsEntry(n, 'dir')) : [] }))
  on('fs.exists', (_$, e) => ({ value: ['C:/proj/web/.git', 'C:/proj/api/.git'].includes(win(e.path) ?? '') }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'powershell') return ok(JSON.stringify(SCAN))
    const cwd = win(e.init?.cwd) ?? ''
    if (e.argv[3] !== 'rev-parse') return ok('')

    return cwd === 'C:/proj' ? fail('fatal: not a git repository (or any of the parent directories): .git') : ok(`${cwd}\n${cwd}/.git\n`)
  })
  await openPanel($)

  const ui = await mountPane($)
  await openTool(ui, 'services')
  // 每一組：標題，和它底下的服務（PID）。
  const groups = (await ui.findAll({ type: 'Box' }))
    .filter(b => b.key?.startsWith('svc-group:'))
    .map(b => [b.text.split('●')[0], ...b.children.flatMap(c => {
      // 字串子節點沒有 props。
      const key = (c as { props?: { key?: string } }).props?.key

      return key?.startsWith('svc:') ? [key] : []
    })])
  expect(groups).toEqual([
    ['api', 'svc:21'],
    ['web', 'svc:11'],
    ['Other', 'svc:70', 'svc:50', 'svc:15'],
  ])
  await ui.unmount()
})

// ───── 解衝突 ─────

// git 留著的三個版本：1 共同祖先、2 ours、3 theirs（git show :n:path）。
const STAGES: Record<string, string> = {
  ':1:src/a.ts': 'import a\nconst x = 0\nend\n',
  ':2:src/a.ts': 'import a\nconst x = 1\nend\n',
  ':3:src/a.ts': 'import a\nconst x = 2\nend\n',
}

type ConflictRepo = {
  // git status 印出的衝突檔案。
  status?: string
  // .git 裡的檔案（看得出停在 merge 還是 rebase）。
  gitDir?: string[]
  // 工作區檔案的內容。
  text?: string
  stages?: Record<string, string>
  // 先看的 git 指令（args 從子指令開始），給了結果就用它的。
  run?: (args: string[]) => ReturnType<typeof ok> | undefined
}

// 停在 merge、src/a.ts 有一段衝突的 repo；git add／rm 之後那個檔案就不是衝突了。
function conflictRepo(
  on: TestOn,
  { status = '## main\0UU src/a.ts\0', gitDir = ['MERGE_HEAD'], text = CONFLICTED, stages = STAGES, run }: ConflictRepo = {},
) {
  const calls: { args: string[]; cwd?: string; env?: Record<string, string> }[] = []
  const writes: { path: string; text: string }[] = []
  const prompts: string[] = []
  // 解掉的檔案 → 它在 status 的新樣子（加進暫存區、或刪掉了）。
  const resolved = new Map<string, string>()
  stubPanel(on)
  on('ui.toast', () => ({ value: undefined }))
  on('fs.list', () => ({ value: gitDir.map(name => fsEntry(name)) }))
  on('fs.read', () => ({ value: text }))
  on('fs.write', (_$, e) => {
    writes.push({ path: posix(e.path) ?? '', text: e.text })

    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('process.run', (_$, e) => {
    const args = e.argv.slice(3)
    calls.push({ args, cwd: posix(e.init?.cwd), env: e.init?.env })
    const own = run?.(args)
    if (own !== undefined) return own
    if (args[0] === 'status') return ok(status.split('\0').map(line => resolved.get(line.slice(3)) ?? line).join('\0'))
    if (args[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (args[0] === 'show') {
      const blob = stages[args[1] ?? '']

      return blob === undefined ? fail('') : ok(blob)
    }
    const path = args.at(-1) ?? ''
    if (args[0] === 'add') resolved.set(path, `M  ${path}`)
    if (args[0] === 'rm') resolved.set(path, `D  ${path}`)

    return ok('')
  })

  return { calls, writes, prompts }
}

// 跑過的 git 指令（從子指令開始，空白隔開）。
const gitCommands = (calls: { args: string[] }[]) => calls.map(c => c.args.join(' '))

test('the conflict tab lists conflicted files, and the merge view resolves one, git adds it, then continues', async ($, on) => {
  const { calls, writes } = conflictRepo(on)
  await openPanel($)

  const ui = await mountPane($)
  // session 資料夾本身就是 repo：那排 repo 只有它一個，一樣標有沒有變更和衝突。
  expect((await ui.find({ key: 'repo:repo' }))?.props).toMatchObject({ label: 'repo* !', variant: 'primary' })
  await ui.press({ key: 'sub:conflict' })
  expect(await ui.find({ type: 'Text', text: 'Merge in progress' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Conflicts · 1' })).toBeDefined()
  // 還有衝突時不能 continue。
  expect(await ui.find({ key: 'op:continue' })).toBeUndefined()
  await ui.press({ key: 'conflict:src/a.ts' })
  // 三欄畫在 Soap Panel 裡，蓋掉分頁；還有衝突時沒有 Apply。
  expect(await ui.find({ key: 'sub:conflict' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '0 of 1 conflicts resolved' })).toBeDefined()
  expect(await ui.find({ key: 'merge:apply' })).toBeUndefined()

  await ui.press({ key: 'merge:ours:1' })
  expect(await ui.find({ type: 'Text', text: '1 of 1 conflicts resolved' })).toBeDefined()
  // 選好之後中間只剩 Reset，Apply 出現。
  expect(await ui.find({ key: 'merge:both:1' })).toBeUndefined()
  expect(await ui.find({ key: 'merge:apply' })).toBeDefined()
  await ui.press({ key: 'merge:reset:1' })
  expect(await ui.find({ type: 'Text', text: '0 of 1 conflicts resolved' })).toBeDefined()
  await ui.press({ key: 'merge:both:1' })
  await ui.press({ key: 'merge:apply' })

  // 寫回 repo 根目錄底下的檔案，在根目錄 git add。
  expect(writes).toEqual([{ path: '/repo/src/a.ts', text: 'import a\nconst x = 1\nconst x = 2\nend\n' }])
  expect(calls.some(c => c.args.join(' ') === 'add -- src/a.ts' && c.cwd === '/repo')).toBe(true)

  // 衝突都解完了：可以 continue，merge 是直接用預設訊息 commit、不開編輯器。
  expect(await ui.find({ type: 'Text', text: 'All conflicts resolved.' })).toBeDefined()
  await ui.press({ key: 'op:continue' })
  const commit = calls.find(c => c.args.join(' ') === 'commit --no-edit')
  expect(commit?.env).toMatchObject({ GIT_EDITOR: 'true' })
  await ui.unmount()
})

test('abort asks once more before running, and Cancel keeps the merge going', async ($, on) => {
  const { calls } = conflictRepo(on)
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'op:abort' })
  expect(calls.some(c => c.args[1] === '--abort')).toBe(false)
  expect(await ui.find({ key: 'op:abort-cancel' })).toBeDefined()
  await ui.press({ key: 'op:abort-cancel' })
  expect(await ui.find({ key: 'op:abort-cancel' })).toBeUndefined()
  expect(calls.some(c => c.args[1] === '--abort')).toBe(false)

  await ui.press({ key: 'op:abort' })
  await ui.press({ key: 'op:abort' })
  expect(calls.some(c => c.args.join(' ') === 'merge --abort' && c.cwd === '/repo')).toBe(true)
  await ui.unmount()
})

test('Ask Claude in the merge view sends the file to the model, and Back returns to the conflict tab', async ($, on) => {
  const { prompts } = conflictRepo(on)
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'conflict:src/a.ts' })
  await ui.press({ key: 'merge:claude' })
  expect(prompts.length).toBe(1)
  // 給 Claude 的是完整路徑：session 資料夾不是 repo 時，相對路徑會找不到檔案。
  expect(prompts[0]).toContain('`/repo/src/a.ts`')
  await ui.press({ key: 'merge:back' })
  expect(await ui.find({ key: 'op:abort' })).toBeDefined()
  await ui.unmount()
})

test('Ask Claude does not send a file whose name could smuggle text into the prompt', async ($, on) => {
  const { prompts } = conflictRepo(on, { status: '## main\0UU a`b.ts\0' })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'conflict:a`b.ts' })
  await ui.press({ key: 'merge:claude' })
  expect(prompts).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Ask Claude is off for this file/ })).toBeDefined()
  await ui.unmount()
})

test('Next past the last conflict of a file opens the next conflicted file, and stops at the last one', async ($, on) => {
  conflictRepo(on, { status: '## main\0UU src/a.ts\0UU src/b.ts\0' })
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  await openPanel($)

  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'conflict:src/a.ts' })
  // 第一下跳到這個檔案唯一的一段衝突，再按一下換到 src/b.ts。
  await ui.press({ key: 'merge:next' })
  expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
  await ui.press({ key: 'merge:next' })
  expect(await ui.find({ type: 'Text', text: 'src/b.ts' })).toBeDefined()
  // 最後一個檔案的最後一段再按：不動，不繞回第一個。往前換回上一個檔案，第一個檔案再往前也不動。
  await ui.press({ key: 'merge:next' })
  expect(await ui.find({ type: 'Text', text: 'src/b.ts' })).toBeDefined()
  await ui.press({ key: 'merge:prev' })
  expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
  await ui.press({ key: 'merge:prev' })
  expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
  await ui.unmount()
})

test('pressing a conflicted file in the diff tab opens the three-column merge view', async ($, on) => {
  conflictRepo(on)
  await openPanel($)

  const ui = await mountPane($)
  // 衝突的檔案標 !，點了不是看差異，是開三欄合併；Back 回 diff 分頁。
  await ui.press({ key: 'file:unstaged:src/a.ts' })
  expect(await ui.find({ type: 'Text', text: '0 of 1 conflicts resolved' })).toBeDefined()
  expect(await ui.find({ key: 'merge:ours:1' })).toBeDefined()
  await ui.press({ key: 'merge:back' })
  expect(await ui.find({ key: 'file:unstaged:src/a.ts' })).toBeDefined()
  await ui.unmount()
})

test('during a rebase the merge view says ours and theirs are swapped, and Continue runs rebase --continue without an editor', async ($, on) => {
  const { calls } = conflictRepo(on, { gitDir: ['rebase-merge'] })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:conflict' })
  expect(await ui.find({ type: 'Text', text: 'Rebase in progress' })).toBeDefined()
  await ui.press({ key: 'conflict:src/a.ts' })
  expect(await ui.find({ type: 'Text', text: /^Rebasing: ours is the branch you are rebasing onto, theirs is your commit/ })).toBeDefined()
  await ui.press({ key: 'merge:theirs:1' })
  await ui.press({ key: 'merge:apply' })

  expect(await ui.find({ type: 'Text', text: 'All conflicts resolved.' })).toBeDefined()
  await ui.press({ key: 'op:continue' })
  const cont = calls.find(c => c.args.join(' ') === 'rebase --continue')
  expect(cont?.env).toMatchObject({ GIT_EDITOR: 'true' })
  await ui.unmount()
})

test('a conflicted file with no markers is resolved whole: ours checks it out, theirs-deleted removes it, as-is adds it', async ($, on) => {
  // 三個衝突檔案都沒有衝突標記（像二進位檔）；b.ts 被 theirs 刪掉了，git 只留 1、2 兩個版本。
  const stagesOf = (path: string) => (path === 'src/b.ts' ? [1, 2] : [1, 2, 3])
  const { calls } = conflictRepo(on, {
    status: '## main\0UU src/a.ts\0UD src/b.ts\0UU src/c.ts\0',
    text: 'PNG\n',
    run: args => {
      if (args[0] !== 'ls-files') return undefined
      const path = args.at(-1) ?? ''

      return ok(stagesOf(path).map(n => `100644 ${String(n).repeat(40)} ${n}\t${path}\0`).join(''))
    },
  })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'conflict:src/a.ts' })
  expect(await ui.find({ type: 'Text', text: /no conflict markers to pick from/ })).toBeDefined()
  expect(await ui.find({ key: 'merge:apply' })).toBeUndefined()
  // Use ours：整個檔案換成 ours 的，再 git add；解掉就回到 conflict 分頁。
  await ui.press({ key: 'merge:take-ours' })
  expect(await ui.find({ type: 'Text', text: 'Conflicts · 2' })).toBeDefined()
  expect(await ui.find({ key: 'conflict:src/a.ts' })).toBeUndefined()

  // Use theirs，但 theirs 把它刪了：git rm。
  await ui.press({ key: 'conflict:src/b.ts' })
  await ui.press({ key: 'merge:take-theirs' })
  // Mark resolved as is：照工作區現在的樣子 git add。
  await ui.press({ key: 'conflict:src/c.ts' })
  await ui.press({ key: 'merge:take-as-is' })

  expect(gitCommands(calls).filter(c => /^(checkout|add|rm) /.test(c))).toEqual([
    'checkout --ours -- src/a.ts',
    'add -- src/a.ts',
    'rm -q -- src/b.ts',
    'add -A -- src/c.ts',
  ])
  expect(await ui.find({ type: 'Text', text: 'All conflicts resolved.' })).toBeDefined()
  await ui.unmount()
})

// x 兩邊都改了（衝突），y 只有 theirs 改（git 自己合進來）。
const AUTO_STAGES: Record<string, string> = {
  ':1:src/a.ts': 'import a\nconst x = 0\nkeep\nconst y = 0\nend\n',
  ':2:src/a.ts': 'import a\nconst x = 1\nkeep\nconst y = 0\nend\n',
  ':3:src/a.ts': 'import a\nconst x = 2\nkeep\nconst y = 9\nend\n',
}

test('in the merge view a side, all ours or all theirs fills the middle, and an auto-merged change can be undone and applied again', async ($, on) => {
  const { writes } = conflictRepo(on, { stages: AUTO_STAGES })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'conflict:src/a.ts' })
  // 畫出這段程式碼的格子有幾個：左右兩欄各一格，選進中間就多一格。
  const shown = async (source: string) => (await ui.findAll({ type: 'Code' })).filter(c => c.props.source === source).length

  // theirs 的「≪ Accept」：中間放 theirs 的。
  expect(await shown('const x = 2')).toBe(1)
  await ui.press({ key: 'merge:theirs:1' })
  expect(await ui.find({ type: 'Text', text: '1 of 1 conflicts resolved' })).toBeDefined()
  expect(await shown('const x = 2')).toBe(2)
  // All ours／All theirs：每段衝突都換成那一邊。
  await ui.press({ key: 'merge:all-ours' })
  expect(await shown('const x = 1')).toBe(2)
  expect(await shown('const x = 2')).toBe(1)
  await ui.press({ key: 'merge:all-theirs' })
  expect(await shown('const x = 2')).toBe(2)

  // 自動合進來的 y：中間是 theirs 的；Undo 換回原本的樣子，Apply 再放回來。
  expect(await ui.find({ type: 'Text', text: 'Auto-merged from theirs' })).toBeDefined()
  expect(await shown('const y = 9')).toBe(2)
  await ui.press({ key: 'merge:toggle:3' })
  expect(await ui.find({ type: 'Text', text: 'Auto-merged from theirs · undone' })).toBeDefined()
  expect((await ui.find({ key: 'merge:toggle:3' }))?.props.label).toBe('Apply')
  expect(await shown('const y = 0')).toBe(2)
  await ui.press({ key: 'merge:toggle:3' })
  expect(await shown('const y = 9')).toBe(2)

  // 再 Undo 一次就套用：寫回去的是 theirs 的 x、原本的 y。
  await ui.press({ key: 'merge:toggle:3' })
  await ui.press({ key: 'merge:apply' })
  expect(writes).toEqual([{ path: '/repo/src/a.ts', text: 'import a\nconst x = 2\nkeep\nconst y = 0\nend\n' }])
  await ui.unmount()
})

test('a diff3 conflict shows its base, and Apply writes the file back with its CRLF and no final newline', async ($, on) => {
  const text = ['<<<<<<< HEAD', 'a', '||||||| base', 'o', '=======', 'b', '>>>>>>> dev'].join('\r\n')
  const { writes } = conflictRepo(on, { text, stages: {} })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'conflict:src/a.ts' })
  expect(await ui.find({ type: 'Text', text: 'Base (before either side changed it):' })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: 'o' })).toBeDefined()
  await ui.press({ key: 'merge:both-rev:0' })
  await ui.press({ key: 'merge:apply' })
  expect(writes).toEqual([{ path: '/repo/src/a.ts', text: 'b\r\na' }])
  await ui.unmount()
})

// git 留著的三個版本（base 給 null：兩邊都新增了這個檔案，沒有共同祖先）。
const stagesOf = (base: string | null, ours: string, theirs: string) => ({
  ...(base === null ? {} : { ':1:src/a.ts': base }),
  ':2:src/a.ts': ours,
  ':3:src/a.ts': theirs,
})

const MERGES = [
  {
    name: 'the same change on both sides is no conflict',
    stages: stagesOf('a\nb\n', 'a\nX\n', 'a\nX\n'),
    shows: 'Same change on both sides',
    presses: [],
    written: 'a\nX\n',
  },
  {
    name: 'edits on adjacent lines are one conflict, as git sees them',
    stages: stagesOf('a\nc\nd\nz\n', 'a\nC\nd\nz\n', 'a\nc\nD\nz\n'),
    shows: '0 of 1 conflicts resolved',
    presses: ['merge:ours:1'],
    written: 'a\nC\nd\nz\n',
  },
  {
    name: 'with no base every difference is a conflict and the lines both sides share stay',
    stages: stagesOf(null, 'a\nb\nc\n', 'a\nx\nc\n'),
    shows: 'Pick a side, or both.',
    presses: ['merge:theirs:1'],
    written: 'a\nx\nc\n',
  },
]

for (const { name, stages, shows, presses, written } of MERGES) {
  test(`in the merge view ${name}`, async ($, on) => {
    const { writes } = conflictRepo(on, { stages })
    await openPanel($)

    const ui = await mountPane($)
    await ui.press({ key: 'sub:conflict' })
    await ui.press({ key: 'conflict:src/a.ts' })
    expect(await ui.find({ type: 'Text', text: shows })).toBeDefined()
    for (const key of presses) await ui.press({ key })
    await ui.press({ key: 'merge:apply' })
    expect(writes).toEqual([{ path: '/repo/src/a.ts', text: written }])
    await ui.unmount()
  })
}

// ───── 回合結束 ─────

const diffOf = (line: string) => `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+${line}\n`

test('at turn end the repo bar and an open diff reread, and the diff closes once its file has no changes', async ($, on) => {
  let status = '## main\0 M a.ts\0'
  let diff = diffOf('b')
  stubPanel(on)
  gitRepo(on, { status: () => status, run: cmd => (cmd[0] === 'diff' ? ok(diff) : undefined) })
  await openPanel($)
  const label = async () => (await ui.find({ key: 'repo:repo' }))?.props.label
  // 差異一行一列畫：整塊的字是「行號 標記 內容」接起來。
  const source = async () => (await ui.find({ key: 'diff' }))?.text

  const ui = await mountPane($)
  expect(await label()).toBe('repo*')
  // 這個回合 Claude 弄出了一個衝突：repo 名稱後面多一個 !。
  status = '## main\0 M a.ts\0UU c.ts\0'
  await endTurn($, ui)
  expect(await label()).toBe('repo* !')

  // 開著的差異：Claude 又改了 a.ts，換成新的差異。
  await ui.press({ key: 'file:unstaged:a.ts' })
  expect(await source()).toContain('+ b')
  diff = diffOf('c')
  await endTurn($, ui)
  expect(await source()).toContain('+ c')

  // Claude 把變更都 commit 了：差異關掉、回到分頁，repo 名稱後面的記號也拿掉。
  status = '## main\0'
  await endTurn($, ui)
  expect(await ui.find({ key: 'diff' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'No uncommitted changes.' })).toBeDefined()
  expect(await label()).toBe('repo')
  await ui.unmount()
})

test('at turn end an open merge view rereads the file and keeps the conflicts already chosen', async ($, on) => {
  const { calls } = conflictRepo(on)
  await openPanel($)
  const stageReads = () => gitCommands(calls).filter(c => c.startsWith('ls-files')).length

  const ui = await mountPane($)
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'conflict:src/a.ts' })
  await ui.press({ key: 'merge:ours:1' })
  const reads = stageReads()
  // 回合結束重讀了這個檔案（git 留著的版本），已經選好的那段還是選好的。
  await endTurn($, ui)
  expect(stageReads()).toBe(reads + 1)
  expect(await ui.find({ type: 'Text', text: '1 of 1 conflicts resolved' })).toBeDefined()
  expect(await ui.find({ key: 'merge:apply' })).toBeDefined()
  await ui.unmount()
})

test('at turn end the Files tab relists its folder, and an open file shows its new text once it changed', async ($, on) => {
  let names = ['a.ts']
  let stat = { mtimeMs: 1, size: 3 }
  let text = 'v1\n'
  stubPanel(on, { root: '/proj' })
  on('fs.list', () => ({ value: names.map(n => fsEntry(n)) }))
  on('fs.stat', () => ({ value: { kind: 'file', isLink: false, ...stat } }))
  on('fs.read', () => ({ value: text }))
  on('process.run', () => ok(''))
  const source = async () => (await ui.find({ type: 'Code' }))?.props.source

  const ui = await mountPane($)
  await ui.press({ key: 'tab:files' })
  // Claude 加了 b.ts：重列。
  names = ['a.ts', 'b.ts']
  await endTurn($, ui)
  expect(await ui.find({ key: 'files:file:b.ts' })).toBeDefined()

  await ui.press({ key: 'files:file:a.ts' })
  expect(await source()).toBe('v1\n')
  // 修改時間和大小都沒變，當作沒改，不重讀。
  text = 'v2\n'
  await endTurn($, ui)
  expect(await source()).toBe('v1\n')
  // 改了：換成新的內容。
  stat = { mtimeMs: 2, size: 3 }
  await endTurn($, ui)
  expect(await source()).toBe('v2\n')
  await ui.unmount()
})

// ───── 焦點 ─────

test('with no screen attached at start, Soap Panel waits for session.attach to open', async ($, on) => {
  mock.clock(on)
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  gitRepo(on, { status: '## main\0' })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  expect(opened).toEqual([])

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(opened).toEqual(['soap-panel'])

  // 再接上一個不重開（人可能已經關掉了）。
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:2' })
  expect(opened).toEqual(['soap-panel'])
})

test('Soap Panel brought to the front, or just pressed, gets the keyboard back', async ($, on) => {
  const clock = mock.clock(on)
  const pane = (isShown: boolean, isFocused: boolean) => [{ id: 'soap-panel', title: 'Soap Panel', isShown, isFocused, isPlaced: true }]
  let panes = pane(true, false)
  const focused: string[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_$, e) => {
    if (e.focus === true) focused.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.scroll', () => ({}))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  gitRepo(on, { status: '## main\0' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  // 剛啟動時 Soap Panel 在前面但沒焦點：不搶（人可能正在輸入框打字）。
  await clock.advance(200)
  expect(focused).toEqual([])

  // 切到別的分頁再切回來、沒拿到焦點：補給它。
  panes = pane(false, false)
  await clock.advance(200)
  panes = pane(true, false)
  await clock.advance(200)
  expect(focused).toEqual(['soap-panel'])
  focused.length = 0

  // 按完按鈕丟了焦點：剛按完的一小段時間內補回來。
  panes = pane(true, true)
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'sub:diff' })
  panes = pane(true, false)
  await clock.advance(200)
  expect(focused).toEqual(['soap-panel'])
  focused.length = 0

  // 過了那段時間才丟焦點（人自己點去輸入框）：不搶回來。
  panes = pane(true, true)
  await clock.advance(1000)
  panes = pane(true, false)
  await clock.advance(200)
  expect(focused).toEqual([])
  await ui.unmount()
})
