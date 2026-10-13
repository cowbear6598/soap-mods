import { expect, mock, test } from 'claude-code/testing'

import { ARMED_TINT } from '../../hooks/config'
import { type TestOn, endTurn, fail, fsEntry, mountPane, ok, posix, stubPanel } from '../test-fixtures'

const TASKS = '/proj/.soap/tasks'

const LOGIN = `description: >
  Users need SSO.
goals:
  - SSO signs the user in
constraints: []
related:
  - src/login.ts
verify:
  - npm test -- login.spec.ts
`

// .soap/tasks 底下的計劃：路徑（相對 /proj/.soap/tasks）→ 內容和修改時間。
type Plans = Record<string, { text: string; mtimeMs: number }>

type Run = ReturnType<typeof ok>

// folders 是 feature 資料夾；一個都沒有就當 .soap/tasks 不存在（列不出來）。
// now：給 null 時測試自己用 mock.clock；run：跑的指令（argv）給了結果就用它的，沒給都成功。
function tasks(on: TestOn, state: { folders: string[]; plans: Plans }, { now = 0, run }: { now?: number | null; run?: (argv: readonly string[]) => Run | undefined } = {}) {
  const planAt = (path: string | undefined) => {
    const plan = state.plans[posix(path)?.slice(TASKS.length + 1) ?? '']
    if (plan === undefined) throw new Error('ENOENT')

    return plan
  }
  stubPanel(on, { root: '/proj', now })
  on('process.run', (_$, e) => run?.(e.argv) ?? ok(''))
  on('fs.exists', (_$, e) => ({ value: posix(e.path) === TASKS && state.folders.length > 0 }))
  on('fs.list', (_$, e) => {
    if (posix(e.path) === TASKS && state.folders.length === 0) throw new Error('ENOENT')

    return { value: posix(e.path) === TASKS ? state.folders.map(n => fsEntry(n, 'dir')) : [] }
  })
  on('fs.stat', (_$, e) => {
    const plan = planAt(e.path)

    return { value: { kind: 'file', size: plan.text.length, mtimeMs: plan.mtimeMs, isLink: false } }
  })
  on('fs.read', (_$, e) => ({ value: planAt(e.path).text }))
}

test('the Spec tab lists the plans newest first, opens one to its Description, Goals and Verify, and b goes back', async ($, on) => {
  const state = {
    folders: ['login', 'search', 'draft'],
    plans: {
      'login/plan.yaml': { text: LOGIN, mtimeMs: 1 },
      'search/plan.yaml': { text: 'description: x\ngoal:\n  - y\n', mtimeMs: 5 },
    } as Plans,
  }
  tasks(on, state)
  const prompts: { text: string; asUser?: boolean }[] = []
  const toasts: string[] = []
  on('prompt.submit', (_$, e) => {
    prompts.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined })

    return { text: e.text }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  const ui = await mountPane($)
  await ui.press({ key: 'tab:spec' })
  const rows = (await ui.findAll({ type: 'Button' })).map(b => b.props.key).filter(k => String(k).startsWith('spec:item:'))
  expect(rows).toEqual(['spec:item:search', 'spec:item:login', 'spec:item:draft'])
  expect(await ui.find({ type: 'Text', text: 'no plan.yaml' })).toBeDefined()

  await ui.press({ key: 'spec:item:login' })
  expect((await ui.find({ key: 'spec:back' }))?.props).toMatchObject({ label: '← Back', hotkey: 'b' })
  // 標題和內容都是 Markdown（字比面板大）：清單一項一行，Verify 的指令包成 inline code。
  for (const text of ['### Description', 'Users need SSO.', '### Goals', '- SSO signs the user in', '### Related', '- `src/login.ts`', '### Verify', '- `npm test -- login.spec.ts`']) {
    expect(await ui.find({ type: 'Markdown', text })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: /has problems/ })).toBeUndefined()

  // Do（d）：叫 Claude 照這份計劃做，像使用者自己打的一樣送出。
  expect((await ui.find({ key: 'spec:do' }))?.props).toMatchObject({ label: 'Do', hotkey: 'd' })
  await ui.press({ key: 'spec:do' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatchObject({ asUser: true })
  expect(prompts[0]?.text).toMatch(/^Implement the plan in `\.soap\/tasks\/login\/plan\.yaml`\./)
  expect(toasts.at(-1)).toBe('Sent to Claude')

  // 格式不對的：紅字列出哪裡不對，讀得到的照樣畫。
  await ui.press({ key: 'spec:back' })
  await ui.press({ key: 'spec:item:search' })
  expect(await ui.find({ type: 'Text', text: '.soap/tasks/search/plan.yaml has problems:' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '! use "goals", not "goal"' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: 'x' })).toBeDefined()
  // 格式不對的不送，先叫人修。
  await ui.press({ key: 'spec:do' })
  expect(prompts).toHaveLength(1)
  expect(toasts.at(-1)).toBe('Fix .soap/tasks/search/plan.yaml first: missing "goals"')

  // 沒有 plan.yaml 的資料夾：說讀不到。
  await ui.press({ key: 'spec:back' })
  await ui.press({ key: 'spec:item:draft' })
  expect(await ui.find({ type: 'Text', text: /^! Couldn't read \.soap\/tasks\/draft\/plan\.yaml/ })).toBeDefined()
  await ui.press({ key: 'spec:back' })
  expect(await ui.find({ key: 'spec:item:login' })).toBeDefined()
  await ui.unmount()
})

test('the trash button of a spec asks with a check first, then deletes its whole folder; a failed delete keeps the row and says why', async ($, on) => {
  const clock = mock.clock(on)
  const state = {
    folders: ['login', 'search'],
    plans: { 'login/plan.yaml': { text: LOGIN, mtimeMs: 1 }, 'search/plan.yaml': { text: LOGIN, mtimeMs: 2 } } as Plans,
  }
  const removed: string[][] = []
  const toasts: string[] = []
  let isFailing = false
  tasks(on, state, {
    now: null,
    run: argv => {
      if (argv[0] !== 'rm') return undefined
      removed.push(argv.map(a => posix(a) ?? a))
      if (isFailing) return fail('rm: Permission denied', 1)
      const name = (posix(argv.at(-1)) ?? '').slice(TASKS.length + 1)
      state.folders = state.folders.filter(f => f !== name)

      return ok('')
    },
  })
  on('env.get', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    state.folders = ['login', 'search']
    removed.length = 0
    toasts.length = 0
    isFailing = false
    const ui = await mountPane($, surface)
    await ui.press({ key: 'tab:spec' })
    // 每列一個垃圾桶；按一下只換成打勾（桌面版是紅底），不刪。
    expect(await ui.find({ key: 'spec:delete:login' })).toBeDefined()
    expect(await ui.find({ key: 'spec:delete:search' })).toBeDefined()
    await ui.press({ key: 'spec:delete:login' })
    expect(removed).toEqual([])
    if (surface === 'desktop') expect((await ui.find({ key: 'spec:delete:login:box' }))?.props.backgroundColor).toBe(ARMED_TINT.background)
    else expect((await ui.find({ key: 'spec:delete:login' }))?.props.label).toBe('Confirm')
    // 按別列的垃圾桶：原本那列收回去，打勾移過去。3 秒沒再按也收回去。
    await ui.press({ key: 'spec:delete:search' })
    if (surface === 'terminal') {
      expect((await ui.find({ key: 'spec:delete:login' }))?.props.label).toBe('Delete')
      expect((await ui.find({ key: 'spec:delete:search' }))?.props.label).toBe('Confirm')
    }
    await clock.advance(3_000)
    if (surface === 'terminal') expect((await ui.find({ key: 'spec:delete:search' }))?.props.label).toBe('Delete')

    // 刪不掉：紅字寫原因，那列還在。
    isFailing = true
    await ui.press({ key: 'spec:delete:login' })
    await ui.press({ key: 'spec:delete:login' })
    expect(removed).toEqual([['rm', '-rf', '--', `${TASKS}/login`]])
    expect(await ui.find({ type: 'Text', text: /^Couldn't delete login: .*Permission denied/ })).toBeDefined()
    expect(await ui.find({ key: 'spec:item:login' })).toBeDefined()

    // 再按兩次：刪掉整個資料夾，那列不見了，錯誤也清掉。
    isFailing = false
    await ui.press({ key: 'spec:delete:login' })
    await ui.press({ key: 'spec:delete:login' })
    expect(removed).toHaveLength(2)
    expect(toasts).toEqual(['Deleted login'])
    expect(await ui.find({ key: 'spec:item:login' })).toBeUndefined()
    expect(await ui.find({ key: 'spec:item:search' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Couldn't delete/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with no .soap/tasks the Spec tab says to run /soap-mods:plan, and at turn end it picks up a new plan and rereads the open one', async ($, on) => {
  const state = { folders: [] as string[], plans: {} as Plans }
  tasks(on, state)

  const ui = await mountPane($)
  await ui.press({ key: 'tab:spec' })
  expect(await ui.find({ type: 'Text', text: 'No specs yet. Run /soap-mods:plan to write one.' })).toBeDefined()

  // Claude 跑了 /soap-mods:plan：回合結束後清單出現。
  state.folders = ['login']
  state.plans['login/plan.yaml'] = { text: LOGIN, mtimeMs: 1 }
  await endTurn($, ui)
  await ui.press({ key: 'spec:item:login' })
  expect(await ui.find({ type: 'Markdown', text: '- SSO signs the user in' })).toBeDefined()

  // 改了打開的那份：重讀。
  state.plans['login/plan.yaml'] = { text: LOGIN.replace('SSO signs the user in', 'Passkeys sign the user in'), mtimeMs: 2 }
  await endTurn($, ui)
  expect(await ui.find({ type: 'Markdown', text: '- Passkeys sign the user in' })).toBeDefined()
  await ui.unmount()
})

test('writing a plan.yaml with Write or Edit checks it: a broken one adds what to fix for Claude and a toast, others pass as they were', async ($, on) => {
  const files: Record<string, string> = {}
  const toasts: string[] = []
  stubPanel(on, { root: '/proj' })
  on('process.run', () => ok(''))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files[posix(e.path) ?? ''] ?? '' }))
  // 測試的 hook 站在引擎的位置：照實寫檔，回一個工具結果。
  on('tool.call', (_$, e) => {
    if (e.tool === 'Write') files[e.file_path] = e.content
    if (e.tool === 'Edit') files[e.file_path] = (files[e.file_path] ?? '').replace(e.old_string, e.new_string)

    return { result: { ok: true } as never }
  })

  const plan = `${TASKS}/login/plan.yaml`
  const broken = await $.tool.call({ tool: 'Write', file_path: plan, content: 'description: x\ngoal:\n  - y\n' })
  expect(broken.context?.at(-1)).toMatch(/is not a valid soap-mods plan\.yaml[\s\S]*- missing "goals"[\s\S]*- use "goals", not "goal"/)
  expect(toasts.at(-1)).toMatch(/^plan\.yaml has 5 problems: missing "goals"/)
  // Windows 的路徑（反斜線）一樣檢查。
  const onWindows = await $.tool.call({ tool: 'Write', file_path: 'C:\\proj\\.soap\\tasks\\login\\plan.yaml', content: 'goal: x' })
  expect(onWindows.context?.at(-1)).toMatch(/is not a valid soap-mods plan\.yaml/)

  // Edit 修好之後：整份重讀，沒問題就不加東西。
  await $.tool.call({ tool: 'Write', file_path: plan, content: LOGIN.replace('goals:', 'goal:') })
  const fixed = await $.tool.call({ tool: 'Edit', file_path: plan, old_string: 'goal:', new_string: 'goals:' })
  expect(fixed.context ?? []).toEqual([])

  // 不是 .soap/tasks/<feature>/plan.yaml 的不看。
  const count = toasts.length
  const other = await $.tool.call({ tool: 'Write', file_path: '/proj/notes/plan.yaml', content: 'goal: x' })
  expect(other.context ?? []).toEqual([])
  expect(toasts).toHaveLength(count)
})
