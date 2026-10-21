// 不碰 $ 和 atom，用 register.tsx 給的 MrIo。token 跟 CI 子分頁是同一組（ci/token.ts），這裡只讀不存。

import type { MrDetail, MrSuggestion, MrView } from '../../types'
import { type GitLabProject, isActive, parseUser, userUrl } from '../ci/parse'
import { savedToken } from '../ci/token'
import { EMPTY_MR } from '../defaults'
import { errorText } from '../errors'
import { type GitLabIo, TokenRefused, api, isDue, repoProject } from '../gitlab'
import { latestOnly } from '../latest'
import { powershellArgv } from '../services/scan'
import { type ArmSlot, busyFlag, isConfirmed, isWindows, runOk } from '../shell'
import {
  applyLines,
  approvalsUrl,
  approveUrl,
  branchUrl,
  commitUrl,
  discussionsUrl,
  fileLines,
  lineRange,
  mergeBlocked,
  mergeUrl,
  mrListUrl,
  mrUrl,
  parseApprovals,
  parseBranchHead,
  parseDetail,
  parseReviewList,
  parseSuggestions,
  rawFileUrl,
  resolveUrl,
} from './parse'

export type MrIo = GitLabIo & {
  getMr: () => Promise<MrView>
  setMr: (change: Partial<MrView>) => Promise<void>
}

const TOKEN_REFUSED = 'GitLab refused the saved token (401). Change it in the CI tab.'

const NO_MR = { open: null, opening: 0, detailError: '', suggestions: null, showResolved: false, armed: '', actionError: '' } satisfies Partial<MrView>

const listLoads = latestOnly()
const detailLoads = latestOnly()

let readAt = 0

// 存 token 時沒記到帳號名稱（舊版存的）就問 GitLab 一次，照主機記著。
const users = new Map<string, string>()

async function reviewer(io: MrIo, p: GitLabProject, saved: string) {
  if (saved !== '') return saved
  const known = users.get(p.host)
  if (known !== undefined) return known
  const user = parseUser((await api(io, p, userUrl(p))).text)
  users.set(p.host, user)

  return user
}

// 檔案在某個 commit 的內容：commit 不會變，讀過的記著（定時重讀不再問）；讀不到是 null。
const files = new Map<string, Promise<string | null>>()

function readFile(io: MrIo, p: GitLabProject, path: string, sha: string) {
  const key = `${p.host}\n${p.path}\n${sha}\n${path}`
  const known = files.get(key)
  if (known !== undefined) return known
  // 讀不到的不留著，下次再問。
  const load = api(io, p, rawFileUrl(p, path, sha)).then(
    r => r.text,
    () => {
      files.delete(key)

      return null
    },
  )
  files.set(key, load)

  return load
}

async function withOld(io: MrIo, p: GitLabProject, suggestions: MrSuggestion[]) {
  return Promise.all(
    suggestions.map(async s => {
      const text = s.sha === '' ? null : await readFile(io, p, s.path, s.sha)

      return { ...s, old: text === null ? null : lineRange(fileLines(text).lines, s.from, s.to) }
    }),
  )
}

const failureText = (err: unknown) => (err instanceof TokenRefused ? TOKEN_REFUSED : errorText(err))

// 還沒存 token 時畫「去 CI 存」的提示。
export async function loadMrList(io: MrIo) {
  const isStale = listLoads.start()
  readAt = await io.now()
  try {
    const p = await repoProject(io)
    const saved = await savedToken(io, p.host)
    if (isStale()) return
    if (saved === undefined) {
      await io.setMr({ isLoaded: true, host: p.host, hasToken: false, list: [], error: '' })

      return
    }
    const user = await reviewer(io, p, saved.user)
    const found = parseReviewList((await api(io, p, mrListUrl(p, user))).text)
    if (isStale()) return
    await io.setMr({ isLoaded: true, host: p.host, hasToken: true, list: found, error: '' })
  } catch (err) {
    if (!isStale()) await io.setMr({ isLoaded: true, list: [], error: failureText(err) })
  }
}

// withSuggestions 是 false（定時重讀，只為了 pipeline、approvals 的狀態）時不讀討論串，建議沿用。
async function loadDetail(io: MrIo, iid: number, { withSuggestions = true }: { withSuggestions?: boolean } = {}) {
  const isStale = detailLoads.start()
  readAt = await io.now()
  try {
    const p = await repoProject(io)
    const [d, a, discussions] = await Promise.all([
      api(io, p, mrUrl(p, iid)),
      api(io, p, approvalsUrl(p, iid)),
      withSuggestions ? api(io, p, discussionsUrl(p, iid)) : undefined,
    ])
    const detail = parseDetail(d.text, parseApprovals(a.text))
    const suggestions = discussions === undefined ? undefined : await withOld(io, p, parseSuggestions(discussions.text, detail.webUrl))
    if (isStale() || (await io.getMr()).opening !== iid) return
    await io.setMr({ open: detail, ...(suggestions === undefined ? {} : { suggestions }), detailError: '' })
  } catch (err) {
    if (!isStale()) await io.setMr({ suggestions: [], detailError: failureText(err) })
  }
}

export async function openMr(io: MrIo, iid: number) {
  detailLoads.drop()
  await io.setMr({ ...NO_MR, opening: iid })
  await io.scrollTop()
  await loadDetail(io, iid)
}

// 回清單時順手重讀：approve、merge 過的可能不在了。
export async function closeMr(io: MrIo) {
  detailLoads.drop()
  await io.setMr(NO_MR)
  await loadMrList(io)
}

// 換 repo：上一個 repo 的 MR 都不算了。
export async function clearMr(io: MrIo) {
  listLoads.drop()
  detailLoads.drop()
  files.clear()
  await io.setMr(EMPTY_MR)
}

const isRunning = (open: MrDetail | null) => open !== null && open.pipeline !== null && isActive(open.pipeline.status)

// 重讀看得到的那層。定時重讀時（isTimer）點開的 MR 的 pipeline 在跑才每次讀，其餘隔 CI_IDLE_REFRESH_MS（isDue）。
export async function refreshMr(io: MrIo, { isTimer = false }: { isTimer?: boolean } = {}) {
  const mr = await io.getMr()
  if (isTimer && !isDue(await io.now(), readAt, isRunning(mr.open))) return
  if (mr.opening !== 0) await loadDetail(io, mr.opening, { withSuggestions: !isTimer })
  else await loadMrList(io)
}

export async function toggleMrResolved(io: MrIo) {
  const mr = await io.getMr()
  await io.setMr({ showResolved: !mr.showResolved })
}

const arm: ArmSlot = {}
const acting = busyFlag(false)
export const mrActingNow = acting.get

// 點開的 MR 上的動作，同時只做一個；armed 不是 '' 的要按兩次（第一次變成 Confirm）。做完重讀這個 MR。
async function act(io: MrIo, armed: string, run: (p: GitLabProject, open: MrDetail) => Promise<void>) {
  const mr = await io.getMr()
  const open = mr.open
  if (acting.get() || open === null) return
  if (armed !== '') {
    const disarm = async () => {
      if ((await io.getMr()).armed === armed) await io.setMr({ armed: '' })
    }
    if (!(await isConfirmed(io, arm, mr.armed === armed, () => io.setMr({ armed, actionError: '' }), disarm))) return
  }
  acting.set(io, true)
  try {
    await io.setMr({ armed: '', actionError: '' })
    await run(await repoProject(io), open)
    await loadDetail(io, open.iid)
  } catch (err) {
    await io.setMr({ actionError: failureText(err) })
  } finally {
    acting.set(io, false)
  }
}

export async function approveMr(io: MrIo, isApprove: boolean) {
  await act(io, '', async (p, open) => {
    await api(io, p, approveUrl(p, open.iid, isApprove), { method: 'POST' })
    io.toast(`${isApprove ? 'Approved' : 'Unapproved'} !${open.iid}`)
  })
}

// Merge：GitLab 說能 merge 才做；帶上看到的 sha，期間有人推了新的 commit 就不 merge。
export async function mergeMr(io: MrIo) {
  await act(io, 'merge', async (p, open) => {
    const why = mergeBlocked(open.mergeStatus)
    if (why !== '') throw new Error(`Can't merge yet: ${why}.`)
    await api(io, p, mergeUrl(p, open.iid), { method: 'PUT', body: { sha: open.sha } })
    io.toast(`Merged !${open.iid} into ${open.target}`)
  })
}

// 套用建議：讀 source 分支最新的檔案，那幾行還是 reviewer 當時看到的才換掉，commit 進 source 分支
// （帶上讀到的 commit，期間有人推了就不 commit），再把那串討論標成已解決。
export async function applySuggestion(io: MrIo, s: MrSuggestion) {
  await act(io, `apply:${s.note}`, async (p, open) => {
    if (!s.isSingle) throw new Error('This note has more than one suggestion; apply it on GitLab.')
    if (s.old === null) throw new Error(`Couldn't read ${s.path} as the reviewer saw it; apply it on GitLab.`)
    const head = parseBranchHead((await api(io, p, branchUrl(p, open.source))).text)
    const text = (await api(io, p, rawFileUrl(p, s.path, head))).text
    const applied = applyLines(text, s.from, s.to, s.old, s.lines)
    if (applied === null) throw new Error(`Lines ${s.from}–${s.to} of ${s.path} changed after the suggestion; apply it by hand.`)
    await api(io, p, commitUrl(p), {
      method: 'POST',
      body: {
        branch: open.source,
        commit_message: `Apply suggestion to ${s.path}`,
        actions: [{ action: 'update', file_path: s.path, content: applied }],
        last_commit_id: head,
      },
    })
    await api(io, p, resolveUrl(p, open.iid, s.discussion), { method: 'PUT' })
    io.toast(`Applied the suggestion to ${s.path}`)
  })
}

// 在瀏覽器打開 GitLab 的頁面（MR、某則留言）：只開這台 GitLab 的 https 網址；網址從環境變數給 PowerShell，不拼進指令。
const OPEN_URL_ARGV = powershellArgv("$ErrorActionPreference = 'Stop'; Start-Process $env:SOAP_URL")

export async function openMrLink(io: MrIo, url: string) {
  try {
    const p = await repoProject(io)
    if (!url.startsWith(`https://${p.host}/`) && !url.startsWith(`http://${p.host}/`)) throw new Error('not a link to this GitLab')
    if (await isWindows(io)) await runOk(io, OPEN_URL_ARGV, 'Start-Process', { env: { SOAP_URL: url } })
    else await runOk(io, ['open', url], 'open')
  } catch (err) {
    await io.setMr({ actionError: `Couldn't open the link: ${errorText(err)}` })
  }
}
