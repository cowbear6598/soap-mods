import { expect, mock, test } from 'claude-code/testing'

import { GOOD } from './config'
import { CONFLICTED, MAC_FILES_OUT, MAC_PPIDS_OUT, MAC_ROOT, MAC_SCAN_OUT, ROOT, SCAN } from './test-fixtures'

// 面板的 props：引擎畫面板時一定會給，測試照實給一份。
const PANE_PROPS = {
  title: 'Soap Panel',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

// 引擎會把 fs、process 的路徑轉成這台電腦的絕對路徑（Windows 加磁碟代號、換反斜線），比對前轉回 /repo 這種寫法。
const posix = (p: string | undefined) => p?.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

test('the pane draws the Git tab with its four sub tabs on each surface', async ($, on) => {
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
    for (const sub of ['diff', 'branch', 'log', 'conflict']) {
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
  const diffArgs: string[][] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (cmd[0] === 'switch') return { value: { ...ok('').value, exitCode: 128, stderr: SWITCH_FAILED } }
    if (cmd[0] === 'status') return ok('## main...origin/main [ahead 1]\0 M a.ts\0?? b.ts\0')
    if (cmd[0] === 'diff') diffArgs.push(cmd)
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

  // 桌面版整行都是按鈕：同一個 key 疊在整行上面，按下去一樣看差異。
  const desk = await $.ui.mount({
    plugin: 'soap-mods',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'soap-panel',
    props: PANE_PROPS,
  })
  expect(await desk.find({ type: 'Text', text: 'a.ts' })).toBeDefined()
  await desk.press({ key: 'file:unstaged:a.ts' })
  expect(await desk.find({ type: 'Code' })).toBeDefined()
  await desk.press({ key: 'diff:back' })
  await desk.unmount()

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

  // 搜尋：只留名稱符合的分支，Remote 收著也直接列出來；換分頁就清掉。
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

  await ui.press({ key: 'sub:conflict' })
  expect(await ui.find({ type: 'Text', text: 'No conflicts.' })).toBeDefined()
  await ui.unmount()
})

test('deleting a local branch turns its trash into a check that deletes, and gives up after 3s or on another trash', async ($, on) => {
  const clock = mock.clock(on)
  const deletes: string[] = []
  const toasts: string[] = []
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (cmd[0] === 'status') return ok('## main\0')
    if (cmd[0] === 'branch') {
      deletes.push(cmd.join(' '))
      if (cmd[1] === '-d') return { value: { ...ok('').value, exitCode: 1, stderr: "error: the branch 'dev' is not fully merged" } }

      return ok('')
    }
    if (cmd[0] === 'for-each-ref') {
      const isGone = deletes.includes('branch -D dev')
      const lines = ['*\trefs/heads/main\tmain\t\t\t1 hour ago\tAdd panel', ' \trefs/heads/feat\tfeat\t\t\t1 day ago\tTry']

      return ok([...lines, ...(isGone ? [] : [' \trefs/heads/dev\tdev\t\t\t2 days ago\tWip']), ''].join('\n'))
    }

    return ok('')
  })
  await $.command.run({ command: 'soap-panel', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'sub:branch' })
  // 目前分支沒有刪除鈕。
  expect(await ui.find({ key: 'delete:l:main' })).toBeUndefined()

  // 按一下只換成打勾；3 秒沒再按就收回，下一下又只是換成打勾。
  await ui.press({ key: 'delete:l:dev' })
  expect(deletes).toEqual([])
  await clock.advance(3_000)
  await ui.press({ key: 'delete:l:dev' })
  expect(deletes).toEqual([])

  // 按了別的垃圾桶，原本的收回：再按 dev 也只是換成打勾。
  await ui.press({ key: 'delete:l:feat' })
  await ui.press({ key: 'delete:l:dev' })
  expect(deletes).toEqual([])

  // 打勾再按才刪；-d 被拒（沒合併）就換成強制刪除的打勾，再按才 -D。
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
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.copy', (_$, e) => {
    copies.push(e.text)

    return { value: { isCopied: true } }
  })
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (cmd[0] === 'status') return ok('## main\0')
    if (cmd[0] === 'for-each-ref') return ok('*\trefs/heads/main\tmain\t\t\t1 hour ago\tAdd panel\n \trefs/heads/dev\tdev\t\t\t2 days ago\tWip\n')

    return ok('')
  })
  await $.command.run({ command: 'soap-panel', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
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
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (cmd[0] === 'status') return ok('## main\0')
    if (cmd[0] === 'fetch' || cmd[0] === 'pull') {
      syncs.push(`${cmd.join(' ')} prompt=${e.init?.env?.GIT_TERMINAL_PROMPT} timeout=${e.init?.timeoutMs}`)
      if (cmd[0] === 'pull' && isDiverged) return { value: { ...ok('').value, exitCode: 128, stderr: PULL_FAILED } }

      return ok(cmd[0] === 'pull' ? 'Already up to date.\n' : '')
    }
    if (cmd[0] === 'for-each-ref') return ok('*\trefs/heads/main\tmain\torigin/main\t\t1 hour ago\tAdd panel\n')

    return ok('')
  })
  await $.command.run({ command: 'soap-panel', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'sub:branch' })
  // 按了才跑。
  expect(syncs).toEqual([])

  await ui.press({ key: 'branch:fetch' })
  await ui.press({ key: 'branch:pull' })
  expect(syncs).toEqual(['fetch --all --prune prompt=0 timeout=300000', 'pull --ff-only prompt=0 timeout=300000'])
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
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (cmd[0] === 'status') return ok(`## main\0${names('f', 70).map(f => `?? ${f}.ts\0`).join('')}`)
    if (cmd[0] === 'for-each-ref') {
      const remotes = names('origin/b', 60).map(b => ` \trefs/remotes/${b}\t${b}\t\t\t1 day ago\tWip`)

      return ok(['*\trefs/heads/main\tmain\t\t\t1 hour ago\tAdd panel', ...remotes, ''].join('\n'))
    }

    return ok('')
  })
  await openPanel($)

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
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
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (cmd[0] === 'status') return ok('## soap/feature/login\0')
    if (cmd[0] === 'for-each-ref') {
      const local = (name: string, head = ' ') => `${head}\trefs/heads/${name}\t${name}\t\t\t1 day ago\tWip`

      return ok([local('soap/feature/login', '*'), local('feature/a'), local('feature/b'), local('main'), ''].join('\n'))
    }

    return ok('')
  })
  await openPanel($)

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'sub:branch' })
  // 目前分支固定在最上面寫全名；其他分支收在資料夾裡，預設收起。
  expect(await ui.find({ key: 'switch:l:soap/feature/login' })).toBeDefined()
  expect(await ui.find({ key: 'switch:l:main' })).toBeDefined()
  expect(await ui.find({ key: 'switch:l:feature/a' })).toBeUndefined()
  await ui.press({ key: 'folder:l:feature/' })
  expect(await ui.find({ key: 'switch:l:feature/a' })).toBeDefined()
  await ui.press({ key: 'folder:l:feature/' })
  expect(await ui.find({ key: 'switch:l:feature/a' })).toBeUndefined()
  // 搜尋時資料夾全部打開。
  await ui.input({ key: 'branch:search', text: 'b', kind: 'change' })
  expect(await ui.find({ key: 'switch:l:feature/b' })).toBeDefined()
  await ui.unmount()
})

test('a session folder holding several repos gets a repo bar with counts, and pressing one switches the Git tab to it', async ($, on) => {
  const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }) as const
  const statusCwds: (string | undefined)[] = []
  const logCwds: (string | undefined)[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/company' }))
  // Bash 在回合中 cd 進 a 去 commit，shell 的 cwd 跟著跑，但專案根目錄不變：repo bar 還是要列出 a、b。
  on('session.cwd', () => ({ value: '/company/a' }))
  // company/ 底下：a、b 是 repo，docs 不是，.cache 是隱藏資料夾；各 repo 的 .git 裡沒有進行中的操作。
  on('fs.list', (_$, e) => ({ value: posix(e.path) === '/company' ? [dir('b'), dir('a'), dir('docs'), dir('.cache')] : [] }))
  on('fs.exists', (_$, e) => ({ value: ['/company/a/.git', '/company/b/.git'].includes(posix(e.path) ?? '') }))
  on('process.run', (_$, e) => {
    const cwd = posix(e.init?.cwd)
    const args = e.argv.slice(3)
    if (args[0] === 'rev-parse') {
      if (cwd === '/company') return { value: { ...ok('').value, exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' } }

      return ok(`${cwd}\n${cwd}/.git\n`)
    }
    if (args[0] === 'log') logCwds.push(cwd)
    if (args[0] === 'status') {
      statusCwds.push(cwd)
      if (cwd === '/company/a') return ok('## main\0 M a1.ts\0 M a2.ts\0')
      if (cwd === '/company/b') return ok('## main\0UU b1.ts\0')
    }

    return ok('')
  })
  await openPanel($)

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  // 照名稱排，一開始看第一個；有變更、有衝突標在名稱後面，不是 repo 的資料夾不列。
  expect((await ui.find({ key: 'repo:a' }))?.props).toMatchObject({ label: 'a*', variant: 'primary' })
  expect((await ui.find({ key: 'repo:b' }))?.props).toMatchObject({ label: 'b* !', variant: 'secondary' })
  expect(await ui.find({ key: 'repo:docs' })).toBeUndefined()
  expect(await ui.find({ key: 'file:unstaged:a1.ts' })).toBeDefined()
  expect(statusCwds.every(c => c !== undefined)).toBe(true)

  // log 只在 log 分頁時讀。
  expect(logCwds).toEqual([])
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

test('the log tab lists the branch commits, marks unpushed ones, loads more, and opens a commit file diff', async ($, on) => {
  const now = Date.parse('2026-10-11T00:00:00Z')
  const time = now / 1000 - 3 * 86400
  const sha = (i: number) => `${String(i).padStart(7, '0')}${'f'.repeat(33)}`
  const short = (i: number) => String(i).padStart(7, '0')
  const logArgs: string[][] = []
  const revListArgs: string[][] = []
  const diffTreeArgs: string[][] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: now }))
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (cmd[0] === 'status') return ok('## main...origin/main [ahead 2]\0')
    if (cmd[0] === 'for-each-ref') {
      return ok(
        [
          '*\trefs/heads/main\tmain\torigin/main\t[ahead 2]\t1 hour ago\tCommit 0',
          ' \trefs/heads/dev\tdev\t\t\t2 days ago\tWip',
          ' \trefs/remotes/origin/main\torigin/main\t\t\t1 hour ago\tCommit 2',
          '',
        ].join('\n'),
      )
    }
    if (cmd[0] === 'log') {
      logArgs.push(cmd)
      // 這個分支有 40 筆 commit，照 --max-count 給；沒給就是整條（搜尋）。
      const max = cmd.find(a => a.startsWith('--max-count='))?.split('=')[1]
      const count = Math.min(max === undefined ? Infinity : Number(max), 40)
      const lines = Array.from({ length: count }, (_, i) => `${sha(i)}\t${short(i)}\t${sha(i + 1)}\tCptSoap\t${time}\tCommit ${i}`)

      return ok(`${lines.join('\n')}\n`)
    }
    if (cmd[0] === 'rev-list') {
      revListArgs.push(cmd)

      return ok(`${sha(0)}\n${sha(1)}\n`)
    }
    if (cmd[0] === 'diff-tree') diffTreeArgs.push(cmd)
    if (cmd[0] === 'diff-tree' && cmd.includes('--name-status')) return ok(['M', 'src/a.ts', 'R100', 'old.ts', 'new.ts', ''].join('\0'))
    if (cmd[0] === 'diff-tree') return ok('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n')

    return ok('')
  })
  await openPanel($)

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
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
  // 桌面版：subject 是文字、整行是按鈕。
  const desk = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  expect(await desk.find({ type: 'Text', text: 'Commit 0' })).toBeDefined()
  expect(await desk.find({ key: `commit:${sha(0)}` })).toBeDefined()
  await desk.unmount()

  await ui.press({ key: 'log:more' })
  expect(await ui.find({ type: 'Text', text: 'main · 40' })).toBeDefined()
  expect(await ui.find({ key: 'log:more' })).toBeUndefined()

  // 點 commit：列表換成它改了哪些檔案；點檔案在 Soap Panel 裡看它在這個 commit 的差異，改名兩個路徑都給。
  await ui.press({ key: `commit:${sha(0)}` })
  expect(await ui.find({ type: 'Text', text: 'Files · 2' })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(1)}` })).toBeUndefined()
  await ui.press({ key: 'commit-file:src/a.ts' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: `@ ${short(0)}` })).toBeDefined()
  // Back 回到 commit 的檔案列表。
  await ui.press({ key: 'diff:back' })
  expect(await ui.find({ type: 'Text', text: 'Files · 2' })).toBeDefined()
  await ui.press({ key: 'log:back' })
  expect(await ui.find({ key: `commit:${sha(1)}` })).toBeDefined()

  // Select range：點起點（再點一次取消）、再點終點，兩筆之間（含）一起打開：最舊那筆之前 → 最新那筆。
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
  // 差異的 Previous／Next（n／m）：換成同一批的上一個／下一個檔案，到頭了不動。
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
  // Back 回檔案列表，再 Back 回 commit 列表，選範圍結束：點 commit 又是打開那一筆。
  await ui.press({ key: 'diff:back' })
  await ui.press({ key: 'log:back' })
  expect(await ui.find({ type: 'Text', text: 'Press the first commit of the range.' })).toBeUndefined()
  // Cancel 也結束。
  await ui.press({ key: 'log:range' })
  await ui.press({ key: 'log:range' })
  expect(await ui.find({ type: 'Text', text: 'Press the first commit of the range.' })).toBeUndefined()

  // 搜尋：搜整條分支（包括還沒列出來的），每個字都要有、不分大小寫；整條歷史只讀一次，打字時直接過濾。
  const fullReads = () => logArgs.filter(a => !a.some(x => x.startsWith('--max-count='))).length
  await ui.input({ key: 'log:search', text: 'COMMIT 3', kind: 'change' })
  // 3、13、23、30–39。
  expect(await ui.find({ type: 'Text', text: 'main · 13' })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(39)}` })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(1)}` })).toBeUndefined()
  await ui.input({ key: 'log:search', text: 'commit 39', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'main · 1' })).toBeDefined()
  await ui.input({ key: 'log:search', text: 'nope', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'No matching commits.' })).toBeDefined()
  // 符合的超過 30 筆一樣分頁。
  await ui.input({ key: 'log:search', text: 'cptsoap', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'main · 30+' })).toBeDefined()
  await ui.press({ key: 'log:more' })
  expect(await ui.find({ type: 'Text', text: 'main · 40' })).toBeDefined()
  expect(fullReads()).toBe(1)
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
  const entry = (name: string, kind: 'file' | 'dir', size = 0) => ({ name, kind, size, mtimeMs: 0, isLink: false })
  const listed: (string | undefined)[] = []
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.list', (_$, e) => {
    const path = posix(e.path)
    listed.push(path)
    if (path === '/proj') return { value: [entry('README.md', 'file', 4300), entry('src', 'dir')] }
    if (path === '/proj/src') return { value: [entry('main.ts', 'file', 120)] }

    return { value: [] }
  })
  on('process.run', () => ok(''))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'soap-mods', surface, component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
    await ui.press({ key: 'tab:files' })
    expect(await ui.find({ key: 'sub:diff' })).toBeUndefined()
    expect(await ui.find({ key: 'files:dir:src' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'README.md' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4.2 KB' })).toBeDefined()
    // session 資料夾本身：沒有路徑、沒有 Back。
    expect(await ui.find({ key: 'files:back' })).toBeUndefined()

    await ui.press({ key: 'files:dir:src' })
    expect(listed.at(-1)).toBe('/proj/src')
    expect(await ui.find({ type: 'Text', text: 'src/' })).toBeDefined()
    expect((await ui.find({ key: 'files:back' }))?.props).toMatchObject({ label: '← Back', hotkey: 'b' })
    expect(await ui.find({ type: 'Text', text: 'main.ts' })).toBeDefined()

    await ui.press({ key: 'files:back' })
    expect(listed.at(-1)).toBe('/proj')
    expect(await ui.find({ key: 'files:dir:src' })).toBeDefined()
    await ui.press({ key: 'tab:git' })
    await ui.unmount()
  }
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

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'soap-mods', surface, component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
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
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
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

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'tab:services' })
  await ui.press({ key: 'svc:restart:11' })
  expect(kills).toEqual(['11'])
  expect(launches).toHaveLength(1)
  expect(launches[0]?.SOAP_DIR).toBe('C:\\proj\\web')
  expect(launches[0]?.SOAP_CMD).toContain('npm-cli.js" run dev')
  expect(Object.keys(launches[0] ?? {}).sort()).toEqual(['SOAP_CMD', 'SOAP_DIR'])
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

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'tab:services' })
  await ui.press({ key: 'svc:restart:11' })
  // 重跑後的檢查在計時器裡跑，等它寫進畫面。
  const failed = /Restart failed: npm · web exited right after starting/
  for (let i = 0; i < 20 && (await ui.find({ type: 'Text', text: failed })) === undefined; i++) await Promise.resolve()
  expect(await ui.find({ type: 'Text', text: failed })).toBeDefined()
  // 定時掃描成功也不能把重跑失敗的提示洗掉。
  await ui.press({ key: 'tab:git' })
  await ui.press({ key: 'tab:services' })
  expect(await ui.find({ type: 'Text', text: /Restart failed/ })).toBeDefined()
  await ui.unmount()
})

test('on macOS the Services tab scans with ps and lsof, stops with kill -9 on the tree, and restarts with sh', async ($, on) => {
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
    if (e.argv[0] === 'ps') return ok(MAC_PPIDS_OUT)
    if (e.argv[0] === 'lsof') return ok(MAC_FILES_OUT)
    if (e.argv[0] === '/bin/sh' && e.init?.env?.SOAP_CMD !== undefined) {
      launches.push(e.init.env)

      return ok('4321\n')
    }
    if (e.argv[0] === '/bin/sh') return ok(MAC_SCAN_OUT)

    return ok('')
  })

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'tab:services' })
  expect(await ui.find({ type: 'Text', text: 'npm' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'web' })).toBeDefined()
  await ui.press({ key: 'svc:stop:11' })
  expect(kills).toEqual([['kill', '-9', '11', '12', '13', '99']])
  await ui.press({ key: 'svc:restart:11' })
  expect(launches).toEqual([{ SOAP_CMD: 'npm run dev', SOAP_DIR: `${MAC_ROOT}/web` }])
  await ui.unmount()
})

// ───── 解衝突 ─────

// git 留著的三個版本：1 共同祖先、2 ours、3 theirs（git show :n:path）。
const STAGES: Record<string, string> = {
  ':1:src/a.ts': 'import a\nconst x = 0\nend\n',
  ':2:src/a.ts': 'import a\nconst x = 1\nend\n',
  ':3:src/a.ts': 'import a\nconst x = 2\nend\n',
}
const showStage = (args: readonly string[]) => {
  const blob = STAGES[args[1] ?? '']

  return blob === undefined ? { value: { ...ok('').value, exitCode: 128 } } : ok(blob)
}

type TestBody = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type TestEngine = Parameters<TestBody>[0]
type TestOn = Parameters<TestBody>[1]

// 停在 merge、src/a.ts 有一段衝突的 repo；git add 之後就沒有衝突了。status：git status 印出的衝突檔案。
function conflictRepo(on: TestOn, status = '## main\0UU src/a.ts\0') {
  const calls: { args: string[]; cwd?: string; env?: Record<string, string> }[] = []
  const writes: { path: string; text: string }[] = []
  const prompts: string[] = []
  let isAdded = false
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.list', () => ({ value: [{ name: 'MERGE_HEAD', kind: 'file', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: CONFLICTED }))
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
    if (args[0] === 'status') return ok(isAdded ? '## main\0M  src/a.ts\0' : status)
    if (args[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (args[0] === 'show') return showStage(args)
    if (args[0] === 'add') isAdded = true

    return ok('')
  })

  return { calls, writes, prompts }
}

const openPanel = ($: TestEngine) =>
  $.command.run({
    command: 'soap-panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

test('the conflict tab lists conflicted files, and the merge view resolves one, git adds it, then continues', async ($, on) => {
  const { calls, writes } = conflictRepo(on)
  await openPanel($)

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  // session 資料夾本身就是 repo：那排 repo 只有它一個，一樣標有沒有變更和衝突。
  expect((await ui.find({ key: 'repo:repo' }))?.props).toMatchObject({ label: 'repo* !', variant: 'primary' })
  await ui.press({ key: 'sub:conflict' })
  expect(await ui.find({ type: 'Text', text: 'Merge in progress' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Conflicts · 1' })).toBeDefined()
  // 還有衝突時不能 continue。
  expect(await ui.find({ key: 'op:continue' })).toBeUndefined()
  await ui.press({ key: 'conflict:src/a.ts' })
  // 三欄畫在 Soap Panel 裡，蓋掉分頁。
  expect(await ui.find({ key: 'sub:conflict' })).toBeUndefined()

  // 三欄在兩種畫面上都畫得出來。
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = surface === 'terminal' ? ui : await $.ui.mount({ plugin: 'soap-mods', surface, component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: '0 of 1 conflicts resolved' })).toBeDefined()
    expect(await pane.find({ key: 'merge:ours:1' })).toBeDefined()
    expect(await pane.find({ key: 'merge:theirs:1' })).toBeDefined()
    expect(await pane.find({ key: 'merge:both:1' })).toBeDefined()
    expect(await pane.find({ key: 'merge:next' })).toBeDefined()
    expect(await pane.find({ key: 'merge:prev' })).toBeDefined()
    // 只畫用得到的按鈕：還沒選時沒有 Reset，還有衝突時沒有 Apply。
    expect(await pane.find({ key: 'merge:reset:1' })).toBeUndefined()
    expect(await pane.find({ key: 'merge:apply' })).toBeUndefined()
    if (pane !== ui) await pane.unmount()
  }

  const pane = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await pane.press({ key: 'merge:ours:1' })
  expect(await pane.find({ type: 'Text', text: '1 of 1 conflicts resolved' })).toBeDefined()
  // 選好之後中間只剩 Reset，Apply 出現。
  expect(await pane.find({ key: 'merge:both:1' })).toBeUndefined()
  expect(await pane.find({ key: 'merge:apply' })).toBeDefined()
  await pane.press({ key: 'merge:reset:1' })
  expect(await pane.find({ type: 'Text', text: '0 of 1 conflicts resolved' })).toBeDefined()
  await pane.press({ key: 'merge:both:1' })
  await pane.press({ key: 'merge:apply' })
  await pane.unmount()

  // 寫回 repo 根目錄底下的檔案，在根目錄 git add。
  expect(writes).toEqual([
    { path: '/repo/src/a.ts', text: 'import a\nconst x = 1\nconst x = 2\nend\n' },
  ])
  expect(calls.some(c => c.args.join(' ') === 'add -- src/a.ts' && c.cwd === '/repo')).toBe(true)

  // 衝突都解完了：可以 continue，merge 是直接用預設訊息 commit、不開編輯器。
  expect(await ui.find({ type: 'Text', text: 'All conflicts resolved.' })).toBeDefined()
  await ui.press({ key: 'op:continue' })
  const commit = calls.find(c => c.args.join(' ') === 'commit --no-edit')
  expect(commit?.env).toMatchObject({ LC_ALL: 'C', GIT_EDITOR: 'true', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' })
  await ui.unmount()
})

test('abort asks once more before running, and Ask Claude sends the file to the model', async ($, on) => {
  const { calls, prompts } = conflictRepo(on)
  await openPanel($)

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'op:abort' })
  expect(calls.some(c => c.args[1] === '--abort')).toBe(false)
  expect(await ui.find({ key: 'op:abort-cancel' })).toBeDefined()
  await ui.press({ key: 'op:abort-cancel' })
  expect(await ui.find({ key: 'op:abort-cancel' })).toBeUndefined()

  await ui.press({ key: 'conflict:src/a.ts' })
  await ui.press({ key: 'merge:claude' })
  expect(prompts.length).toBe(1)
  // 給 Claude 的是完整路徑：session 資料夾不是 repo 時，相對路徑會找不到檔案。
  expect(prompts[0]).toContain('`/repo/src/a.ts`')
  // Back 回 conflict 分頁。
  await ui.press({ key: 'merge:back' })
  expect(await ui.find({ key: 'op:abort' })).toBeDefined()

  await ui.press({ key: 'op:abort' })
  await ui.press({ key: 'op:abort' })
  expect(calls.some(c => c.args.join(' ') === 'merge --abort' && c.cwd === '/repo')).toBe(true)
  await ui.unmount()
})

test('Next past the last conflict of a file opens the next conflicted file, and stops at the last one', async ($, on) => {
  conflictRepo(on, '## main\0UU src/a.ts\0UU src/b.ts\0')
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  await openPanel($)

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
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

test('Soap Panel brought to the front, or whose pressed button was swapped out, gets the keyboard back', async ($, on) => {
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
  on('fs.list', () => ({ value: [{ name: 'MERGE_HEAD', kind: 'file', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: CONFLICTED }))
  on('process.run', (_$, e) => {
    const args = e.argv.slice(3)
    if (args[0] === 'status') return ok('## main\0UU src/a.ts\0')
    if (args[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (args[0] === 'show') return showStage(args)

    return ok('')
  })
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

  // 點衝突檔案：按的那列被整塊換成三欄合併，焦點圈移到 Back；中間的按鈕按了被換掉，焦點圈跟過去；
  // Back 回分頁，移到子分頁圖示。（焦點圈要真的拿著鍵盤才移得動，測試裡看不到，這裡只確認按得下去。）
  panes = pane(true, true)
  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'conflict:src/a.ts' })
  await ui.press({ key: 'merge:both:1' })
  await ui.press({ key: 'merge:reset:1' })
  await ui.press({ key: 'merge:next' })
  expect(await ui.find({ key: 'merge:both:1' })).toBeDefined()
  await ui.press({ key: 'merge:back' })
  expect(await ui.find({ key: 'op:abort' })).toBeDefined()

  // 按完按鈕丟了焦點：剛按完的一小段時間內補回來。
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
