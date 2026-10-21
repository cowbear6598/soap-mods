// CI 子分頁（GitLab）的動作：讀選中的 repo 最近跑過 pipeline 的分支、點開的分支的 pipeline、點開的 pipeline 的 job、點開的 job 的 log，和存 GitLab token。Run、Retry 要按兩次才跑。
// 不碰 $ 和 atom，用 register.tsx 給的 CiIo（見 io.ts）。直接打 GitLab API（gitlab.ts），不用 glab：
// token 只有這個 mod 拿得到（ci/token.ts），Claude 在終端機沒有現成登入好的工具能操作 GitLab。

import type { Timer } from 'claude-code'

import type { CiBranch, CiJob, CiJobAction, CiPipeline, CiView } from '../../types'
import { CI_PAGE, CI_SEARCH_DEBOUNCE_MS } from '../config'
import { errorText } from '../errors'
import { type GitLabIo, TokenRefused, api, isDue, repoProject } from '../gitlab'
import { latestOnly } from '../latest'
import { filterWords, hasQuery, searchWords } from '../search'
import { type ArmSlot, busyFlag, isConfirmed } from '../shell'
import { clampPage } from '../text'
import {
  type GitLabProject,
  branchSearchUrl,
  cleanTrace,
  commitsUrl,
  isActive,
  jobActionUrl,
  jobsUrl,
  parseBranchNames,
  parseCommitTitles,
  parseJob,
  parseJobs,
  parsePipeline,
  parsePipelines,
  parseUser,
  pipelineUrl,
  pipelinesUrl,
  recentPipelinesUrl,
  retryPipelineUrl,
  toBranches,
  traceTail,
  traceUrl,
  userUrl,
} from './parse'
import { saveToken, savedToken } from './token'

export type CiIo = GitLabIo & {
  getCi: () => Promise<CiView>
  setCi: (change: Partial<CiView>) => Promise<void>
}

// 關掉點開的 job，回 pipeline。
const NO_CI_JOB = { job: null, trace: null, isTraceTruncated: false, traceError: '', armed: '', actionError: '' } satisfies Partial<CiView>
// 關掉點開的 pipeline（和 job），回分支的 pipeline。
const NO_CI_PIPELINE = { open: null, jobs: null, jobsError: '', ...NO_CI_JOB } satisfies Partial<CiView>
// 關掉點開的分支（和底下的），回分支清單。
const NO_CI_REF = { ref: null, pipelines: null, pipelinePage: 0, hasNext: false, pipelinesError: '', ...NO_CI_PIPELINE } satisfies Partial<CiView>

// 正在檢查、存 token：模組變數不放 atom（同 DB 的 dbBusy），熱重載後不會一直停在「Checking…」。
const tokenBusy = busyFlag(false)
export const ciSavingNow = tokenBusy.get

// 讀失敗：401 時把換 token 的框打開，錯誤寫在框旁邊；其他的寫在 field 那裡。
async function failed(io: CiIo, err: unknown, field: 'error' | 'pipelinesError' | 'jobsError' | 'traceError' | 'actionError', extra: Partial<CiView> = {}) {
  if (err instanceof TokenRefused) await io.setCi({ ...extra, isLoaded: true, isTokenOpen: true, tokenError: err.message })
  else await io.setCi({ ...extra, isLoaded: true, [field]: errorText(err) })
}

// 換頁、搜尋、定時重讀同時來的話，只寫最新那次讀到的。換 repo 時 drop 掉讀到一半的。
const branchLoads = latestOnly()
const pipelineLoads = latestOnly()
const jobLoads = latestOnly()
const traceLoads = latestOnly()

// 最新的 CI_RECENT 條 pipeline（整理成分支清單）：搜尋打字時沿用，重讀（↻、定時、回清單）才再問 GitLab。
let recent: { base: string; load: Promise<CiPipeline[]> } | undefined

// commit 的 sha → 標題（讀不到的是 ''）：commit 不會變，定時重讀分支的 pipeline 時只有新的 sha 才再問 GitLab。
const titles = new Map<string, string>()

// 定時重讀分支清單、分支的 pipeline：上次讀的時間（見 isListDue）。
let listReadAt = 0

// 搜尋框打字：停手 CI_SEARCH_DEBOUNCE_MS 才問 GitLab（見 searchCi）。
let searchTimer: Timer | undefined

function dropCi() {
  searchTimer?.cancel()
  branchLoads.drop()
  pipelineLoads.drop()
  jobLoads.drop()
  traceLoads.drop()
  recent = undefined
  titles.clear()
}

function readRecent(io: CiIo, p: GitLabProject, isFresh: boolean) {
  const base = `${p.host}\n${p.path}`
  if (!isFresh && recent?.base === base) return recent.load
  const load = api(io, p, recentPipelinesUrl(p)).then(r => parsePipelines(r.text))
  recent = { base, load }
  // 讀失敗不留著，下次再問。
  load.catch(() => {
    if (recent?.load === load) recent = undefined
  })

  return load
}

// 搜尋時：最近跑過的分支裡名稱符合的排前面，再補上 GitLab 找到、最近沒跑 pipeline 的。
// GitLab 只能用一段字找，用第一個字問，其他的字自己濾。
async function searchBranches(io: CiIo, p: GitLabProject, ran: CiBranch[], query: string) {
  const matched = filterWords(ran, query, b => b.name)
  const [first = ''] = searchWords(query)
  const names = filterWords(parseBranchNames((await api(io, p, branchSearchUrl(p, first))).text), query, n => n)
  const listed = new Set(matched.map(b => b.name))

  return [...matched, ...names.filter(n => !listed.has(n)).map(name => ({ name, pipeline: null }))]
}

// 讀分支清單（第一層）：最近跑過 pipeline 的分支，最近的先，每個帶最新那條的狀態。isFresh 是 false 時（打字）沿用讀過的 pipeline。
export async function loadBranches(io: CiIo, { isFresh = true }: { isFresh?: boolean } = {}) {
  const isStale = branchLoads.start()
  listReadAt = await io.now()
  const ci = await io.getCi()
  // 讀到哪台 GitLab、存的是誰：token 被拒時一樣要寫上，換 token 的框才知道是哪台。
  let account: Partial<CiView> = {}
  try {
    const p = await repoProject(io)
    const saved = await savedToken(io, p.host)
    if (isStale()) return
    // 這台 GitLab 還沒有 token：畫輸入框。
    if (saved === undefined) {
      await io.setCi({ isLoaded: true, host: p.host, hasToken: false, user: '', branches: [], error: '' })

      return
    }
    account = { host: p.host, hasToken: true, user: saved.user }
    const ran = toBranches(await readRecent(io, p, isFresh))
    const branches = hasQuery(ci.query) ? await searchBranches(io, p, ran, ci.query) : ran
    if (isStale()) return
    // 自己切頁，變少了就夾回最後一頁。
    await io.setCi({ isLoaded: true, ...account, branches, page: clampPage(ci.page, branches.length, CI_PAGE), error: '' })
  } catch (err) {
    if (!isStale()) await failed(io, err, 'error', { ...account, branches: [] })
  }
}

// pipeline 配上 commit 標題：有沒記過的 sha 才讀分支最新的 commit。讀不到（tag、merge request 的 ref、很舊的 commit）就不寫，pipeline 照列。
async function withTitles(io: CiIo, p: GitLabProject, ref: string, pipelines: CiPipeline[]) {
  if (pipelines.some(x => !titles.has(x.sha))) {
    const found = await api(io, p, commitsUrl(p, ref)).then(
      r => parseCommitTitles(r.text),
      () => new Map<string, string>(),
    )
    for (const x of pipelines) titles.set(x.sha, found.get(x.sha) ?? '')
  }

  return pipelines.map(x => ({ ...x, title: titles.get(x.sha) ?? '' }))
}

// 點開的分支的第 page 頁 pipeline（沒給是目前那頁）。
async function loadPipelines(io: CiIo, page?: number) {
  const isStale = pipelineLoads.start()
  listReadAt = await io.now()
  const ci = await io.getCi()
  const ref = ci.ref
  if (ref === null) return
  const wanted = page ?? ci.pipelinePage
  try {
    const p = await repoProject(io)
    const r = await api(io, p, pipelinesUrl(p, ref, wanted))
    const pipelines = await withTitles(io, p, ref, parsePipelines(r.text))
    if (isStale() || (await io.getCi()).ref !== ref) return
    // 這頁空了（pipeline 被刪）就回第一頁。
    if (pipelines.length === 0 && wanted > 0) {
      await loadPipelines(io, 0)

      return
    }
    // GitLab 在 x-next-page 寫下一頁的頁碼，最後一頁是空的。
    await io.setCi({ pipelines, pipelinePage: wanted, hasNext: (r.headers['x-next-page'] ?? '').trim() !== '', pipelinesError: '' })
  } catch (err) {
    if (!isStale()) await failed(io, err, 'pipelinesError', { pipelines: [] })
  }
}

// 搜尋框打字：從第一頁看，沿用讀過的 pipeline。每打一個字都要問 GitLab 的分支搜尋，所以停手了才讀；清空就馬上回清單。
export async function searchCi(io: CiIo, text: string) {
  searchTimer?.cancel()
  await io.setCi({ query: text, page: 0 })
  const load = () => loadBranches(io, { isFresh: false })
  if (hasQuery(text)) searchTimer = io.after(CI_SEARCH_DEBOUNCE_MS, load)
  else await load()
}

// 換頁：分支清單是整份讀好的，直接換；分支的 pipeline 一頁一頁問 GitLab。
export async function showCiPage(io: CiIo, page: number) {
  if ((await io.getCi()).ref === null) await io.setCi({ page })
  else await loadPipelines(io, page)
}

export async function openRef(io: CiIo, ref: string) {
  pipelineLoads.drop()
  await io.setCi({ ...NO_CI_REF, ref })
  await io.scrollTop()
  await loadPipelines(io, 0)
}

// 回分支清單時順手重讀，狀態可能變了。
export async function closeRef(io: CiIo) {
  pipelineLoads.drop()
  await io.setCi(NO_CI_REF)
  await loadBranches(io)
}

// 點開的 pipeline 的 job，和它自己的狀態（跑著的時候會變）。
async function loadJobs(io: CiIo, p: CiPipeline) {
  const isStale = jobLoads.start()
  try {
    const gl = await repoProject(io)
    const [jobs, fresh] = await Promise.all([
      api(io, gl, jobsUrl(gl, p.id)).then(r => parseJobs(r.text)),
      api(io, gl, pipelineUrl(gl, p.id)).then(r => parsePipeline(r.text)),
    ])
    const ci = await io.getCi()
    if (isStale() || ci.open?.id !== p.id) return
    const shown = ci.job
    const job = shown === null ? null : (jobs.find(j => j.id === shown.id) ?? shown)
    await io.setCi({ open: { ...fresh, title: p.title }, jobs, jobsError: '', job })
  } catch (err) {
    if (!isStale()) await failed(io, err, 'jobsError', { jobs: [] })
  }
}

async function loadTrace(io: CiIo, j: CiJob) {
  const isStale = traceLoads.start()
  try {
    const p = await repoProject(io)
    const r = await api(io, p, traceUrl(p, j.id))
    const { text, isTruncated } = traceTail(cleanTrace(r.text))
    if (isStale() || (await io.getCi()).job?.id !== j.id) return
    await io.setCi({ trace: text, isTraceTruncated: isTruncated, traceError: '' })
  } catch (err) {
    if (!isStale()) await failed(io, err, 'traceError', { trace: '' })
  }
}

export async function openPipeline(io: CiIo, p: CiPipeline) {
  jobLoads.drop()
  await io.setCi({ ...NO_CI_PIPELINE, open: p })
  await io.scrollTop()
  await loadJobs(io, p)
}

// 回分支的 pipeline 時順手重讀，狀態可能變了。
export async function closePipeline(io: CiIo) {
  jobLoads.drop()
  traceLoads.drop()
  await io.setCi(NO_CI_PIPELINE)
  await loadPipelines(io)
}

export async function openJob(io: CiIo, j: CiJob) {
  traceLoads.drop()
  await io.setCi({ ...NO_CI_JOB, job: j })
  await io.scrollTop()
  await loadTrace(io, j)
}

export async function closeJob(io: CiIo) {
  traceLoads.drop()
  await io.setCi(NO_CI_JOB)
}

// 換 repo：上一個 repo 的分支、pipeline、job 和搜尋都不算了（CI 沒開著也一樣，不然回來時拿舊的 id 去問新的專案）。
export async function clearCi(io: CiIo) {
  dropCi()
  await io.setCi({ isLoaded: false, query: '', page: 0, branches: [], error: '', isTokenOpen: false, tokenError: '', ...NO_CI_REF })
}

async function resetCi(io: CiIo) {
  await clearCi(io)
  await loadBranches(io)
}

const isListDue = async (io: CiIo, isRunning: boolean) => isDue(await io.now(), listReadAt, isRunning)

// 重讀看得到的那層：分支清單、點開的分支的 pipeline、點開的 pipeline 的 job，點開的 job 還在跑就連 log。
// 定時重讀時（isTimer）跑完了的 pipeline、job 不再問：結果不會變了。
export async function refreshCi(io: CiIo, { isTimer = false }: { isTimer?: boolean } = {}) {
  const ci = await io.getCi()
  if (ci.job !== null) {
    if (!isTimer || isActive(ci.job.status) || ci.trace === null) {
      // 先讀 job 的狀態再讀 log：剛跑完的那輪讀到的 log 就有最後幾行，之後定時重讀不再讀它。
      if (ci.open !== null) await loadJobs(io, ci.open)
      await loadTrace(io, ci.job)
    }
  } else if (ci.open !== null) {
    if (!isTimer || isActive(ci.open.status) || ci.jobs === null) await loadJobs(io, ci.open)
  } else if (ci.ref !== null) {
    if (!isTimer || (await isListDue(io, ci.pipelines === null || ci.pipelines.some(p => isActive(p.status))))) await loadPipelines(io)
  } else if (!isTimer || (await isListDue(io, !ci.isLoaded || ci.branches.some(b => b.pipeline !== null && isActive(b.pipeline.status))))) {
    await loadBranches(io)
  }
}

// 跑、重跑：按第一次變成 Confirm，ARM 的時間內再按一次才問 GitLab；沒按就收回。同時只跑一個。
const ciArm: ArmSlot = {}
const acting = busyFlag(false)
export const ciActingNow = acting.get

// 點開的 pipeline 上的動作：run 拿到 GitLab 專案和那條 pipeline。
async function act(io: CiIo, armed: string, run: (p: GitLabProject, open: CiPipeline) => Promise<void>) {
  const ci = await io.getCi()
  const open = ci.open
  if (acting.get() || open === null) return
  const disarm = async () => {
    if ((await io.getCi()).armed === armed) await io.setCi({ armed: '' })
  }
  if (!(await isConfirmed(io, ciArm, ci.armed === armed, () => io.setCi({ armed, actionError: '' }), disarm))) return
  acting.set(io, true)
  try {
    await io.setCi({ armed: '', actionError: '' })
    await run(await repoProject(io), open)
  } catch (err) {
    await failed(io, err, 'actionError')
  } finally {
    acting.set(io, false)
  }
}

// 重跑點開的 pipeline 裡失敗、取消的 job。
export async function retryCiPipeline(io: CiIo) {
  const id = (await io.getCi()).open?.id
  await act(io, `retry:pipeline:${id}`, async (p, open) => {
    const fresh = { ...parsePipeline((await api(io, p, retryPipelineUrl(p, open.id), { method: 'POST' })).text), title: open.title }
    io.toast(`Retrying pipeline #${fresh.iid}`)
    await io.setCi({ open: fresh })
    await loadJobs(io, fresh)
  })
}

// 跑 manual job（play）或重跑跑完的（retry，GitLab 開一個新的 job）。
// 在它的 log 裡按的就換成看 GitLab 回的那個，在 job 清單裡按的就重讀清單。
export async function actOnJob(io: CiIo, job: CiJob, kind: CiJobAction) {
  await act(io, `${kind}:job:${job.id}`, async (p, open) => {
    const j = parseJob((await api(io, p, jobActionUrl(p, job.id, kind), { method: 'POST' })).text)
    io.toast(`${kind === 'play' ? 'Started' : 'Retrying'} ${j.name}`)
    if ((await io.getCi()).job?.id !== job.id) {
      await loadJobs(io, open)

      return
    }
    await io.setCi({ ...NO_CI_JOB, job: j })
    await Promise.all([loadJobs(io, open), loadTrace(io, j)])
  })
}

// 貼上 token：先用它問 GitLab 是誰（確認能用、記下帳號），能用才存進 Keychain／DPAPI，換掉舊的。
// 錯誤訊息裡不放 token。
export async function saveCiToken(io: CiIo, text: string) {
  const token = text.trim()
  if (tokenBusy.get() || token === '') return
  tokenBusy.set(io, true)
  try {
    const p = await repoProject(io)
    const user = parseUser((await api(io, p, userUrl(p), { token })).text)
    await saveToken(io, p.host, token, user)
    await io.setCi({ host: p.host, hasToken: true, user, isTokenOpen: false, tokenError: '' })
    io.toast(`Saved the GitLab token for ${p.host}`)
    await resetCi(io)
  } catch (err) {
    const why = err instanceof TokenRefused ? 'GitLab refused this token (401). Check it was copied whole and has not expired.' : errorText(err)
    await io.setCi({ tokenError: `Couldn't save the token: ${why}` })
  } finally {
    tokenBusy.set(io, false)
  }
}

export async function toggleCiToken(io: CiIo, isOpen: boolean) {
  await io.setCi({ isTokenOpen: isOpen, tokenError: '' })
}
