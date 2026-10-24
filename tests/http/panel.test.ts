import type { HttpInit, ProcessRunInit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { HTTP_ENV_KEY, HTTP_STORE_KEY, HTTP_TIMEOUT_MS } from '../../hooks/config'
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
# @capture missing = body.nope
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

// HTTP 子分頁要的引擎回應：/proj/.soap/http 的檔案（給了才有這個資料夾）、$.store 放在記憶體、Keychain 是 fakeKeychain，
// http.fetch 交給 answer（沒給就 200 回 { id: 1 }）。記下每個程序、每次 fetch、toast。
function httpWorld(on: TestOn, { files, answer }: { files?: Record<string, string>; answer?: (f: Fetch) => unknown } = {}) {
  const store: Record<string, unknown> = {}
  const keychain = fakeKeychain()
  const runs: Run[] = []
  const fetches: Fetch[] = []
  const toasts: string[] = []
  const state = { files }
  const at = (path: string | undefined) => posix(path)?.slice(DIR.length + 1) ?? ''
  stubPanel(on, { root: '/proj', now: null })
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
  on('fs.list', (_$, e) => {
    if (posix(e.path) !== DIR) return { value: [] }
    if (state.files === undefined) throw new Error('ENOENT')

    return { value: Object.keys(state.files).map(name => fsEntry(name)) }
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

test('New writes a request into .soap/http: a new file by its name, then at the end of the first file', async ($, on) => {
  const world = httpWorld(on)
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await ui.press({ key: 'http:new' })
  expect((await ui.find({ key: 'http:draft:text' }))?.props.value).toBe('### New request\nGET https://')
  expect((await ui.find({ key: 'http:draft:file' }))?.props.value).toBe('requests.http')

  // 只有註解、壞掉的檔名：不寫，說哪裡不對。
  await ui.input({ key: 'http:draft:text', text: '# just a note' })
  expect(await ui.find({ type: 'Text', text: 'Write a request: a method and a URL, like GET https://example.com.' })).toBeDefined()
  await ui.input({ key: 'http:draft:file', text: '../x', kind: 'change' })
  await ui.input({ key: 'http:draft:text', text: 'GET https://x.test/users' })
  expect(await ui.find({ type: 'Text', text: /^A file name has only letters/ })).toBeDefined()
  expect(world.state.files).toBeUndefined()

  // 打字跟著存草稿，Save 拿那份；沒寫 ### 的補一行，檔名補 .http。
  await ui.input({ key: 'http:draft:file', text: 'users', kind: 'change' })
  await ui.input({ key: 'http:draft:text', text: 'GET https://x.test/users', kind: 'change' })
  await ui.press({ key: 'http:draft:save' })
  expect(world.state.files).toEqual({ 'users.http': '###\nGET https://x.test/users\n' })
  // 存完點開它。
  expect(await ui.find({ type: 'Text', text: 'https://x.test/users' })).toBeDefined()
  expect(await ui.find({ key: 'http:draft:text' })).toBeUndefined()

  await ui.press({ key: 'http:back' })
  await ui.press({ key: 'http:new' })
  expect((await ui.find({ key: 'http:draft:file' }))?.props.value).toBe('users.http')
  await ui.input({ key: 'http:draft:text', text: '### Two\nPOST https://x.test/two\n\n{}' })
  expect(world.state.files?.['users.http']).toBe('###\nGET https://x.test/users\n\n### Two\nPOST https://x.test/two\n\n{}\n')
  expect(await ui.find({ type: 'Text', text: 'Two' })).toBeDefined()

  // Cancel 不寫。
  await ui.press({ key: 'http:back' })
  await ui.press({ key: 'http:new' })
  await ui.press({ key: 'http:draft:cancel' })
  expect(await ui.find({ key: 'http:draft:text' })).toBeUndefined()
  expect(Object.keys(world.state.files ?? {})).toEqual(['users.http'])
  await ui.unmount()
})

test("Edit rewrites only the opened request's block, keeping CRLF; a file changed meanwhile is not overwritten; Delete takes two presses", async ($, on) => {
  const world = httpWorld(on, { files: { 'api.http': '### A\r\nGET https://x.test/a\r\n\r\n### B\r\nGET https://x.test/b\r\n' } })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await ui.press({ key: 'http:req:api.http#0' })
  await ui.press({ key: 'http:edit' })
  expect((await ui.find({ key: 'http:draft:text' }))?.props.value).toBe('### A\nGET https://x.test/a')
  expect(await ui.find({ key: 'http:send' })).toBeUndefined()
  await ui.input({ key: 'http:draft:text', text: '### A2\nPOST https://x.test/a2\nX-Y: 1' })
  expect(world.state.files?.['api.http']).toBe('### A2\r\nPOST https://x.test/a2\r\nX-Y: 1\r\n\r\n### B\r\nGET https://x.test/b\r\n')
  expect(await ui.find({ type: 'Text', text: 'A2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'X-Y:' })).toBeDefined()

  // 編輯期間檔案被改了：不寫，請重開。
  await ui.press({ key: 'http:edit' })
  world.state.files = { 'api.http': '### A3\r\nGET https://x.test/a3\r\n\r\n### B\r\nGET https://x.test/b\r\n' }
  await ui.input({ key: 'http:draft:text', text: '### mine\nGET https://x.test/mine' })
  expect(await ui.find({ type: 'Text', text: 'api.http changed since it was read; Cancel and open the request again.' })).toBeDefined()
  expect(world.state.files['api.http']).toContain('A3')
  await ui.press({ key: 'http:draft:cancel' })

  // 回合結束重讀後，刪第二個：按一次待確認，再按才刪，回清單。
  await endTurn($, ui)
  await ui.press({ key: 'http:back' })
  await ui.press({ key: 'http:req:api.http#1' })
  await ui.press({ key: 'http:delete' })
  expect(world.state.files['api.http']).toContain('### B')
  await ui.press({ key: 'http:delete' })
  expect(world.state.files['api.http']).toBe('### A3\r\nGET https://x.test/a3\r\n')
  expect((await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('http:req:'))).toEqual(['http:req:api.http#0'])
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
  await ui.press({ key: 'http:env-add' })
  await ui.input({ key: 'http:new-env', text: 'dev' })
  expect(await ui.find({ type: 'Text', text: 'There is already an environment dev.' })).toBeDefined()
  await ui.input({ key: 'http:new-env', text: '$shared' })
  expect(await ui.find({ type: 'Text', text: /^An environment name has only/ })).toBeDefined()
  await ui.press({ key: 'http:new-env:cancel' })

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

  // 名稱不對：不寫，框和打的字留著。
  await ui.press({ key: 'http:var-new' })
  await ui.input({ key: 'http:var-draft:name', text: 'a b', kind: 'change' })
  await ui.input({ key: 'http:var-draft:value', text: '1' })
  expect(await ui.find({ type: 'Text', text: /^A variable name has only/ })).toBeDefined()
  expect((await ui.find({ key: 'http:var-draft:name' }))?.props.value).toBe('a b')
  // 值格 Enter 就存。
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
  await ui.press({ key: 'http:var-row:base' })
  await ui.input({ key: 'http:var-draft:name', text: 'token' })
  expect(await ui.find({ type: 'Text', text: 'dev already has {{token}}.' })).toBeDefined()
  await ui.press({ key: 'http:var-draft:cancel' })

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

test('requests are listed by file and ###; one opens with the picked environment filled in, and Send shows the answer', async ($, on) => {
  const world = httpWorld(on, {
    files: { 'api.http': API_HTTP, 'http-client.env.json': ENV, 'b.http': 'GET https://example.com/health?x=1\n    &y=2\n' },
    answer: () => json(200, '{"id":1,"name":"Ada"}', { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'r1' }),
  })
  const ui = await mountPane($, 'desktop')
  await openTool(ui, 'http')
  const rows = (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('http:req:'))
  expect(rows).toEqual(['http:req:api.http#0', 'http:req:api.http#1', 'http:req:api.http#2', 'http:req:b.http#0'])
  // 沒有名字的寫方法和 URL；多行的 query 接起來。
  expect(await ui.find({ type: 'Text', text: 'GET https://example.com/health?x=1&y=2' })).toBeDefined()
  // HTTP 底下一排 API | Environment；API 只寫目前的環境，選環境在 Environment。
  expect((await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => /^http:page:\w+$/.test(k))).toEqual(['http:page:api', 'http:page:env'])
  expect(await ui.find({ type: 'Text', text: 'Env: dev' })).toBeDefined()
  expect(await ui.find({ key: 'http:env:dev' })).toBeUndefined()

  await ui.press({ key: 'http:req:api.http#0' })
  expect(await ui.find({ type: 'Text', text: 'http://localhost:3000/users/1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Accept:' })).toBeDefined()

  // 環境清單：$shared 不算一個；一開始用第一個；點開列出它的變數（$shared 的也在）。
  await page(ui, 'env')
  expect((await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => /^http:env:[^:]+$/.test(k))).toEqual(['http:env:dev', 'http:env:prod'])
  // 用中的方塊是綠的，其他灰的。
  expect((await ui.findAll({ type: 'Text', text: '■' })).map(t => t.props.color ?? (t.props.dimColor === true ? 'dim' : ''))).toEqual(['success', 'dim'])
  await ui.press({ key: 'http:env:dev' })
  expect(await ui.find({ type: 'Text', text: /http:\/\/localhost:3000/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /version/ })).toBeDefined()

  // 換 prod：回 API 點開的請求還在，URL 跟著換，選的環境記在 store（依 session 資料夾）。
  await useEnv(ui, 'prod')
  await page(ui, 'api')
  expect(await ui.find({ type: 'Text', text: 'https://api.example.com/users/1' })).toBeDefined()
  expect(world.store[HTTP_ENV_KEY]).toEqual({ '/proj': 'prod' })

  // prod 也是按一次就送。
  await ui.press({ key: 'http:send' })
  expect(world.fetches).toHaveLength(1)
  expect(world.fetches[0]).toMatchObject({ url: 'https://api.example.com/users/1', init: { method: 'GET', headers: { Accept: 'application/json' } } })
  expect(world.fetches[0]?.init?.body).toBeUndefined()
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

test('an error status is red, and a request that cannot connect or gets no answer says so', async ($, on) => {
  let mode = 'notFound'
  const world = httpWorld(on, {
    files: { 'a.http': 'GET http://localhost:9/x\n' },
    answer: () => {
      if (mode === 'notFound') return json(404, 'nope', { 'content-type': 'text/plain' })
      if (mode === 'down') return { deny: 'connect ECONNREFUSED 127.0.0.1:9' }

      return new Promise(() => undefined)
    },
  })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await ui.press({ key: 'http:req:a.http#0' })
  await ui.press({ key: 'http:send' })
  expect((await ui.find({ type: 'Text', text: '404' }))?.props.color).toBe('error')
  expect(await codes(ui)).toContain('nope')

  mode = 'down'
  await ui.press({ key: 'http:send' })
  expect(await ui.find({ type: 'Text', text: /^Couldn't reach http:\/\/localhost:9\/x: .*ECONNREFUSED/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '404' })).toBeUndefined()

  mode = 'hang'
  const pressed = ui.press({ key: 'http:send' })
  await world.clock.advance(HTTP_TIMEOUT_MS)
  await pressed
  expect(await ui.find({ type: 'Text', text: `Couldn't reach http://localhost:9/x: No answer after ${HTTP_TIMEOUT_MS / 1000}s.` })).toBeDefined()
  await ui.unmount()
})

test('a variable the env file lacks is a secret pasted on the panel: kept in the Keychain by folder and environment, masked, read once to send', async ($, on) => {
  const world = httpWorld(on, { files: { 'api.http': API_HTTP, 'http-client.env.json': ENV } })
  const ui = await mountPane($)
  await openTool(ui, 'http')
  await ui.press({ key: 'http:req:api.http#1' })
  expect(await ui.find({ type: 'Text', text: 'No value for {{password}}: paste it under' })).toBeDefined()

  // 沒有值就不送。
  await ui.press({ key: 'http:send' })
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
  expect((await codes(ui)).some(c => c.includes('"password": "••••••"'))).toBe(true)

  // 送出時代進去；存的時候已經在記憶體裡，Keychain 一次都不用問。
  await ui.press({ key: 'http:send' })
  await ui.press({ key: 'http:send' })
  expect(world.fetches.map(f => f.init?.body)).toEqual([`{ "user": "me", "password": "${PASSWORD}" }`, `{ "user": "me", "password": "${PASSWORD}" }`])
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
  await ui.press({ key: 'http:req:a.http#0' })
  expect(await ui.find({ type: 'Text', text: 'Bearer ••••••' })).toBeDefined()
  expect(world.keychain.counts.reads).toBe(0)
  await ui.press({ key: 'http:send' })
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
  await ui.press({ key: 'http:req:api.http#1' })
  await ui.press({ key: 'http:to-env' })
  await ui.input({ key: 'http:var:password', text: PASSWORD })
  await page(ui, 'api')
  await ui.press({ key: 'http:send' })
  expect(await ui.find({ type: 'Text', text: 'Captured {{token}}' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Not in the response, not captured: {{missing}}' })).toBeDefined()

  await ui.press({ key: 'http:back' })
  await ui.press({ key: 'http:req:api.http#2' })
  expect(await ui.find({ type: 'Text', text: 'Bearer tok-1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'From earlier responses: {{token}}' })).toBeDefined()
  await ui.press({ key: 'http:send' })
  expect(world.fetches.at(-1)?.init?.headers?.Authorization).toBe('Bearer tok-1')
  // 只放記憶體：不在 store，也沒寫檔。
  expect(JSON.stringify(world.store)).not.toContain('tok-1')
  // Environment 也列出取到的值。
  await page(ui, 'env')
  expect(await ui.find({ type: 'Text', text: /tok-1/ })).toBeDefined()

  // 另一個環境沒有它。
  await useEnv(ui, 'prod')
  await page(ui, 'api')
  expect(await ui.find({ type: 'Text', text: 'Bearer {{token}}' })).toBeDefined()
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
  expect(await texts(ui)).toContain('Ping')
  await ui.unmount()
})

test("Claude's Bash may not read or use the HTTP secrets", async ($, on) => {
  httpWorld(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } as never }))
  for (const command of ['security find-generic-password -s soap-mods-http -w', "jq '.\"http.secrets\"' store.json"]) {
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toContain('Blocked by soap-mods')
  }
  expect((await $.tool.call({ tool: 'Bash', command: 'grep -rn soap-mods-http hooks' })).deny).toBeUndefined()
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
  expect((await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('http:req:'))).toEqual(['http:req:f.http#0', 'http:req:f.http#1'])
  expect(await texts(ui)).toEqual(expect.arrayContaining(['first', 'second']))
  await ui.press({ key: 'http:req:f.http#0' })
  await ui.press({ key: 'http:send' })
  await ui.press({ key: 'http:back' })
  await ui.press({ key: 'http:req:f.http#1' })
  await ui.press({ key: 'http:send' })
  expect(world.fetches).toEqual([
    { url: 'https://x.test/a', init: { method: 'GET', headers: {} } },
    { url: 'https://x.test/b', init: { method: 'POST', headers: { 'X-One': '1', 'X-Two': '2' }, body: '{"a":1}' } },
  ])
  await ui.unmount()
})
