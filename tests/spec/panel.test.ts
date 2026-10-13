import { expect, test } from 'claude-code/testing'

import { type TestOn, endTurn, fsEntry, mountPane, ok, posix, stubPanel } from '../test-fixtures'

const TASKS = '/proj/.soap/tasks'

const LOGIN = `description: >
  Users need SSO.
goals:
  - SSO signs the user in
constraints: []
related: []
verify:
  - npm test -- login.spec.ts
`

// .soap/tasks 底下的檔案：路徑（相對 /proj/.soap/tasks）→ 內容和修改時間。folders 是 feature 資料夾。
function tasks(on: TestOn, state: { folders: string[]; plans: Record<string, { text: string; mtimeMs: number }> }) {
  stubPanel(on, { root: '/proj' })
  on('process.run', () => ok(''))
  on('fs.exists', (_$, e) => ({ value: posix(e.path) === TASKS && state.folders.length > 0 }))
  on('fs.list', (_$, e) => ({ value: posix(e.path) === TASKS ? state.folders.map(n => fsEntry(n, 'dir')) : [] }))
  on('fs.stat', (_$, e) => {
    const plan = state.plans[posix(e.path)?.slice(TASKS.length + 1) ?? '']
    if (plan === undefined) throw new Error('ENOENT')

    return { value: { kind: 'file', size: plan.text.length, mtimeMs: plan.mtimeMs, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const plan = state.plans[posix(e.path)?.slice(TASKS.length + 1) ?? '']
    if (plan === undefined) throw new Error('ENOENT')

    return { value: plan.text }
  })
}

test('the Spec tab lists the plans newest first, opens one to its Description, Goals and Verify, and b goes back', async ($, on) => {
  const state = {
    folders: ['login', 'search', 'draft'],
    plans: {
      'login/plan.yaml': { text: LOGIN, mtimeMs: 1 },
      'search/plan.yaml': { text: 'description: x\ngoal:\n  - y\n', mtimeMs: 5 },
    } as Record<string, { text: string; mtimeMs: number }>,
  }
  tasks(on, state)

  const ui = await mountPane($)
  // Services 右邊多一個 Spec。
  expect(await ui.find({ key: 'tab:spec' })).toBeDefined()
  await ui.press({ key: 'tab:spec' })
  const rows = (await ui.findAll({ type: 'Button' })).map(b => b.props.key).filter(k => String(k).startsWith('spec:item:'))
  expect(rows).toEqual(['spec:item:search', 'spec:item:login', 'spec:item:draft'])
  expect(await ui.find({ type: 'Text', text: 'no plan.yaml' })).toBeDefined()

  await ui.press({ key: 'spec:item:login' })
  expect((await ui.find({ key: 'spec:back' }))?.props).toMatchObject({ label: '← Back', hotkey: 'b' })
  for (const text of ['Description', 'Users need SSO.', 'Goals', 'SSO signs the user in', 'Verify', 'npm test -- login.spec.ts']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: /has problems/ })).toBeUndefined()

  // 格式不對的：紅字列出哪裡不對，讀得到的照樣畫。
  await ui.press({ key: 'spec:back' })
  await ui.press({ key: 'spec:item:search' })
  expect(await ui.find({ type: 'Text', text: '.soap/tasks/search/plan.yaml has problems:' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'use "goals", not "goal"' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'x' })).toBeDefined()

  // 沒有 plan.yaml 的資料夾：說讀不到。
  await ui.press({ key: 'spec:back' })
  await ui.press({ key: 'spec:item:draft' })
  expect(await ui.find({ type: 'Text', text: /^Couldn't read \.soap\/tasks\/draft\/plan\.yaml/ })).toBeDefined()
  await ui.press({ key: 'spec:back' })
  expect(await ui.find({ key: 'spec:item:login' })).toBeDefined()
  await ui.unmount()
})

test('with no .soap/tasks the Spec tab says to run /soap-mods:plan, and at turn end it picks up a new plan and rereads the open one', async ($, on) => {
  const state = { folders: [] as string[], plans: {} as Record<string, { text: string; mtimeMs: number }> }
  tasks(on, state)

  const ui = await mountPane($)
  await ui.press({ key: 'tab:spec' })
  expect(await ui.find({ type: 'Text', text: 'No specs yet. Run /soap-mods:plan to write one.' })).toBeDefined()

  // Claude 跑了 /soap-mods:plan：回合結束後清單出現。
  state.folders = ['login']
  state.plans['login/plan.yaml'] = { text: LOGIN, mtimeMs: 1 }
  await endTurn($, ui)
  await ui.press({ key: 'spec:item:login' })
  expect(await ui.find({ type: 'Text', text: 'SSO signs the user in' })).toBeDefined()

  // 改了打開的那份：重讀。
  state.plans['login/plan.yaml'] = { text: LOGIN.replace('SSO signs the user in', 'Passkeys sign the user in'), mtimeMs: 2 }
  await endTurn($, ui)
  expect(await ui.find({ type: 'Text', text: 'Passkeys sign the user in' })).toBeDefined()
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
