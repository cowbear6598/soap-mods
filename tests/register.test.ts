import { expect, mock, test } from 'claude-code/testing'

import { DANGER, GOOD, WARN } from '../hooks/config'
import {
  CONFLICTED,
  MAC_ARGS_OUT,
  MAC_FILES_OUT,
  MAC_PPIDS_OUT,
  MAC_ROOT,
  MAC_SCAN_OUT,
  ROOT,
  SCAN,
  type TestOn,
  branchLine,
  endTurn,
  fail,
  fsEntry,
  gitRepo,
  mountPane,
  ok,
  openPanel,
  posix,
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

  // 終端機和桌面版都畫得出面板。
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

test('on the terminal the usage bar is a row of █░ in the color of what is left', async ($, on) => {
  const state = usage(on)
  state.used = [40, 85]

  const ui = await mountPane($)
  const bars = await ui.findAll({ type: 'Text', text: /^[█░]+$/ })
  expect(bars.map(t => t.props.color)).toEqual(['success', 'error'])
  await ui.unmount()
})

// ───── diff、branch ─────

test('pressing a changed file shows its diff over the tabs, Next/Previous step through the files, and Back returns', async ($, on) => {
  const diffArgs: string[][] = []
  stubPanel(on)
  gitRepo(on, {
    status: '## main...origin/main [ahead 1]\0 M a.ts\0?? b.ts\0',
    run: cmd => {
      if (cmd[0] !== 'diff') return undefined
      diffArgs.push(cmd)

      return ok('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n')
    },
  })
  await openPanel($)

  const ui = await mountPane($)
  expect(await ui.find({ key: 'file:unstaged:a.ts' })).toBeDefined()
  // 沒點之前不顯示差異；點了在 Soap Panel 裡蓋掉分頁看，Back 回來。
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'file:unstaged:a.ts' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect(await ui.find({ key: 'tab:git' })).toBeUndefined()
  // Previous／Next 照 diff 分頁的順序走：a.ts → b.ts（未追蹤的對空檔案），到頭了不動。
  expect(await ui.find({ type: 'Text', text: '1 of 2 files' })).toBeDefined()
  await ui.press({ key: 'diff:next' })
  expect(await ui.find({ type: 'Text', text: '2 of 2 files' })).toBeDefined()
  expect(diffArgs.at(-1)).toContain('--no-index')
  const reads = diffArgs.length
  await ui.press({ key: 'diff:next' })
  expect(diffArgs).toHaveLength(reads)
  await ui.press({ key: 'diff:prev' })
  expect(await ui.find({ type: 'Text', text: '1 of 2 files' })).toBeDefined()
  await ui.press({ key: 'diff:back' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ key: 'file:unstaged:a.ts' })).toBeDefined()
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
  await ui.press({ key: 'switch:l:dev' })
  expect(switches).toEqual(['switch dev'])
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
  const toasts: string[] = []
  stubPanel(on)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  gitRepo(on, {
    status: '## main\0',
    branches: () => [branchLine('main', { isCurrent: true }), ...(deletes.includes('branch -D dev') ? [] : [branchLine('dev')])],
    run: cmd => {
      if (cmd[0] !== 'branch') return undefined
      deletes.push(cmd.join(' '))

      return cmd[1] === '-d' ? fail("error: the branch 'dev' is not fully merged", 1) : ok('')
    },
  })
  await openPanel($)

  const ui = await mountPane($)
  await ui.press({ key: 'sub:branch' })
  // 目前分支沒有刪除鈕。
  expect(await ui.find({ key: 'delete:l:main' })).toBeUndefined()

  // 按一下只換成打勾，再按才刪；-d 被拒（沒合併）就換成強制刪除的打勾，再按才 -D。
  await ui.press({ key: 'delete:l:dev' })
  expect(deletes).toEqual([])
  await ui.press({ key: 'delete:l:dev' })
  expect(deletes).toEqual(['branch -d dev'])
  expect(await ui.find({ type: 'Text', text: 'dev has unmerged commits; press again to force delete and lose them.' })).toBeDefined()
  await ui.press({ key: 'delete:l:dev' })
  expect(deletes).toEqual(['branch -d dev', 'branch -D dev'])
  expect(toasts).toEqual(['Deleted dev'])
  expect(await ui.find({ key: 'switch:l:dev' })).toBeUndefined()
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

test('long file and branch lists draw the first 50, with Show more for files and search for branches', async ($, on) => {
  const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`)
  stubPanel(on)
  gitRepo(on, {
    status: `## main\0${names('f', 70).map(f => `?? ${f}.ts\0`).join('')}`,
    branches: [branchLine('main', { isCurrent: true }), ...names('origin/b', 60).map(b => branchLine(b))],
  })
  await openPanel($)

  const ui = await mountPane($)
  expect(await ui.find({ key: 'file:untracked:f49.ts' })).toBeDefined()
  expect(await ui.find({ key: 'file:untracked:f50.ts' })).toBeUndefined()
  await ui.press({ key: 'file:more:untracked' })
  expect(await ui.find({ key: 'file:untracked:f69.ts' })).toBeDefined()
  expect(await ui.find({ key: 'file:more:untracked' })).toBeUndefined()

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
    branches: [branchLine('soap/feature/login', { isCurrent: true }), branchLine('feature/a'), branchLine('feature/b'), branchLine('main')],
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
        // 照 --max-count 給；沒給就是整條（搜尋）。
        const max = cmd.find(a => a.startsWith('--max-count='))?.split('=')[1]
        const count = Math.min(max === undefined ? Infinity : Number(max), 40)
        const lines = Array.from({ length: count }, (_, i) => `${sha(i)}\t${short(i)}\t${sha(i + 1)}\tCptSoap\t${time}\tCommit ${i}`)

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

test('the log tab lists the latest 30 commits of the branch, marks the unpushed ones, and loads more', async ($, on) => {
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

  await ui.press({ key: 'log:more' })
  expect(await ui.find({ type: 'Text', text: 'main · 40' })).toBeDefined()
  expect(await ui.find({ key: 'log:more' })).toBeUndefined()
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
  expect(await ui.find({ type: 'Code' })).toBeDefined()
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
  await ui.press({ key: 'log:more' })
  expect(await ui.find({ type: 'Text', text: 'main · 40' })).toBeDefined()
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
  const listed: (string | undefined)[] = []
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.list', (_$, e) => {
    const path = posix(e.path)
    listed.push(path)
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
  expect(await ui.find({ type: 'Text', text: '4.2 KB' })).toBeDefined()
  // session 資料夾本身：沒有路徑、沒有 Back。
  expect(await ui.find({ key: 'files:back' })).toBeUndefined()

  await ui.press({ key: 'files:dir:src' })
  expect(listed.at(-1)).toBe('/proj/src')
  expect(await ui.find({ type: 'Text', text: 'src/' })).toBeDefined()
  expect((await ui.find({ key: 'files:back' }))?.props).toMatchObject({ label: '← Back', hotkey: 'b' })
  expect(await ui.find({ key: 'files:file:main.ts' })).toBeDefined()

  await ui.press({ key: 'files:back' })
  expect(listed.at(-1)).toBe('/proj')
  expect(await ui.find({ key: 'files:dir:src' })).toBeDefined()
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
  await ui.press({ key: 'tab:services' })
  // Services 沒有子分頁。
  expect(await ui.find({ key: 'sub:diff' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Running' })).toBeDefined()
  // 一行：工具 · 專案名 · port；不再顯示資料夾、跑了多久、PID。
  expect(await ui.find({ type: 'Text', text: 'npm' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'web' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ':5000 :5001' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pid/ })).toBeUndefined()
  expect(await ui.find({ key: 'svc:restart:21' })).toBeDefined()

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
  on('clock.after', () => ({ value: undefined }))
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
  await ui.press({ key: 'tab:services' })
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
  on('clock.after', () => ({ value: undefined }))
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
  await ui.press({ key: 'tab:services' })
  await ui.press({ key: 'svc:restart:11' })
  // 重跑後的檢查在計時器裡跑，等它寫進畫面。
  expect(await waitFor(() => ui.find({ type: 'Text', text: /Restart failed: npm · web exited right after starting/ }))).toBeDefined()
  // 定時掃描成功也不能把重跑失敗的提示洗掉。
  await ui.press({ key: 'tab:git' })
  await ui.press({ key: 'tab:services' })
  expect(await ui.find({ type: 'Text', text: /Restart failed/ })).toBeDefined()
  await ui.unmount()
})

// macOS 上的 Services：ps、lsof 照 MAC_* 回；argsOut 是 ps -o pid=,args= 讀到的指令。記下 kill 和重跑。
function macServices(on: TestOn, argsOut = MAC_ARGS_OUT) {
  const kills: string[][] = []
  const launches: Record<string, string>[] = []
  on('clock.now', () => ({ value: 0 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
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
  await ui.press({ key: 'tab:services' })
  expect(await ui.find({ type: 'Text', text: 'npm' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'web' })).toBeDefined()
  await ui.press({ key: 'svc:stop:11' })
  expect(kills).toEqual([['kill', '-9', '11', '12', '13', '99']])
  await ui.press({ key: 'svc:restart:11' })
  expect(launches).toEqual([{ SOAP_CMD: 'npm run dev', SOAP_DIR: `${MAC_ROOT}/web` }])
  await ui.unmount()
})

test('on macOS a service whose command has quotes or $ is not restarted, and the pane says why', async ($, on) => {
  // ps 讀到的指令已經沒有原本的引號了，交給 sh 重跑會變成別的意思。
  const { kills, launches } = macServices(on, MAC_ARGS_OUT.replace('npm run dev', 'npm run dev -- --host "$HOST"'))

  const ui = await mountPane($)
  await ui.press({ key: 'tab:services' })
  await ui.press({ key: 'svc:restart:11' })
  // 不砍、也不重跑，留著原本的服務。
  expect(kills).toEqual([])
  expect(launches).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^Restart failed: Cannot rerun npm · web: its command has quotes or shell characters/ })).toBeDefined()
  expect(await ui.find({ key: 'svc:restart:11' })).toBeDefined()
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
  await ui.press({ key: 'tab:services' })
  // 每一組：標題，和它底下的服務（PID）。
  const groups = (await ui.findAll({ type: 'Box' }))
    .filter(b => b.key?.startsWith('svc-group:'))
    .map(b => [b.text.split('●')[0], ...b.children.flatMap(c => (c.props?.key?.startsWith('svc:') ? [c.props.key] : []))])
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

// ───── 回合結束 ─────

const diffOf = (line: string) => `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+${line}\n`

test('at turn end the repo bar and an open diff reread, and the diff closes once its file has no changes', async ($, on) => {
  let status = '## main\0 M a.ts\0'
  let diff = diffOf('b')
  stubPanel(on)
  gitRepo(on, { status: () => status, run: cmd => (cmd[0] === 'diff' ? ok(diff) : undefined) })
  await openPanel($)
  const label = async () => (await ui.find({ key: 'repo:repo' }))?.props.label
  const source = async () => (await ui.find({ type: 'Code' }))?.props.source

  const ui = await mountPane($)
  expect(await label()).toBe('repo*')
  // 這個回合 Claude 弄出了一個衝突：repo 名稱後面多一個 !。
  status = '## main\0 M a.ts\0UU c.ts\0'
  await endTurn($, ui)
  expect(await label()).toBe('repo* !')

  // 開著的差異：Claude 又改了 a.ts，換成新的差異。
  await ui.press({ key: 'file:unstaged:a.ts' })
  expect(await source()).toContain('+b')
  diff = diffOf('c')
  await endTurn($, ui)
  expect(await source()).toContain('+c')

  // Claude 把變更都 commit 了：差異關掉、回到分頁，repo 名稱後面的記號也拿掉。
  status = '## main\0'
  await endTurn($, ui)
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
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
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
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
