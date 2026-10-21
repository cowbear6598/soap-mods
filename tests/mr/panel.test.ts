import type { HttpInit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { CI_STORE_KEY } from '../../hooks/config'
import { OLD_KEYCHAIN, toHex } from '../../hooks/secret'
import { type TestEngine, type TestOn, branchLine, fakeKeychain, gitRepo, json, mountPane, ok, stubPanel, stubStore } from '../test-fixtures'

type Fetch = { url: string; init?: HttpInit }

const HOST = 'git.example'
const API = `https://${HOST}/api/v4/projects/web-team%2Fapp`
const MR = `${API}/merge_requests/676`
const TOKEN = 'glpat-good-token'
const PATH = 'Site/Jsx/ch_LeftMenu.jsx'
const NOTE_SHA = 'aaaa1111'
const HEAD_SHA = 'bbbb2222'

// reviewer 看到的檔案（第 2 行是建議要換的），和 source 分支最新的（第 1 行改了，第 2 行沒動）。
const SEEN = 'render: function() {\r\n  let balance= this.getModel().get("BetCredit");\r\n}\r\n'
const HEAD = '// changed\r\n  let balance= this.getModel().get("BetCredit");\r\n}\r\n'

const suggestionNote = (id: number, discussion: string, line: number, resolved: boolean) => ({
  id: discussion,
  individual_note: false,
  notes: [
    {
      id,
      type: 'DiffNote',
      body: '**Suggestion:** Check `this.getModel()` first. [possible bug, importance: 8]\n```suggestion:-0+0\n  let balance= this.getModel() ? this.getModel().get("BetCredit") : 0;\n```',
      author: { name: 'PR Agent', username: 'pr-agent' },
      created_at: '2026-09-20T10:00:00.000Z',
      system: false,
      resolvable: true,
      resolved,
      position: { new_path: PATH, old_path: PATH, new_line: line, old_line: null, head_sha: NOTE_SHA },
    },
  ],
})

const DISCUSSIONS = [
  suggestionNote(501, 'd-open', 2, false),
  suggestionNote(502, 'd-done', 2, true),
  {
    id: 'd-sys',
    individual_note: true,
    notes: [{ id: 600, body: 'approved this merge request', author: { name: 'Jeffrey Lee' }, created_at: '2026-10-15T10:00:00.000Z', system: true }],
  },
]

// MR 子分頁要的引擎回應：同 CI（/repo、origin 是 git.example 的 web-team/app、Keychain 裡有 TOKEN）。
// GitLab 這邊：還沒 approve 所以不能 merge，approve 之後能 merge（state 也能直接改）。記下每次 fetch 和改東西的請求。
function mrWorld(on: TestOn, { hasToken = true, head = HEAD }: { hasToken?: boolean; head?: string } = {}) {
  const fetches: Fetch[] = []
  const writes: { method: string; url: string; body: unknown }[] = []
  const state = { approved: false, merged: false, conflict: false }
  const store: Record<string, unknown> = hasToken ? { [CI_STORE_KEY]: { [HOST]: { secret: OLD_KEYCHAIN, user: 'soap' } } } : {}
  const keychain = fakeKeychain(hasToken ? { [HOST]: toHex(TOKEN) } : {})
  const runs: (readonly string[])[] = []
  stubPanel(on, { root: '/repo', now: null })
  mock.clock(on)
  stubStore(on, store)
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  gitRepo(on, {
    status: '',
    branches: [branchLine('develop', { isCurrent: true })],
    run: (git, e) => {
      runs.push(e.argv)
      const secret = keychain.run(e)
      if (secret !== undefined) return secret
      if (e.argv[0] === 'open') return ok('')
      if (git[0] === 'remote' && git[1] === 'get-url') return ok(`https://${HOST}/web-team/app.git\n`)
      if (git[0] === 'remote') return ok('origin\n')

      return undefined
    },
  })
  on('http.fetch', (_$, e) => {
    fetches.push(e)
    const { url } = e
    const method = e.init?.method ?? 'GET'
    if (e.init?.headers?.['PRIVATE-TOKEN'] !== TOKEN) return json(401, { message: '401 Unauthorized' })
    if (method !== 'GET') {
      writes.push({ method, url, body: e.init?.body === undefined ? undefined : JSON.parse(e.init.body) })
      if (url === `${MR}/approve`) state.approved = true
      if (url === `${MR}/unapprove`) state.approved = false
      if (url === `${MR}/merge`) state.merged = true

      return json(200, {})
    }
    if (url.startsWith(`${API}/merge_requests?`)) {
      return json(200, [
        { iid: 676, title: 'Fix balance display', source_branch: 'feature/balance', target_branch: 'release/prod_1015', author: { name: 'Amy' }, draft: false, updated_at: '2026-10-19T10:00:00.000Z' },
      ])
    }
    if (url === MR) {
      return json(200, {
        iid: 676,
        title: 'Fix balance display',
        state: state.merged ? 'merged' : 'opened',
        source_branch: 'feature/balance',
        target_branch: 'release/prod_1015',
        author: { name: 'Amy' },
        web_url: `https://${HOST}/web-team/app/-/merge_requests/676`,
        sha: HEAD_SHA,
        detailed_merge_status: state.conflict ? 'conflict' : state.approved ? 'mergeable' : 'not_approved',
        has_conflicts: state.conflict,
        head_pipeline: { id: 9, iid: 1193727, status: 'success', sha: '2139ca13ffff' },
        merged_by: state.merged ? { name: 'Soap' } : null,
      })
    }
    if (url === `${MR}/approvals`) {
      return json(200, { approved_by: state.approved ? [{ user: { name: 'Soap', username: 'soap' } }] : [], approvals_left: state.approved ? 0 : 1, user_has_approved: state.approved, user_can_approve: true })
    }
    if (url.startsWith(`${MR}/discussions?`)) return json(200, DISCUSSIONS)
    if (url === `${API}/repository/files/${encodeURIComponent(PATH)}/raw?ref=${NOTE_SHA}`) return json(200, SEEN)
    if (url === `${API}/repository/files/${encodeURIComponent(PATH)}/raw?ref=${HEAD_SHA}`) return json(200, head)
    if (url === `${API}/repository/branches/${encodeURIComponent('feature/balance')}`) return json(200, { name: 'feature/balance', commit: { id: HEAD_SHA } })

    return json(404, { message: '404 Not Found' })
  })

  return { fetches, writes, runs, state }
}

async function openMrTab($: TestEngine, surface: 'desktop' | 'terminal' = 'terminal') {
  const ui = await mountPane($, surface)
  await ui.press({ key: 'sub:mr' })
  await ui.redraw()

  return ui
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the MR sub tab lists the merge requests asking me to review, and opens one to its pipeline, approvals, and open suggestions as diffs (${surface})`, async ($, on) => {
    const world = mrWorld(on)
    const ui = await openMrTab($, surface)

    expect(world.fetches[0]?.url).toBe(`${API}/merge_requests?state=opened&reviewer_username=soap&order_by=updated_at&per_page=50`)
    expect(await ui.find({ type: 'Text', text: 'Review requests · 1' })).toBeDefined()
    await ui.press({ key: 'mr:item:676' })
    await ui.redraw()

    expect(await ui.find({ type: 'Text', text: '✓ Pipeline #1193727 success' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Approved by: none · 1 more needed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: "Can't merge yet: needs approval" })).toBeDefined()
    expect(await ui.find({ key: 'mr:merge' })).toBeUndefined()
    expect(await ui.find({ key: 'mr:approve' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Suggestions · 1 open · 1 resolved' })).toBeDefined()
    expect(await ui.find({ key: 'mr:s:501:apply' })).toBeDefined()
    expect(await ui.find({ key: 'mr:s:502:open' })).toBeUndefined()
    await ui.press({ key: 'mr:resolved' })
    expect(await ui.find({ key: 'mr:s:502:open' })).toBeDefined()
    expect(await ui.find({ key: 'mr:s:502:apply' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'feature/balance' })).toBeDefined()
    await ui.press({ key: 'mr:web' })
    expect(world.runs.some(r => r[0] === 'open' && r[1] === `https://${HOST}/web-team/app/-/merge_requests/676`)).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'approved this merge request' })).toBeUndefined()
    // 只讀：全是 GET。
    expect(world.writes).toEqual([])
    await ui.unmount()
  })
}

test('Approve makes the merge request mergeable; Merge then asks twice (Confirm PROD for a prod target) and sends the sha it saw', async ($, on) => {
  const world = mrWorld(on)
  const ui = await openMrTab($)
  await ui.press({ key: 'mr:item:676' })
  await ui.redraw()

  await ui.press({ key: 'mr:approve' })
  await ui.redraw()
  expect(world.writes).toEqual([{ method: 'POST', url: `${MR}/approve`, body: undefined }])
  expect(await ui.find({ type: 'Text', text: 'Ready to merge' })).toBeDefined()
  expect(await ui.find({ key: 'mr:unapprove' })).toBeDefined()

  await ui.press({ key: 'mr:merge' })
  expect(world.writes).toHaveLength(1)
  expect((await ui.find({ key: 'mr:merge' }))?.props.label).toBe('Confirm PROD')
  await ui.press({ key: 'mr:merge' })
  await ui.redraw()
  expect(world.writes.at(-1)).toEqual({ method: 'PUT', url: `${MR}/merge`, body: { sha: HEAD_SHA } })
  expect(await ui.find({ type: 'Text', text: /^Merged by Soap/ })).toBeDefined()
  await ui.unmount()
})

test('Apply asks twice, then commits the suggested line onto the newest source branch keeping its CRLF and resolves the thread', async ($, on) => {
  const world = mrWorld(on)
  const ui = await openMrTab($)
  await ui.press({ key: 'mr:item:676' })
  await ui.redraw()

  await ui.press({ key: 'mr:s:501:apply' })
  expect(world.writes).toEqual([])
  await ui.press({ key: 'mr:s:501:apply' })
  await ui.redraw()

  expect(world.writes).toEqual([
    {
      method: 'POST',
      url: `${API}/repository/commits`,
      body: {
        branch: 'feature/balance',
        commit_message: `Apply suggestion to ${PATH}`,
        actions: [{ action: 'update', file_path: PATH, content: '// changed\r\n  let balance= this.getModel() ? this.getModel().get("BetCredit") : 0;\r\n}\r\n' }],
        last_commit_id: HEAD_SHA,
      },
    },
    { method: 'PUT', url: `${MR}/discussions/d-open?resolved=true`, body: undefined },
  ])
  await ui.unmount()
})

test('Apply refuses when the lines changed after the suggestion, and commits nothing', async ($, on) => {
  const world = mrWorld(on, { head: SEEN.replace('let balance', 'const balance') })
  const ui = await openMrTab($)
  await ui.press({ key: 'mr:item:676' })
  await ui.redraw()
  await ui.press({ key: 'mr:s:501:apply' })
  await ui.press({ key: 'mr:s:501:apply' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: `Lines 2–2 of ${PATH} changed after the suggestion; apply it by hand.` })).toBeDefined()
  expect(world.writes).toEqual([])
  await ui.unmount()
})

test('a merge request with conflicts offers only Open Conflicts, which opens GitLab\'s conflicts page', async ($, on) => {
  const world = mrWorld(on)
  world.state.conflict = true
  const ui = await openMrTab($)
  await ui.press({ key: 'mr:item:676' })
  await ui.redraw()
  expect(await ui.find({ key: 'mr:approve' })).toBeUndefined()
  expect(await ui.find({ key: 'mr:s:501:resolve' })).toBeUndefined()
  await ui.press({ key: 'mr:conflicts' })
  expect(world.runs.some(r => r[0] === 'open' && r[1] === `https://${HOST}/web-team/app/-/merge_requests/676/conflicts`)).toBe(true)
  expect(world.writes).toEqual([])
  await ui.unmount()
})

test('with no saved GitLab token the MR sub tab points to the CI tab', async ($, on) => {
  const world = mrWorld(on, { hasToken: false })
  const ui = await openMrTab($)
  expect(await ui.find({ type: 'Text', text: /^No GitLab token is saved for git\.example/ })).toBeDefined()
  expect(world.fetches).toHaveLength(0)
  await ui.press({ key: 'mr:to-ci' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: `Connect ${HOST}` })).toBeDefined()
  await ui.unmount()
})
