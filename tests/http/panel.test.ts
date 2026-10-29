import type { HttpInit, ProcessRunInit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { FOLDER_COLOR, HTTP_ENV_KEY, HTTP_PROMPT_KEY, HTTP_STORE_KEY, HTTP_VIM_POLL_MS } from '../../hooks/config'
import { KEYCHAIN, toHex } from '../../hooks/secret'
import { type Pane, type TestOn, endTurn, fakeKeychain, fsEntry, json, mountPane, ok, openTool, posix, stubPanel, stubStore } from '../test-fixtures'

type Run = { argv: readonly string[]; init?: ProcessRunInit }
type Fetch = { url: string; init?: HttpInit }

const DIR = '/proj/.soap/http'
const PASSWORD = 'pä55 "word"'

const API_HTTP = `### Get a user
GET {{host}}/users/1
Accept: application/json

### Log in
# @capture token = body.data.token
POST {{host}}/login HTTP/1.1
Content-Type: application/json

{ "user": "me", "password": "{{password}}" }

### Me
GET {{host}}/me
Authorization: Bearer {{token}}
`

const page = (ui: Pane, id: 'api' | 'env') => ui.press({ key: `http:page:${id}` })

// Environment 換用另一個環境：回環境清單（開著一個環境的話），點它。
async function useEnv(ui: Pane, env: string) {
  await page(ui, 'env')
  if ((await ui.find({ key: 'http:env:back' })) !== undefined) await ui.press({ key: 'http:env:back' })
  await ui.press({ key: `http:env:${env}` })
}

const ENV = JSON.stringify({ $shared: { version: 'v1' }, dev: { host: 'http://localhost:3000' }, prod: { host: 'https://api.example.com' } })

// HTTP 子分頁要的引擎回應：session 資料夾 root（預設 /proj），它的 .soap/http 的檔案（給了才有這個資料夾）、$.store 放在記憶體、Keychain 是 fakeKeychain，
// http.fetch 交給 answer（沒給就 200 回 { id: 1 }），curl 交給 curl（拿 stdin 的設定），rm 刪掉那個檔，osascript 是開了 vim 的視窗。記下每個程序、每次 fetch、toast。
function httpWorld(
  on: TestOn,
  { files, answer, curl, root = '/proj' }: { files?: Record<string, string>; answer?: (f: Fetch) => unknown; curl?: (config: string) => unknown; root?: string | (() => string) } = {},
) {
  const store: Record<string, unknown> = {}
  const keychain = fakeKeychain()
  const runs: Run[] = []
  const fetches: Fetch[] = []
  const toasts: string[] = []
  // hold：給了就讓列出 .soap/http 等它（重讀到一半）。
  const state: { files: Record<string, string> | undefined; hold?: Promise<void> } = { files }
  const at = (path: string | undefined) => posix(path)?.slice(DIR.length + 1) ?? ''
  stubPanel(on, { root, now: null })
  const clock = mock.clock(on)
  stubStore(on, store)
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))

    return { value: undefined }
  })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', (_$, e) => ({ value: state.files !== undefined && (posix(e.path) === DIR || state.files[at(e.path)] !== undefined) }))
  // 一層資料夾：.soap/http 列出檔案和資料夾，資料夾列出它的檔案。
  on('fs.list', async (_$, e) => {
    const path = posix(e.path) ?? ''
    if (path !== DIR && !path.startsWith(`${DIR}/`)) return { value: [] }
    await state.hold
    if (state.files === undefined) throw new Error('ENOENT')
    const names = Object.keys(state.files)
    if (path !== DIR) return { value: names.filter(n => n.startsWith(`${at(path)}/`)).map(n => fsEntry(n.slice(at(path).length + 1))) }
    const folders = [...new Set(names.filter(n => n.includes('/')).map(n => n.split('/')[0] ?? ''))]

    return { value: [...names.filter(n => !n.includes('/')).map(n => fsEntry(n)), ...folders.map(f => fsEntry(f, 'dir'))] }
  })
  on('fs.read', (_$, e) => {
    const text = state.files?.[at(e.path)]
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.write', (_$, e) => {
    state.files = { ...state.files, [at(e.path)]: e.text }

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push(e)
    if (e.argv[0] === 'curl') return (curl?.(e.init?.stdin ?? '') ?? ok('')) as never
    // Edit in vim 開的 Terminal 視窗是 42。
    if (e.argv[0] === 'osascript') return ok(e.argv.includes('return id of front window') ? '42\n' : '')
    if (e.argv[0] === 'rm') {
      const { [at(e.argv.at(-1)) ?? '']: _, ...rest } = state.files ?? {}
      state.files = rest

      return ok('')
    }

    return keychain.run(e) ?? ok('')
  })
  on('http.fetch', (_$, e) => {
    fetches.push(e)

    return (answer?.(e) ?? json(200, { id: 1 }, { 'content-type': 'application/json' })) as never
  })

  return { store, keychain, runs, fetches, toasts, clock, state }
}

const texts = async (ui: Pane) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
const codes = async (ui: Pane) => (await ui.findAll({ type: 'Code' })).map(c => String(c.props.source))
// 列表上請求那幾列的 key，照畫的順序。
const reqRows = async (ui: Pane) => (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('http:req:'))

test('the top tabs are Files, Git, Tools and Docs; with no .soap/http the HTTP sub tab offers New, with no hints', async ($, on) => {
  httpWorld(on)
  const ui = await mountPane($)
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('tab:'))).toEqual(['tab:files', 'tab:git', 'tab:tools', 'tab:spec'])
  await openTool(ui, 'http')
  expect(await ui.find({ type: 'Text', text: 'No requests yet.' })).toBeDefined()
  expect(await ui.find({ key: 'http:new' })).toBeDefined()
  expect(await codes(ui)).toEqual([])
  await page(ui, 'env')
  expect(await ui.find({ key: 'http:env-add' })).toBeDefined()
  expect(await ui.find({ key: 'http:var-new' })).toBeUndefined()
  expect(await codes(ui)).toEqual([])
  await ui.unmount()
})

test('the HTTP sub tab stays in the session folder after the session moves into a worktree', async ($, on) => {
  let root = '/proj'
  httpWorld(on, { files: { 'api.http': API_HTTP }, root: () => root })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  expect(await reqRows(ui)).toHaveLength(3)
  root = '/proj/.claude/worktrees/fix'
  await endTurn($, ui)
  expect(await reqRows(ui)).toHaveLength(3)
  await ui.unmount()
})

// Edit in vim：按了開新視窗的 vim（osascript），把暫存檔改成 text，isDone 時也寫 done（vim 結束），等面板讀到。
async function vimEdit(ui: Pane, world: ReturnType<typeof httpWorld>, text: string, isDone = true) {
  if ((await label(ui, 'http:draft:vim')) === 'Edit in vim') await ui.press({ key: 'http:draft:vim' })
  const tmp = Object.keys(world.state.files ?? {}).find(f => f.startsWith('.edit/') && f.endsWith('.http')) ?? ''
  world.state.files = { ...world.state.files, [tmp]: `${text}\n`, ...(isDone ? { [tmp.replace(/\.http$/, '.done')]: '' } : {}) }
  await world.clock.advance(HTTP_VIM_POLL_MS)
  for (let i = 0; i < 20; i++) await world.clock.advance(0)
}

const label = async (ui: Pane, key: string) => String((await ui.find({ key }))?.props.label)
const shown = async (ui: Pane) => (await codes(ui))[0]

test('New writes a request into its own file under .soap/http, the name being the file name without .http', async ($, on) => {
  const world = httpWorld(on)
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await ui.press({ key: 'http:new' })
  expect(await shown(ui)).toBe('GET https://example.com')
  // 名稱只能是 .soap/http 底下的一個檔：../x 不寫，說哪裡不對。
  await ui.input({ key: 'http:draft:file', text: '../x' })
  expect(await ui.find({ type: 'Text', text: /^A name has only letters/ })).toBeDefined()
  expect(world.state.files).toBeUndefined()

  // 打字跟著存草稿，Save 拿那份；沒寫 ### 的補一行，檔名補 .http。
  await ui.input({ key: 'http:draft:file', text: 'users', kind: 'change' })
  await vimEdit(ui, world, 'GET https://x.test/users')
  expect(await shown(ui)).toBe('GET https://x.test/users')
  await ui.press({ key: 'http:draft:save' })
  expect(world.state.files).toEqual({ 'users.http': '###\nGET https://x.test/users\n' })
  // 存完回清單，一列是名稱（沒有 .http）。
  expect(world.toasts).toContain('Saved users')
  expect(await ui.find({ key: 'http:draft:save' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'users' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'users.http' })).toBeUndefined()

  // 名稱已經有了：不寫，不接到那個檔後面；Name 按 Enter 就存。
  await ui.press({ key: 'http:new' })
  await vimEdit(ui, world, 'GET https://x.test/two')
  await ui.input({ key: 'http:draft:file', text: 'users' })
  expect(await ui.find({ type: 'Text', text: 'There is already users; pick another name.' })).toBeDefined()
  await ui.input({ key: 'http:draft:file', text: 'two' })
  expect(world.state.files).toEqual({ 'users.http': '###\nGET https://x.test/users\n', 'two.http': '###\nGET https://x.test/two\n' })
  await ui.unmount()
})

test("Edit rewrites only the opened request's block, keeping CRLF; a file changed meanwhile is not overwritten; Delete takes two presses", async ($, on) => {
  const world = httpWorld(on, { files: { 'api.http': '### A\r\nGET https://x.test/a\r\n\r\n### B\r\nGET https://x.test/b\r\n' } })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  // 點一列直接編輯：它那段的原文。
  await ui.press({ key: 'http:req:api.http#0' })
  expect(await shown(ui)).toBe('### A\nGET https://x.test/a')
  expect(await ui.find({ key: 'http:send' })).toBeUndefined()
  await vimEdit(ui, world, '### A2\nPOST https://x.test/a2\nX-Y: 1')
  await ui.press({ key: 'http:draft:save' })
  expect(world.state.files?.['api.http']).toBe('### A2\r\nPOST https://x.test/a2\r\nX-Y: 1\r\n\r\n### B\r\nGET https://x.test/b\r\n')
  // 存完回清單。
  expect(await ui.find({ type: 'Text', text: 'A2' })).toBeDefined()
  expect(await ui.find({ key: 'http:draft:save' })).toBeUndefined()

  // 編輯期間檔案被改了：不寫，請重開。
  await ui.press({ key: 'http:req:api.http#0' })
  world.state.files = { 'api.http': '### A3\r\nGET https://x.test/a3\r\n\r\n### B\r\nGET https://x.test/b\r\n' }
  await vimEdit(ui, world, '### mine\nGET https://x.test/mine')
  await ui.press({ key: 'http:draft:save' })
  expect(await ui.find({ type: 'Text', text: 'api.http changed since it was read; Cancel and open the request again.' })).toBeDefined()
  expect(world.state.files['api.http']).toContain('A3')
  await ui.press({ key: 'http:draft:cancel' })

  // 回合結束重讀後，在編輯頁刪第二個：按一次待確認，再按才刪，回清單。
  await endTurn($, ui)
  await ui.press({ key: 'http:req:api.http#1' })
  await ui.press({ key: 'http:delete' })
  expect(world.state.files['api.http']).toContain('### B')
  await ui.press({ key: 'http:delete' })
  expect(world.state.files['api.http']).toBe('### A3\r\nGET https://x.test/a3\r\n')
  expect(await reqRows(ui)).toEqual(['http:req:api.http#0'])
  await ui.unmount()
})

test('Edit in vim opens the block in a new Terminal window, shows each save there, and closes the window when vim ends', async ($, on) => {
  const world = httpWorld(on, { files: { 'a.http': '### A\nGET https://x.test/a\n' } })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await ui.press({ key: 'http:req:a.http#0' })
  await ui.press({ key: 'http:draft:vim' })
  const tmp = Object.keys(world.state.files ?? {}).find(f => f.startsWith('.edit/')) ?? ''
  expect(world.state.files?.[tmp]).toBe('### A\nGET https://x.test/a\n')
  // 路徑從參數給 osascript，不拼進 AppleScript。
  const open = world.runs.find(r => r.argv[0] === 'osascript')?.argv ?? []
  expect(open.slice(-2)).toEqual([`${DIR}/${tmp}`, `${DIR}/${tmp.replace(/\.http$/, '.done')}`])
  expect(await label(ui, 'http:draft:vim')).toBe('Editing in vim…')

  // vim 裡 :w 就跟到面板，還開著。
  await vimEdit(ui, world, '### A\nGET https://x.test/saved', false)
  expect(await shown(ui)).toBe('### A\nGET https://x.test/saved')
  expect(await label(ui, 'http:draft:vim')).toBe('Editing in vim…')
  // :wq：讀最後一次，關掉那個視窗，暫存檔刪掉。
  await vimEdit(ui, world, '### A\nGET https://x.test/done')
  expect(await shown(ui)).toBe('### A\nGET https://x.test/done')
  expect(await label(ui, 'http:draft:vim')).toBe('Edit in vim')
  expect(world.runs.filter(r => r.argv[0] === 'osascript').at(-1)?.argv.at(-1)).toBe('42')
  expect(Object.keys(world.state.files ?? {})).toEqual(['a.http'])
  await ui.press({ key: 'http:draft:save' })
  expect(world.state.files?.['a.http']).toBe('### A\nGET https://x.test/done\n')
  await ui.unmount()
})

test('Save goes back to the list only once the files are read again, so the row pressed next opens what was saved', async ($, on) => {
  const world = httpWorld(on, { files: { 'a.http': '###\nGET https://x.test/old\n' } })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await ui.press({ key: 'http:req:a.http#0' })
  await vimEdit(ui, world, '###\nGET https://x.test/new')
  let release = () => undefined as void
  world.state.hold = new Promise(resolve => {
    release = resolve
  })
  const saving = ui.press({ key: 'http:draft:save' })
  for (let i = 0; i < 100 && !(world.state.files?.['a.http'] ?? '').includes('new'); i++) await world.clock.advance(0)
  expect(world.state.files?.['a.http']).toBe('###\nGET https://x.test/new\n')
  // 檔案寫了、還在重讀：停在編輯頁，清單還沒回來。
  expect(await ui.find({ type: 'Text', text: 'Saving…' })).toBeDefined()
  expect(await ui.find({ key: 'http:req:a.http#0' })).toBeUndefined()
  release()
  await saving
  await ui.press({ key: 'http:req:a.http#0' })
  expect(await shown(ui)).toBe('###\nGET https://x.test/new')
  await ui.unmount()
})

test('a request goes in a folder picked or added in the editor; folders fold on the list, and moving one out moves its file', async ($, on) => {
  const world = httpWorld(on, { files: { 'a.http': '###\nGET https://x.test/a\n', '賽事/刷新.http': '###\nGET https://x.test/r\n' } })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  // 資料夾在上面，沒放資料夾的在下面。
  expect(await reqRows(ui)).toEqual(['http:req:賽事/刷新.http#0', 'http:req:a.http#0'])
  expect(await label(ui, 'http:folder:賽事')).toBe('▾ 賽事 (1)')
  // 資料夾的顏色同 Files、Wiki 的資料夾；列表的空白畫成不換行空白。
  expect((await ui.find({ type: 'Text', text: '▾ 賽事 (1)' }))?.props.color).toBe(FOLDER_COLOR)
  expect(await ui.find({ type: 'Text', text: '刷新' })).toBeDefined()

  // + New folder：打名稱，存的時候建立。
  await ui.press({ key: 'http:new' })
  await ui.press({ key: 'http:draft:folder' })
  expect(await label(ui, 'http:draft:folder:賽事')).toMatch(/賽事/)
  await ui.press({ key: 'http:draft:folder::new' })
  await ui.input({ key: 'http:draft:new-folder', text: '會員', kind: 'change' })
  await ui.input({ key: 'http:draft:file', text: '登入' })
  expect(world.state.files?.['會員/登入.http']).toBe('###\nGET https://example.com\n')
  expect(await reqRows(ui)).toEqual(['http:req:會員/登入.http#0', 'http:req:賽事/刷新.http#0', 'http:req:a.http#0'])

  // 收起來記著。
  await ui.press({ key: 'http:folder:賽事' })
  expect(await label(ui, 'http:folder:賽事')).toBe('▸ 賽事 (1)')
  expect(await reqRows(ui)).toEqual(['http:req:會員/登入.http#0', 'http:req:a.http#0'])

  // 打開是它的資料夾；選已有的資料夾就搬過去。
  await ui.press({ key: 'http:req:a.http#0' })
  await ui.press({ key: 'http:draft:folder' })
  await ui.press({ key: 'http:draft:folder:會員' })
  await ui.press({ key: 'http:draft:save' })
  expect(Object.keys(world.state.files ?? {}).sort()).toEqual(['會員/a.http', '會員/登入.http', '賽事/刷新.http'])
  expect(await label(ui, 'http:folder:會員')).toBe('▾ 會員 (2)')

  // 搬出去（None）：檔案回 .soap/http，空了的資料夾不列。
  await ui.press({ key: 'http:folder:賽事' })
  await ui.press({ key: 'http:req:賽事/刷新.http#0' })
  expect(await label(ui, 'http:draft:folder')).toMatch(/賽事/)
  await ui.press({ key: 'http:draft:folder' })
  await ui.press({ key: 'http:draft:folder:' })
  await ui.press({ key: 'http:draft:save' })
  expect(Object.keys(world.state.files ?? {}).sort()).toEqual(['刷新.http', '會員/a.http', '會員/登入.http'])
  expect(await ui.find({ key: 'http:folder:賽事' })).toBeUndefined()
  await ui.unmount()
})

test('the list searches names, methods and URLs, unfolding folders; Open shows .soap/http in Finder, making it first', async ($, on) => {
  const world = httpWorld(on, { files: { 'a.http': '###\nGET https://x.test/a\n', '賽事/刷新.http': '###\nPOST https://x.test/refresh\n' } })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await ui.press({ key: 'http:folder:賽事' })
  expect(await reqRows(ui)).toEqual(['http:req:a.http#0'])

  await ui.input({ key: 'http:search', text: 'post', kind: 'change' })
  expect(await reqRows(ui)).toEqual(['http:req:賽事/刷新.http#0'])
  await ui.input({ key: 'http:search', text: 'x.test/a', kind: 'change' })
  expect(await reqRows(ui)).toEqual(['http:req:a.http#0'])
  expect(await ui.find({ key: 'http:folder:賽事' })).toBeUndefined()
  await ui.input({ key: 'http:search', text: 'nothing', kind: 'change' })
  expect(await texts(ui)).toContain('No requests match.')
  await ui.press({ key: 'http:search:clear' })
  expect(await reqRows(ui)).toEqual(['http:req:a.http#0'])

  await ui.press({ key: 'http:open' })
  expect(world.runs.map(r => r.argv).filter(a => ['mkdir', 'open'].includes(a[0] ?? ''))).toEqual([
    ['mkdir', '-p', '--', DIR],
    ['open', DIR],
  ])
  expect(world.toasts).toEqual(['Opened in Finder'])
  await ui.unmount()
})

test('a multipart request is sent through curl, its settings on stdin, a file relative to its .http file', async ($, on) => {
  const world = httpWorld(on, {
    files: {
      'http-client.env.json': ENV,
      'a.png': '',
      'upload.http': [
        '###',
        'POST {{host}}/upload',
        'Content-Type: multipart/form-data; boundary=----SoapBoundary',
        '',
        '------SoapBoundary',
        'Content-Disposition: form-data; name="title"',
        '',
        'hi',
        '------SoapBoundary',
        'Content-Disposition: form-data; name="file"; filename="a.png"',
        '',
        '< ./a.png',
        '------SoapBoundary--',
        '',
      ].join('\n'),
    },
    curl: () => ok('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Type: application/json\r\n\r\n{"id":7}'),
  })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  // 送出走 curl，不是 $.http.fetch；Content-Type 不帶（curl 自己寫 boundary），100 Continue 跳過。
  await ui.press({ key: 'http:run:upload.http#0' })
  expect(world.fetches).toEqual([])
  const curls = world.runs.filter(r => r.argv[0] === 'curl')
  expect(curls.map(r => r.argv)).toEqual([['curl', '--config', '-']])
  const config = curls[0]?.init?.stdin ?? ''
  expect(config).toContain('request = "POST"\nurl = "http://localhost:3000/upload"\n')
  expect(config).toContain('form-string = "title=hi"\nform = "file=@\\"/proj/.soap/http/a.png\\""\n')
  expect(config).not.toContain('Content-Type')
  expect(await ui.find({ type: 'Text', text: '201' })).toBeDefined()
  expect(await codes(ui)).toContain('{\n  "id": 7\n}')
  await ui.unmount()
})

test('Environment lists the environments, one opens to its variables, and a variable opens to a name and a value field', async ($, on) => {
  const world = httpWorld(on, { files: { 'a.http': 'GET {{host}}/x\n' } })
  const envFile = () => JSON.parse(world.state.files?.['http-client.env.json'] ?? 'null') as unknown
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await page(ui, 'env')

  // 第一層：+ New 打開名稱的框；新增寫進檔案、選它、打開它。
  expect(await ui.find({ type: 'Text', text: 'No environments yet.' })).toBeDefined()
  expect(await ui.find({ key: 'http:new-env' })).toBeUndefined()
  await ui.press({ key: 'http:env-add' })
  await ui.input({ key: 'http:new-env', text: 'dev', kind: 'change' })
  await ui.press({ key: 'http:new-env:add' })
  expect(world.state.files?.['http-client.env.json']).toBe('{\n  "dev": {}\n}\n')
  expect(await ui.find({ type: 'Text', text: 'dev' })).toBeDefined()
  expect(await ui.find({ key: 'http:var-new' })).toBeDefined()
  await ui.press({ key: 'http:env:back' })
  expect((await ui.find({ type: 'Text', text: '■' }))?.props.color).toBe('success')

  // 第二層：點環境看它的變數；+ New 打開名稱、值兩行的框（第三層），打字跟著存，Save 寫檔，回變數清單。
  await ui.press({ key: 'http:env:dev' })
  expect(await ui.find({ type: 'Text', text: 'No variables yet.' })).toBeDefined()
  await ui.press({ key: 'http:var-new' })
  await ui.input({ key: 'http:var-draft:name', text: 'host', kind: 'change' })
  await ui.input({ key: 'http:var-draft:value', text: 'https://dev.test', kind: 'change' })
  await ui.press({ key: 'http:var-draft:save' })
  expect(envFile()).toEqual({ dev: { host: 'https://dev.test' } })
  expect(await ui.find({ key: 'http:var-draft:name' })).toBeUndefined()
  expect(await ui.find({ key: 'http:var-row:host' })).toBeDefined()
  // 整列是同一顆按鈕（名稱、值都在裡面），清單上也有垃圾桶。
  expect(String((await ui.find({ key: 'http:var-row:host' }))?.props.label)).toBe('host  https://dev.test')
  expect(await ui.find({ key: 'http:var-delete:host' })).toBeDefined()

  // 值格 Enter 就存。
  await ui.press({ key: 'http:var-new' })
  await ui.input({ key: 'http:var-draft:name', text: 'token', kind: 'change' })
  await ui.input({ key: 'http:var-draft:value', text: 't' })
  expect(envFile()).toEqual({ dev: { host: 'https://dev.test', token: 't' } })

  // 點一列改：名稱、值都帶進框；改名照原本的位置。
  await ui.press({ key: 'http:var-row:host' })
  expect((await ui.find({ key: 'http:var-draft:name' }))?.props.value).toBe('host')
  expect((await ui.find({ key: 'http:var-draft:value' }))?.props.value).toBe('https://dev.test')
  await ui.input({ key: 'http:var-draft:value', text: 'https://x.test', kind: 'change' })
  await ui.input({ key: 'http:var-draft:name', text: 'base' })
  expect(world.state.files?.['http-client.env.json']).toBe('{\n  "dev": {\n    "base": "https://x.test",\n    "token": "t"\n  }\n}\n')

  // 刪變數（在它的編輯畫面）、刪環境（清單那列）：都要按兩次。
  await ui.press({ key: 'http:var-row:token' })
  await ui.press({ key: 'http:var-delete:token' })
  expect(envFile()).toEqual({ dev: { base: 'https://x.test', token: 't' } })
  await ui.press({ key: 'http:var-delete:token' })
  expect(envFile()).toEqual({ dev: { base: 'https://x.test' } })
  expect(await ui.find({ key: 'http:var-row:token' })).toBeUndefined()
  await ui.press({ key: 'http:env:back' })
  await ui.press({ key: 'http:env-delete:dev' })
  await ui.press({ key: 'http:env-delete:dev' })
  expect(envFile()).toEqual({})
  expect(await ui.find({ key: 'http:env:dev' })).toBeUndefined()
  await ui.unmount()
})

test('requests are listed by file and ###; Run sends one with the picked environment filled in and shows the answer', async ($, on) => {
  const world = httpWorld(on, {
    files: { 'api.http': API_HTTP, 'http-client.env.json': ENV },
    answer: () => json(200, '{"id":1,"name":"Ada"}', { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'r1' }),
  })
  const ui = await mountPane($, 'desktop')
  await openTool(ui, 'http')
  const rows = await reqRows(ui)
  // 有好幾個請求的檔案：檔名當標題，底下一列一個。
  expect(rows).toEqual(['http:req:api.http#0', 'http:req:api.http#1', 'http:req:api.http#2'])
  expect(await ui.find({ type: 'Text', text: 'api' })).toBeDefined()
  // HTTP 底下一排 API | Environment；API 只寫目前的環境，選環境在 Environment。
  expect((await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => /^http:page:\w+$/.test(k))).toEqual(['http:page:api', 'http:page:env'])
  expect(await ui.find({ type: 'Text', text: 'Env: dev' })).toBeDefined()
  expect(await ui.find({ key: 'http:env:dev' })).toBeUndefined()

  // Run 送出，打開回應頁：一行方法和代換好的 URL。
  await ui.press({ key: 'http:run:api.http#0' })
  expect(await ui.find({ type: 'Text', text: 'http://localhost:3000/users/1' })).toBeDefined()
  expect(world.fetches.map(f => f.url)).toEqual(['http://localhost:3000/users/1'])

  // 換 prod：回 API 點開的請求還在，URL 跟著換，選的環境記在 store（依 session 資料夾）。
  await useEnv(ui, 'prod')
  await page(ui, 'api')
  expect(await ui.find({ type: 'Text', text: 'https://api.example.com/users/1' })).toBeDefined()
  expect(world.store[HTTP_ENV_KEY]).toEqual({ '/proj': 'prod' })

  // prod 也是按一次就送。
  await ui.press({ key: 'http:send' })
  expect(world.fetches).toHaveLength(2)
  expect(world.fetches[1]).toMatchObject({ url: 'https://api.example.com/users/1', init: { method: 'GET', headers: { Accept: 'application/json' } } })
  expect(world.fetches[1]?.init?.body).toBeUndefined()
  const status = await ui.find({ type: 'Text', text: '200' })
  expect(status?.props.color).toBe('success')
  expect(await ui.find({ type: 'Text', text: /^\d+ ms · 21 B$/ })).toBeDefined()
  // JSON 排版後畫。
  expect(await codes(ui)).toContain('{\n  "id": 1,\n  "name": "Ada"\n}')
  // headers 收著，按了才展開。
  expect(await ui.find({ type: 'Text', text: 'x-request-id:' })).toBeUndefined()
  await ui.press({ key: 'http:headers' })
  expect(await ui.find({ type: 'Text', text: 'x-request-id:' })).toBeDefined()
  await ui.unmount()
})

test('a # @prompt variable is filled in on the request page, kept by session folder for every environment, and Enter sends it without the JSON comments', async ($, on) => {
  const world = httpWorld(on, {
    files: {
      'http-client.env.json': ENV,
      'stream.http': [
        '### 開聊天室',
        '# @prompt RealMatchId 比賽 ID',
        'POST {{host}}/open',
        'Content-Type: application/json',
        '',
        '{',
        '  "SmartUrl": "https://storage.googleapis.com/", // SampleSite(4227600)',
        '  /* 需隱藏的訊源 */',
        '  "MatchInfo": {',
        '    "RealMatchId": {{RealMatchId}},',
        '    // "AnchorId": 13',
        '  },',
        '}',
        '',
      ].join('\n'),
    },
  })
  // 存在 $.store（重開還在），依 session 資料夾：別的資料夾填的不算。
  world.store[HTTP_PROMPT_KEY] = { '/other': { RealMatchId: '1' } }
  const ui = await mountPane($, 'desktop')
  await openTool(ui, 'http')
  // 還沒填：Run 打開回應頁，說要先填，不送。
  await ui.press({ key: 'http:run:stream.http#0' })
  expect(world.fetches).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Fill in {{RealMatchId}} first.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '比賽 ID' })).toBeDefined()
  // 不叫人去 Environment 貼。
  expect(await ui.find({ key: 'http:to-env' })).toBeUndefined()

  // 打字跟著存，Enter 就送出；值照寫進 body（數字不加引號）。註解和它留下的逗號不送（伺服器的 JSON 不收），字串裡的 // 照留。
  await ui.input({ key: 'http:prompt:RealMatchId', text: '136623254' })
  const sent = { SmartUrl: 'https://storage.googleapis.com/', MatchInfo: { RealMatchId: 136623254 } }
  expect(JSON.parse(String(world.fetches[0]?.init?.body))).toEqual(sent)
  expect(world.store[HTTP_PROMPT_KEY]).toEqual({ '/other': { RealMatchId: '1' }, '/proj': { RealMatchId: '136623254' } })

  // 換環境也是同一個值；Environment 不把它列成機密。
  await useEnv(ui, 'prod')
  expect(await ui.find({ key: 'http:var:RealMatchId' })).toBeUndefined()
  await page(ui, 'api')
  expect((await ui.find({ key: 'http:prompt:RealMatchId' }))?.props.value).toBe('136623254')
  await ui.press({ key: 'http:send' })
  expect(world.fetches.map(f => f.url)).toEqual(['http://localhost:3000/open', 'https://api.example.com/open'])
  expect(JSON.parse(String(world.fetches[1]?.init?.body))).toEqual(sent)
  await ui.unmount()
})

test('an error status is red, and a request that cannot connect says so', async ($, on) => {
  let mode = 'notFound'
  httpWorld(on, {
    files: { 'a.http': 'GET http://localhost:9/x\n' },
    answer: () => {
      if (mode === 'notFound') return json(404, 'nope', { 'content-type': 'text/plain' })
      return { deny: 'connect ECONNREFUSED 127.0.0.1:9' }
    },
  })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await ui.press({ key: 'http:run:a.http#0' })
  expect((await ui.find({ type: 'Text', text: '404' }))?.props.color).toBe('error')
  expect(await codes(ui)).toContain('nope')

  mode = 'down'
  await ui.press({ key: 'http:send' })
  expect(await ui.find({ type: 'Text', text: /^Couldn't reach http:\/\/localhost:9\/x: .*ECONNREFUSED/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '404' })).toBeUndefined()
  await ui.unmount()
})

test('a variable the env file lacks is a secret pasted on the panel: kept in the Keychain by folder and environment, masked, read once to send', async ($, on) => {
  const world = httpWorld(on, { files: { 'api.http': API_HTTP, 'http-client.env.json': ENV } })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  // 沒有值就不送。
  await ui.press({ key: 'http:run:api.http#1' })
  expect(await ui.find({ type: 'Text', text: 'No value for {{password}}: paste it under' })).toBeDefined()
  expect(world.fetches).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: 'Paste a value for {{password}} first.' })).toBeDefined()

  // 機密在 Environment 貼。
  await ui.press({ key: 'http:to-env' })
  expect(await ui.find({ type: 'Text', text: 'no value' })).toBeDefined()
  await ui.input({ key: 'http:var:password', text: PASSWORD })
  expect(await ui.find({ type: 'Text', text: 'saved' })).toBeDefined()
  expect(world.toasts).toContain('Saved {{password}} for dev')
  // 值只在 Keychain（加了 -T ""），不在 store、不在命令列上，畫面上是 ••••••。
  const hex = toHex(PASSWORD)
  expect(Object.values(world.keychain.items)).toEqual([hex])
  expect(world.runs.find(r => r.argv[0] === 'security' && r.argv[1] === '-i')?.init?.stdin).toContain(' -T "" ')
  expect(world.runs.some(r => r.argv.some(a => a.includes(PASSWORD) || a.includes(hex)))).toBe(false)
  expect(JSON.stringify(world.store)).not.toContain(hex)
  expect(world.store[HTTP_STORE_KEY]).toEqual({ '/proj': { dev: { password: KEYCHAIN } } })
  await page(ui, 'api')

  // 送出時代進去；存的時候已經在記憶體裡，Keychain 一次都不用問。
  await ui.press({ key: 'http:send' })
  expect(world.fetches.map(f => f.init?.body)).toEqual([`{ "user": "me", "password": "${PASSWORD}" }`])
  expect(world.fetches[0]?.init?.method).toBe('POST')
  expect(world.keychain.counts.reads).toBe(0)

  // prod 是另一份：沒有值。
  await useEnv(ui, 'prod')
  expect(await ui.find({ type: 'Text', text: 'no value' })).toBeDefined()
  await useEnv(ui, 'dev')

  // Change 打開框換值；刪除要按兩次，連 Keychain 的項目。
  await ui.press({ key: 'http:var:change:password' })
  expect(await ui.find({ key: 'http:var:password' })).toBeDefined()
  await ui.press({ key: 'http:var:cancel:password' })
  await ui.press({ key: 'http:var:delete:password' })
  expect(Object.keys(world.keychain.items)).toHaveLength(1)
  await ui.press({ key: 'http:var:delete:password' })
  expect(Object.keys(world.keychain.items)).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: 'no value' })).toBeDefined()
  expect(world.store[HTTP_STORE_KEY]).toEqual({ '/proj': { dev: {} } })
  await ui.unmount()
})

test('a secret saved in an earlier session is read from the Keychain once, on the first Send', async ($, on) => {
  const world = httpWorld(on, { files: { 'a.http': 'GET https://x.test/me\nAuthorization: Bearer {{apiKey}}\n' } })
  // 機密沒有環境檔時存在環境 '' 底下。
  world.store[HTTP_STORE_KEY] = { '/proj': { '': { apiKey: KEYCHAIN } } }
  world.keychain.items[toHex('/proj\n\napiKey')] = toHex('k-123')
  const ui = await mountPane($)
  await openTool(ui, 'http')
  expect(world.keychain.counts.reads).toBe(0)
  await ui.press({ key: 'http:run:a.http#0' })
  await ui.press({ key: 'http:send' })
  expect(world.fetches.map(f => f.init?.headers?.Authorization)).toEqual(['Bearer k-123', 'Bearer k-123'])
  expect(world.keychain.counts.reads).toBe(1)
  await ui.unmount()
})

test('@capture keeps a value of a 2xx JSON answer as a variable of the environment, in memory only, for the next requests', async ($, on) => {
  const world = httpWorld(on, {
    files: { 'api.http': API_HTTP, 'http-client.env.json': ENV },
    answer: f => (f.url.endsWith('/login') ? json(200, { data: { token: 'tok-1' } }) : json(200, { me: true })),
  })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await ui.press({ key: 'http:run:api.http#1' })
  await ui.press({ key: 'http:to-env' })
  await ui.input({ key: 'http:var:password', text: PASSWORD })
  await page(ui, 'api')
  await ui.press({ key: 'http:send' })
  expect(await ui.find({ type: 'Text', text: 'Captured {{token}}' })).toBeDefined()

  await ui.press({ key: 'http:back' })
  await ui.press({ key: 'http:run:api.http#2' })
  expect(world.fetches.at(-1)?.init?.headers?.Authorization).toBe('Bearer tok-1')
  // 只放記憶體：不在 store，也沒寫檔。
  expect(JSON.stringify(world.store)).not.toContain('tok-1')
  // Environment 也列出取到的值。
  await page(ui, 'env')
  expect(await ui.find({ type: 'Text', text: /tok-1/ })).toBeDefined()

  // 另一個環境沒有它。
  await useEnv(ui, 'prod')
  await page(ui, 'api')
  expect(await ui.find({ type: 'Text', text: 'No value for {{token}}: paste it under' })).toBeDefined()
  await ui.unmount()
})

test('a .http file Claude writes shows when its turn ends', async ($, on) => {
  const world = httpWorld(on, { files: {} })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  expect(await ui.find({ type: 'Text', text: /^No requests yet/ })).toBeDefined()
  world.state.files = { 'new.http': '### Ping\nGET https://x.test/ping\n' }
  await endTurn($, ui)
  expect(await ui.find({ key: 'http:req:new.http#0' })).toBeDefined()
  expect(await texts(ui)).toContain('new')
  await ui.unmount()
})

test("Claude's Bash may not read or use the HTTP secrets", async ($, on) => {
  httpWorld(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } as never }))
  for (const command of ['security find-generic-password -s soap-mods-http -w', "jq '.\"http.secrets\"' store.json"]) {
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toContain('Blocked by soap-mods')
  }
})

test('a top tab kept as services or db before the reload lands on that Tools sub tab', async ($, on) => {
  httpWorld(on)
  // 熱重載前的程式存的值：上層 Tab 是 db、子分頁沒有 tools。寫過一次就照實讀。
  const old: Record<string, unknown> = { tab: 'db', subTabs: { git: 'diff', spec: 'spec' } }
  on('state.set', (_$, e, next) => {
    delete old[e.key]

    return next(e)
  })
  on('state.get', (_$, e, next) => (e.plugin === 'soap-mods' && e.key in old ? { value: { value: old[e.key], version: 1 } } : next(e)) as never)
  const ui = await mountPane($, 'terminal', 'files')
  expect((await ui.find({ key: 'tab:tools' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'sub:db' }))?.props.variant).toBe('primary')
  expect(await ui.find({ type: 'Text', text: 'No connections yet.' })).toBeDefined()
  // 換分頁照常。
  await ui.press({ key: 'sub:services' })
  expect((await ui.find({ key: 'sub:services' }))?.props.variant).toBe('primary')
  await ui.press({ key: 'tab:git' })
  await ui.press({ key: 'tab:tools' })
  expect((await ui.find({ key: 'sub:services' }))?.props.variant).toBe('primary')
  await ui.unmount()
})

test('a .http file in REST Client or JetBrains form lists its named requests and sends them without comments or handlers', async ($, on) => {
  const text = [
    '@host = ignored',
    '# @name first',
    'https://x.test/a',
    '',
    '###',
    '// @name second',
    'post https://x.test/b',
    'X-One: 1',
    '# a comment',
    'X-Two:2',
    '',
    '{"a":1}',
    '',
    '> {% client.global.set("x", response.body.x) %}',
    '',
    '### only a comment',
    '# nothing here',
  ].join('\r\n')
  const world = httpWorld(on, { files: { 'f.http': text } })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  expect(await reqRows(ui)).toEqual(['http:req:f.http#0', 'http:req:f.http#1'])
  expect(await texts(ui)).toEqual(expect.arrayContaining(['first', 'second']))
  await ui.press({ key: 'http:run:f.http#0' })
  await ui.press({ key: 'http:back' })
  await ui.press({ key: 'http:run:f.http#1' })
  expect(world.fetches).toEqual([
    { url: 'https://x.test/a', init: { method: 'GET', headers: {} } },
    { url: 'https://x.test/b', init: { method: 'POST', headers: { 'X-One': '1', 'X-Two': '2' }, body: '{"a":1}' } },
  ])
  await ui.unmount()
})
