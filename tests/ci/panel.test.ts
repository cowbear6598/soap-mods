import type { HttpInit, ProcessRunInit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { CI_STORE_KEY } from '../../hooks/config'
import { fromHex, toHex } from '../../hooks/db/secret'
import { type TestEngine, type TestOn, mountPane, ok, stubPanel, stubStore } from '../test-fixtures'

type Run = { argv: readonly string[]; init?: ProcessRunInit }
type Fetch = { url: string; init?: HttpInit }

const HOST = 'git.example'
const API = `https://${HOST}/api/v4/projects/web-team%2Fapp`
const TOKEN = 'glpat-good-token'

const pipeline = (id: number, ref: string, status: string) => ({
  id,
  iid: id - 1000,
  project_id: 1,
  sha: `${id}abcdef0123456789`,
  ref,
  status,
  source: 'push',
  created_at: '2026-10-20T10:00:00.000Z',
  web_url: `https://${HOST}/web-team/app/-/pipelines/${id}`,
})

// GitLab 照 id 由新到舊給：develop 跑了兩次，main 一次。
const PIPELINES = [pipeline(1002, 'develop', 'running'), pipeline(1001, 'main', 'success'), pipeline(1000, 'develop', 'success')]

// GitLab 照 id 由新到舊給。
const JOBS = [
  { id: 13, name: 'deploy-sit', stage: 'deploy', status: 'manual', duration: null, allow_failure: true },
  { id: 12, name: 'lint', stage: 'test', status: 'failed', duration: 12.4, allow_failure: true },
  { id: 11, name: 'build-app', stage: 'build', status: 'success', duration: 248.4, allow_failure: false },
]

const ESC = '\x1b'
const RAW_TRACE = [
  `${ESC}[0KRunning with gitlab-runner 17.0`,
  `section_start:1760000000:step_script\r${ESC}[0K${ESC}[32;1mExecuting "step_script" stage${ESC}[0;m`,
  'Downloading 10%\rDownloading 50%\rDownloading 100%',
  `${ESC}[31mnpm ERR! build failed${ESC}[0m`,
  `section_end:1760000001:step_script\r${ESC}[0K`,
  '',
].join('\n')

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  value: { status, ok: status >= 200 && status < 300, headers, text: typeof body === 'string' ? body : JSON.stringify(body) },
})

// CI 子分頁要的引擎回應：/repo 是 repo（目前分支 develop，origin 是 remote，預設 git.example 的 web-team/app），
// $.store 放在記憶體、Keychain 是一張表（security -i 存、find-generic-password -w 讀），GitLab API 只認 valid 裡的 token。
// hasToken：一開始就存好 TOKEN。記下每個程序、每次 fetch、讀了幾次 Keychain。
function ciWorld(on: TestOn, { hasToken = true, valid = [TOKEN], remote = `https://${HOST}/web-team/app.git` }: { hasToken?: boolean; valid?: string[]; remote?: string } = {}) {
  const runs: Run[] = []
  const fetches: Fetch[] = []
  const store: Record<string, unknown> = hasToken ? { [CI_STORE_KEY]: { [HOST]: { secret: 'keychain', user: 'soap' } } } : {}
  const keychain: Record<string, string> = hasToken ? { [HOST]: toHex(TOKEN) } : {}
  const counts = { keychainReads: 0 }
  const world = { posts: [] as string[] }
  stubPanel(on, { root: '/repo', now: null })
  mock.clock(on)
  stubStore(on, store)
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    runs.push(e)
    const [cmd, sub] = e.argv
    if (cmd === 'security' && sub === '-i') {
      const [, account = '', hex = ''] = /-a (\S+)(?: -T "")? -w (\S+)/.exec(e.init?.stdin ?? '') ?? []
      keychain[account] = hex

      return ok('')
    }
    if (cmd === 'security' && sub === 'find-generic-password') {
      const hex = keychain[e.argv[e.argv.indexOf('-a') + 1] ?? '']
      if (hex === undefined) return { value: { ...ok('').value, exitCode: 44 } }
      if (!e.argv.includes('-w')) return ok('keychain: "login.keychain-db"\n')
      counts.keychainReads += 1

      return ok(`${hex}\n`)
    }
    const git = e.argv.slice(3)
    if (git[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (git[0] === 'branch' && git[1] === '--show-current') return ok('develop\n')
    if (git[0] === 'remote' && git[1] === 'get-url') return ok(`${remote}\n`)
    if (git[0] === 'remote') return ok('origin\n')

    return ok('')
  })
  on('http.fetch', (_$, e) => {
    fetches.push(e)
    const { url } = e
    if (!valid.includes(e.init?.headers?.['PRIVATE-TOKEN'] ?? '')) return json(401, { message: '401 Unauthorized' })
    if (url === `https://${HOST}/api/v4/user`) return json(200, { username: 'soap' })
    if (e.init?.method === 'POST') {
      world.posts.push(url)
      if (url === `${API}/pipelines/1002/retry`) return json(201, pipeline(1002, 'develop', 'running'))
      if (url === `${API}/jobs/13/play`) return json(200, { ...JOBS[0], status: 'pending' })
      if (url === `${API}/jobs/12/retry`) return json(201, { ...JOBS[1], id: 14, status: 'pending', duration: null })
      if (url === `${API}/jobs/11/retry`) return json(201, { ...JOBS[2], id: 15, status: 'pending', duration: null })

      return json(404, { message: '404 Not Found' })
    }
    if (/\/jobs\/\d+\/trace$/.test(url)) return json(200, RAW_TRACE)
    if (url.startsWith(`${API}/pipelines?`)) {
      const ref = new URL(url).searchParams.get('ref')

      return json(
        200,
        PIPELINES.filter(p => ref === null || p.ref === ref),
        { 'x-next-page': '' },
      )
    }
    if (url.startsWith(`${API}/repository/commits?`)) return json(200, [{ id: PIPELINES[0]?.sha, title: 'Fix the login page' }])
    if (url.startsWith(`${API}/repository/branches?`)) {
      const search = new URL(url).searchParams.get('search') ?? ''

      return json(
        200,
        ['develop', 'main', 'feature/old-login'].filter(n => n.includes(search)).map(name => ({ name })),
      )
    }
    if (url.startsWith(`${API}/pipelines/1002/jobs`)) return json(200, JOBS)
    if (url === `${API}/pipelines/1002`) return json(200, pipeline(1002, 'develop', 'failed'))
    if (url === `${API}/jobs/12/trace`) return json(200, RAW_TRACE)

    return json(404, { message: '404 Project Not Found' })
  })

  return { runs, fetches, store, keychain, counts, posts: world.posts }
}

async function openCi($: TestEngine, surface: 'desktop' | 'terminal' = 'desktop') {
  const ui = await mountPane($, surface)
  await ui.press({ key: 'sub:ci' })
  await ui.redraw()

  return ui
}

test('the CI sub tab lists the branches that ran pipelines, opens one to its pipelines with commit titles, a pipeline to its jobs by stage, and a job to its cleaned log, asking the Keychain once', async ($, on) => {
  const world = ciWorld(on)
  const ui = await openCi($)

  // 分支照最近跑過的排，每個一列，帶最新那條的狀態。
  expect(await ui.find({ type: 'Text', text: 'Recent branches · 2' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^(develop|main|feature\/old-login)$/ })).map(t => t.text)).toEqual(['develop', 'main'])
  expect(await ui.find({ key: 'ci:token:change' })).toBeDefined()
  // 專案從 origin 認出來，token 放在 PRIVATE-TOKEN header。
  expect(world.fetches[0]?.url).toBe(`${API}/pipelines?per_page=100`)
  expect(world.fetches[0]?.init?.headers?.['PRIVATE-TOKEN']).toBe(TOKEN)

  await ui.press({ key: 'ci:ref:develop' })
  await ui.redraw()
  expect(await ui.find({ key: 'ci:pipeline:1002' })).toBeDefined()
  expect(await ui.find({ key: 'ci:pipeline:1000' })).toBeDefined()
  expect(await ui.find({ key: 'ci:pipeline:1001' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Fix the login page' })).toBeDefined()

  await ui.press({ key: 'ci:pipeline:1002' })
  await ui.redraw()
  // 狀態換成重讀到的那份；stage 照跑的順序，不是 GitLab 給的由新到舊。
  expect(await ui.find({ type: 'Text', text: '✗ failed' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^(build|test|deploy)$/ })).map(t => t.text)).toEqual(['build', 'test', 'deploy'])
  expect(await ui.find({ type: 'Text', text: '4m 8s' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '12s · allowed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'manual' })).toBeDefined()

  await ui.press({ key: 'ci:job:12' })
  await ui.redraw()
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('Running with gitlab-runner 17.0\nExecuting "step_script" stage\nDownloading 100%\nnpm ERR! build failed\n\n')

  await ui.press({ key: 'ci-job:back' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'ci-pipeline:back' })
  await ui.redraw()
  expect(await ui.find({ key: 'ci:pipeline:1000' })).toBeDefined()
  await ui.press({ key: 'ci-ref:back' })
  await ui.redraw()
  expect(await ui.find({ key: 'ci:ref:main' })).toBeDefined()
  // 讀了一堆 API，Keychain 只問一次（macOS 每次都會跳視窗）；只讀：全是 GET，沒有 glab。
  expect(world.counts.keychainReads).toBe(1)
  expect(world.fetches.every(f => f.init?.method === undefined || f.init.method === 'GET')).toBe(true)
  expect(world.runs.some(r => r.argv[0]?.includes('glab') === true)).toBe(false)
  await ui.unmount()
})

test('the CI search box finds branches by name, recent ones first and then older ones GitLab finds, without rereading the pipelines while typing', async ($, on) => {
  const world = ciWorld(on)
  const ui = await openCi($)
  const recentReads = () => world.fetches.filter(f => f.url.endsWith('/pipelines?per_page=100')).length

  await ui.input({ key: 'ci:search', text: 'DEV', kind: 'change' })
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text', text: /^(develop|main|feature\/old-login)$/ })).map(t => t.text)).toEqual(['develop'])

  // 最近沒跑 pipeline 的分支也找得到，點開看它的 pipeline。
  await ui.input({ key: 'ci:search', text: 'old login', kind: 'change' })
  await ui.redraw()
  expect(world.fetches.at(-1)?.url).toContain('/repository/branches?per_page=20&search=old')
  expect((await ui.findAll({ type: 'Text', text: /^(develop|main|feature\/old-login)$/ })).map(t => t.text)).toEqual(['feature/old-login'])
  await ui.press({ key: 'ci:ref:feature/old-login' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: 'No pipelines on this branch.' })).toBeDefined()
  await ui.press({ key: 'ci-ref:back' })

  await ui.input({ key: 'ci:search', text: 'nope', kind: 'change' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: 'No matching branches.' })).toBeDefined()
  // 打字沿用讀過的；只有回分支清單時重讀了一次。
  expect(recentReads()).toBe(2)
  await ui.unmount()
})

test('Retry reruns a failed pipeline; each job row runs a manual job or retries a finished one, only on a second press; the log has the same button', async ($, on) => {
  const world = ciWorld(on)
  const ui = await openCi($, 'terminal')
  await ui.press({ key: 'ci:ref:develop' })
  await ui.redraw()
  // 分支那層沒有 Run：不知道要跑哪個。
  expect(await ui.find({ key: 'ci:run' })).toBeUndefined()
  await ui.press({ key: 'ci:pipeline:1002' })
  await ui.redraw()

  // 按一次只變成 Confirm，什麼都沒跑。
  await ui.press({ key: 'ci:retry' })
  expect(world.posts).toEqual([])
  expect((await ui.find({ key: 'ci:retry' }))?.props.label).toBe('Confirm')
  await ui.press({ key: 'ci:retry' })
  await ui.redraw()
  expect(world.posts).toEqual([`${API}/pipelines/1002/retry`])

  // job 清單：manual 的是 Run，跑完的是 Retry，跑著的沒有。
  expect(await ui.find({ key: 'ci:job:13:retry' })).toBeUndefined()
  await ui.press({ key: 'ci:job:13:run' })
  await ui.press({ key: 'ci:job:13:run' })
  await ui.redraw()
  expect(world.posts.at(-1)).toBe(`${API}/jobs/13/play`)
  await ui.press({ key: 'ci:job:11:retry' })
  await ui.press({ key: 'ci:job:11:retry' })
  await ui.redraw()
  expect(world.posts.at(-1)).toBe(`${API}/jobs/11/retry`)

  // log 裡也能重跑，換成看 GitLab 開的新 job。
  await ui.press({ key: 'ci:job:12' })
  await ui.redraw()
  await ui.press({ key: 'ci:retry' })
  await ui.press({ key: 'ci:retry' })
  await ui.redraw()
  expect(world.posts.at(-1)).toBe(`${API}/jobs/12/retry`)
  expect(await ui.find({ type: 'Text', text: '○ pending' })).toBeDefined()
  await ui.unmount()
})

test('with no token the CI sub tab is a box to paste one; a token GitLab accepts is saved guarded in the Keychain, never in the store or on a command line', async ($, on) => {
  const world = ciWorld(on, { hasToken: false })
  const ui = await openCi($)

  expect(await ui.find({ type: 'Text', text: `Connect ${HOST}` })).toBeDefined()
  expect(await ui.find({ key: 'ci:ref:develop' })).toBeUndefined()
  expect(world.fetches).toHaveLength(0)

  // GitLab 不認的 token：說為什麼，什麼都不存。
  await ui.input({ key: 'ci:token', text: 'glpat-wrong' })
  expect(await ui.find({ type: 'Text', text: /^Couldn't save the token: GitLab refused this token \(401\)/ })).toBeDefined()
  expect(world.keychain[HOST]).toBeUndefined()

  await ui.input({ key: 'ci:token', text: ` ${TOKEN} ` })
  await ui.redraw()
  expect(await ui.find({ key: 'ci:ref:develop' })).toBeDefined()
  expect(fromHex(world.keychain[HOST] ?? '')).toBe(TOKEN)
  // -T ""：誰來讀都要人按允許。
  const save = world.runs.find(r => r.argv[0] === 'security' && r.argv[1] === '-i')
  expect(save?.init?.stdin).toContain(`-s soap-mods-gitlab -a ${HOST} -T "" -w `)
  expect(world.store[CI_STORE_KEY]).toEqual({ [HOST]: { secret: 'keychain', user: 'soap' } })
  expect(JSON.stringify(world.store)).not.toContain(TOKEN)
  expect(world.runs.some(r => r.argv.some(a => a.includes(TOKEN) || a.includes(toHex(TOKEN))))).toBe(false)
  // 剛存的留在記憶體，不用再問 Keychain。
  expect(world.counts.keychainReads).toBe(0)
  await ui.unmount()
})

test('Change token swaps the saved token for a new one; a saved token GitLab refuses opens the box with why', async ($, on) => {
  const NEW = 'glpat-new-token'
  const world = ciWorld(on, { valid: [NEW] })
  const ui = await openCi($, 'terminal')

  // 存著的 TOKEN 被拒（過期）：框自己打開。
  expect(await ui.find({ type: 'Text', text: /^GitLab refused the saved token \(401\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: `Change the GitLab token for ${HOST}` })).toBeDefined()
  await ui.press({ key: 'ci:token:cancel' })
  expect(await ui.find({ key: 'ci:token' })).toBeUndefined()

  await ui.press({ key: 'ci:token:change' })
  await ui.input({ key: 'ci:token', text: NEW })
  await ui.redraw()
  expect(fromHex(world.keychain[HOST] ?? '')).toBe(NEW)
  expect(await ui.find({ key: 'ci:ref:develop' })).toBeDefined()
  expect(await ui.find({ key: 'ci:token' })).toBeUndefined()
  expect(world.fetches.at(-1)?.init?.headers?.['PRIVATE-TOKEN']).toBe(NEW)
  await ui.unmount()
})

test("This branch opens the checked out branch's pipelines; a project the token cannot reach says so", async ($, on) => {
  const world = ciWorld(on)
  const ui = await openCi($, 'terminal')
  await ui.press({ key: 'ci:current' })
  await ui.redraw()

  expect(world.fetches.some(f => f.url.includes('&ref=develop'))).toBe(true)
  expect(await ui.find({ key: 'ci:pipeline:1002' })).toBeDefined()
  expect(await ui.find({ key: 'ci:pipeline:1001' })).toBeUndefined()

  await ui.press({ key: 'ci-ref:back' })
  await ui.press({ key: 'ci:ref:main' })
  await ui.redraw()
  await ui.press({ key: 'ci:pipeline:1001' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^GitLab can't find repo's project with the saved token \(404\)/ })).toBeDefined()
  await ui.unmount()
})

test("Claude's Bash may not touch the GitLab token or the DB passwords; other commands run", async ($, on) => {
  ciWorld(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } as never }))
  for (const command of ['security find-generic-password -s soap-mods-gitlab -w', 'security find-generic-password -s SOAP-MODS-DB -a x -w', "curl -H 'PRIVATE-TOKEN: x' https://git.example/api/v4/user"]) {
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toContain('Blocked by soap-mods')
  }
  const fine = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(fine.deny).toBeUndefined()
})

test('the CI sub tab reads the GitLab project from an ssh remote too', async ($, on) => {
  const ssh = ciWorld(on, { remote: `ssh://git@${HOST}:2222/web-team/app.git` })
  const ui = await openCi($)
  expect(ssh.fetches[0]?.url).toBe(`${API}/pipelines?per_page=100`)
  await ui.unmount()
})

test('a GitHub remote says the CI tab cannot read it instead of asking for a token', async ($, on) => {
  const world = ciWorld(on, { remote: 'git@github.com:owner/repo.git' })
  const ui = await openCi($)
  expect(await ui.find({ type: 'Text', text: "This repo's remote is not a GitLab project the CI tab can read." })).toBeDefined()
  expect(await ui.find({ key: 'ci:token' })).toBeUndefined()
  expect(world.fetches).toHaveLength(0)
  await ui.unmount()
})
