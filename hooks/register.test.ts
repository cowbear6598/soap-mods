import { expect, mock, test } from 'claude-code/testing'

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
  const diffOpens: string[] = []
  on('ui.open', (_$, e) => {
    if (e.id === 'soap-diff') diffOpens.push(e.title ?? '')

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('C:/repo\nC:/repo/.git\n')
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
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('C:/repo\nC:/repo/.git\n')
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
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('C:/repo\nC:/repo/.git\n')
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

test('a session folder holding several repos gets a repo bar with counts, and pressing one switches the Git tab to it', async ($, on) => {
  const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }) as const
  const statusCwds: (string | undefined)[] = []
  const logCwds: (string | undefined)[] = []
  // Windows 上引擎會把路徑轉成反斜線，比對前轉回來。
  const slash = (p: string | undefined) => p?.replace(/\\/g, '/')
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.cwd', () => ({ value: 'C:/company' }))
  // company/ 底下：a、b 是 repo，docs 不是，.cache 是隱藏資料夾；各 repo 的 .git 裡沒有進行中的操作。
  on('fs.list', (_$, e) => ({ value: slash(e.path) === 'C:/company' ? [dir('b'), dir('a'), dir('docs'), dir('.cache')] : [] }))
  on('fs.exists', (_$, e) => ({ value: ['C:/company/a/.git', 'C:/company/b/.git'].includes(slash(e.path) ?? '') }))
  on('process.run', (_$, e) => {
    const cwd = slash(e.init?.cwd)
    const args = e.argv.slice(3)
    if (args[0] === 'rev-parse') {
      if (cwd === 'C:/company') return { value: { ...ok('').value, exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' } }

      return ok(`${cwd}\n${cwd}/.git\n`)
    }
    if (args[0] === 'log') logCwds.push(cwd)
    if (args[0] === 'status') {
      statusCwds.push(cwd)
      if (cwd === 'C:/company/a') return ok('## main\0 M a1.ts\0 M a2.ts\0')
      if (cwd === 'C:/company/b') return ok('## main\0UU b1.ts\0')
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
  expect(logCwds.at(-1)).toBe('C:/company/a')

  await ui.press({ key: 'repo:b' })
  expect((await ui.find({ key: 'repo:b' }))?.props).toMatchObject({ variant: 'primary' })
  // log 也換成 b 的。
  expect(logCwds.at(-1)).toBe('C:/company/b')
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
  const diffOpens: string[] = []
  on('ui.open', (_$, e) => {
    if (e.id === 'soap-diff') diffOpens.push(e.title ?? '')

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: now }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'rev-parse') return ok('C:/repo\nC:/repo/.git\n')
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
  expect(await ui.find({ type: 'Text', text: 'CptSoap · 3d' })).toBeDefined()
  // 有 upstream：跟 upstream 比哪些還沒 push，那兩筆標 ↑。
  expect(revListArgs.at(-1)).toEqual(['rev-list', '--max-count=30', 'HEAD', '--not', 'origin/main'])
  expect(await ui.findAll({ type: 'Text', text: '↑' })).toHaveLength(2)
  // 桌面版：subject 是文字、整行是按鈕。
  const desk = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  expect(await desk.find({ type: 'Text', text: 'Commit 0' })).toBeDefined()
  expect(await desk.find({ key: `commit:${sha(0)}` })).toBeDefined()
  await desk.unmount()

  await ui.press({ key: 'log:more' })
  expect(await ui.find({ type: 'Text', text: 'main · 40' })).toBeDefined()
  expect(await ui.find({ key: 'log:more' })).toBeUndefined()

  // 點 commit：列表換成它改了哪些檔案；點檔案在 diff 面板看它在這個 commit 的差異，改名兩個路徑都給。
  await ui.press({ key: `commit:${sha(0)}` })
  expect(await ui.find({ type: 'Text', text: 'Files · 2' })).toBeDefined()
  expect(await ui.find({ key: `commit:${sha(1)}` })).toBeUndefined()
  await ui.press({ key: 'commit-file:src/a.ts' })
  expect(diffOpens).toEqual([`src/a.ts @ ${short(0)}`])
  const diff = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-diff', props: PANE_PROPS })
  expect(await diff.find({ type: 'Code' })).toBeDefined()
  expect(await diff.find({ type: 'Text', text: `@ ${short(0)}` })).toBeDefined()
  await diff.unmount()
  await ui.press({ key: 'log:back' })
  expect(await ui.find({ key: `commit:${sha(1)}` })).toBeDefined()

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
  expect(revListArgs.at(-1)).toEqual(['rev-list', '--max-count=30', 'refs/heads/dev', '--not', '--remotes'])
  // 按目前分支那列的 log：回到跟著目前分支。
  await ui.press({ key: 'sub:branch' })
  await ui.press({ key: 'log:l:main' })
  expect(await ui.find({ type: 'Text', text: 'main · 30+' })).toBeDefined()
  expect(logArgs.at(-1)?.[1]).toBe('HEAD')
  await ui.unmount()
})

// ───── Services ─────

test('the Services tab lists the running services and stops one by killing its tree', async ($, on) => {
  const calls: string[][] = []
  on('clock.now', () => ({ value: 1000 + 12 * 60_000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: ROOT }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
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
  expect(calls.some(c => c.join(' ') === 'taskkill /PID 21 /T /F')).toBe(true)
  // 引擎自己和它開的程序絕不會被砍。
  expect(calls.some(c => c[0] === 'taskkill' && ['100', '300', '30'].includes(c[2] ?? ''))).toBe(false)
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
  on('session.cwd', () => ({ value: ROOT }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'taskkill') kills.push(e.argv[2] ?? '')
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
  on('session.cwd', () => ({ value: ROOT }))
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
  on('session.cwd', () => ({ value: MAC_ROOT }))
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

// 停在 merge、src/a.ts 有一段衝突的 repo；git add 之後就沒有衝突了。
function conflictRepo(on: TestOn) {
  const calls: { args: string[]; cwd?: string; env?: Record<string, string> }[] = []
  const writes: { path: string; text: string }[] = []
  const prompts: string[] = []
  let isAdded = false
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('fs.list', () => ({ value: [{ name: 'MERGE_HEAD', kind: 'file', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: CONFLICTED }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('process.run', (_$, e) => {
    const args = e.argv.slice(3)
    calls.push({ args, cwd: e.init?.cwd, env: e.init?.env })
    if (args[0] === 'status') return ok(isAdded ? '## main\0M  src/a.ts\0' : '## main\0UU src/a.ts\0')
    if (args[0] === 'rev-parse') return ok('C:/repo\nC:/repo/.git\n')
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

test('the conflict tab lists conflicted files, and the merge pane resolves one, git adds it, then continues', async ($, on) => {
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

  // 三欄在兩種畫面上都畫得出來。
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'soap-mods', surface, component: 'Pane', requestId: 'soap-merge', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: '0 of 1 conflicts resolved' })).toBeDefined()
    expect(await pane.find({ key: 'merge:ours:1' })).toBeDefined()
    expect(await pane.find({ key: 'merge:theirs:1' })).toBeDefined()
    expect(await pane.find({ key: 'merge:both:1' })).toBeDefined()
    expect(await pane.find({ key: 'merge:next' })).toBeDefined()
    expect(await pane.find({ key: 'merge:prev' })).toBeDefined()
    // 只畫用得到的按鈕：還沒選時沒有 Reset，還有衝突時沒有 Apply。
    expect(await pane.find({ key: 'merge:reset:1' })).toBeUndefined()
    expect(await pane.find({ key: 'merge:apply' })).toBeUndefined()
    await pane.unmount()
  }

  const pane = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-merge', props: PANE_PROPS })
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
  // Windows 上引擎會把路徑轉成反斜線。
  expect(writes.map(w => ({ ...w, path: w.path.replace(/\\/g, '/') }))).toEqual([
    { path: 'C:/repo/src/a.ts', text: 'import a\nconst x = 1\nconst x = 2\nend\n' },
  ])
  expect(calls.some(c => c.args.join(' ') === 'add -- src/a.ts' && c.cwd === 'C:/repo')).toBe(true)

  // 衝突都解完了：可以 continue，merge 是直接用預設訊息 commit、不開編輯器。
  expect(await ui.find({ type: 'Text', text: 'All conflicts resolved.' })).toBeDefined()
  await ui.press({ key: 'op:continue' })
  const commit = calls.find(c => c.args.join(' ') === 'commit --no-edit')
  expect(commit?.env).toEqual({ LC_ALL: 'C', GIT_EDITOR: 'true' })
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
  const pane = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-merge', props: PANE_PROPS })
  await pane.press({ key: 'merge:claude' })
  expect(prompts.length).toBe(1)
  // 給 Claude 的是完整路徑：session 資料夾不是 repo 時，相對路徑會找不到檔案。
  expect(prompts[0]).toContain('`C:/repo/src/a.ts`')
  await pane.unmount()

  await ui.press({ key: 'op:abort' })
  await ui.press({ key: 'op:abort' })
  expect(calls.some(c => c.args.join(' ') === 'merge --abort' && c.cwd === 'C:/repo')).toBe(true)
  await ui.unmount()
})

test('a pane brought to the front, or one whose pressed button was swapped out, gets the keyboard back', async ($, on) => {
  const clock = mock.clock(on)
  const pane = (id: string, isShown: boolean, isFocused: boolean) => ({ id, title: id, isShown, isFocused, isPlaced: true })
  let panes = [pane('soap-panel', true, false)]
  const focused: string[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_$, e) => {
    if (e.focus === true) focused.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.list', () => ({ value: [{ name: 'MERGE_HEAD', kind: 'file', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: CONFLICTED }))
  on('process.run', (_$, e) => {
    const args = e.argv.slice(3)
    if (args[0] === 'status') return ok('## main\0UU src/a.ts\0')
    if (args[0] === 'rev-parse') return ok('C:/repo\nC:/repo/.git\n')
    if (args[0] === 'show') return showStage(args)

    return ok('')
  })
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })

  // 剛啟動時 Soap Panel 在前面但沒焦點：不搶（人可能正在輸入框打字）。
  await clock.advance(200)
  expect(focused).toEqual([])

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'conflict:src/a.ts' })
  await ui.unmount()
  focused.length = 0

  // 合併面板被切到前面、沒拿到焦點：補給它。
  panes = [pane('soap-panel', false, false), pane('soap-merge', true, false)]
  await clock.advance(200)
  expect(focused).toEqual(['soap-merge'])
  focused.length = 0

  // 按了 Accept，被按的按鈕被換掉而丟了焦點：剛按完的一小段時間內補回來。
  panes = [pane('soap-panel', false, false), pane('soap-merge', true, true)]
  const merge = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-merge', props: PANE_PROPS })
  await merge.press({ key: 'merge:ours:1' })
  panes = [pane('soap-panel', false, false), pane('soap-merge', true, false)]
  await clock.advance(200)
  expect(focused).toEqual(['soap-merge'])
  focused.length = 0

  // 過了那段時間才丟焦點（人自己點去輸入框）：不搶回來。
  await clock.advance(1000)
  panes = [pane('soap-panel', false, false), pane('soap-merge', true, true)]
  await clock.advance(200)
  panes = [pane('soap-panel', false, false), pane('soap-merge', true, false)]
  await clock.advance(200)
  expect(focused).toEqual([])
  await merge.unmount()
})
