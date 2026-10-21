// CI 子分頁：GitLab API 回的 JSON 轉成畫面用的樣子、job 照 stage 分組、job log 拿掉顏色和 section 標記。

import type { CiBranch, CiJob, CiJobAction, CiPipeline } from '../../types'
import { CI_PAGE, CI_RECENT, CI_STATUS_STYLE, CI_TRACE_MAX_CHARS } from '../config'
import { type Json, isObject, num, parseArray, parseObject, seconds, str } from '../json'

function toPipeline(p: Json): CiPipeline {
  return {
    id: num(p.id),
    iid: num(p.iid),
    ref: str(p.ref),
    sha: str(p.sha),
    shortSha: str(p.sha).slice(0, 8),
    title: '',
    status: str(p.status),
    source: str(p.source),
    time: seconds(p.created_at),
    webUrl: str(p.web_url),
  }
}

function toJob(j: Json): CiJob {
  return {
    id: num(j.id),
    name: str(j.name),
    stage: str(j.stage),
    status: str(j.status),
    duration: typeof j.duration === 'number' ? j.duration : null,
    allowFailure: j.allow_failure === true,
  }
}

export const parsePipelines = (out: string) => parseArray(out).map(toPipeline)

export const parsePipeline = (out: string): CiPipeline => toPipeline(parseObject(out, 'a pipeline'))

export const parseJob = (out: string): CiJob => toJob(parseObject(out, 'a job'))

// GitLab 照 id 由新到舊給；畫的時候要由舊到新（跟 stage 的順序一樣）。
export const parseJobs = (out: string) => parseArray(out).map(toJob).sort((a, b) => a.id - b.id)

// GitLab 的錯誤 JSON：{"message":"404 Project Not Found"} 或 {"error":"insufficient_scope",…}；不是 JSON（代理伺服器的錯誤頁）是 ''。
export function parseApiMessage(out: string) {
  try {
    const data: unknown = JSON.parse(out)

    return isObject(data) ? str(data.message) || str(data.error) : ''
  } catch {
    return ''
  }
}

// /user 回的帳號名稱。
export function parseUser(out: string) {
  const data: unknown = JSON.parse(out)

  return isObject(data) ? str(data.username) : ''
}

// 分支清單：pipeline（由新到舊）照 ref 分組，每個 ref 留最新那條，順序就是最近跑過的先。
export function toBranches(pipelines: readonly CiPipeline[]): CiBranch[] {
  const seen = new Map<string, CiBranch>()
  for (const p of pipelines) if (!seen.has(p.ref)) seen.set(p.ref, { name: p.ref, pipeline: p })

  return [...seen.values()]
}

// GitLab 的分支清單只要名字。
export const parseBranchNames = (out: string) => parseArray(out).map(b => str(b.name)).filter(n => n !== '')

// commit 的 sha → 標題。
export const parseCommitTitles = (out: string) => new Map(parseArray(out).map(c => [str(c.id), str(c.title)]))

// 一個 repo 的 GitLab 專案：API 的網址前段（https://主機/api/v4）、主機（token 照主機存）和專案路徑（group/sub/repo）。
export type GitLabProject = { api: string; host: string; path: string }

// 確定不是 GitLab 的主機：GitHub、Bitbucket、Azure DevOps 的 repo 不畫貼 token 的框（貼了也只會 404）。
const NOT_GITLAB_HOSTS = /(^|\.)(github\.com|bitbucket\.org|dev\.azure\.com|visualstudio\.com)(:\d+)?$/i

// 從 remote 網址認出 GitLab 專案：https://host/group/repo.git、git@host:group/repo.git、ssh://git@host:2222/group/repo.git。
// SSH 的 port 是 git 的，不是網頁的：API 一律走 https 的預設 port；http(s) 的照寫的。認不出來是 undefined。
export function parseRemote(url: string): GitLabProject | undefined {
  const text = url.trim()
  const web = /^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(text)
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(text) ?? /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(text)
  const [scheme, host, path] = web !== null ? [web[1], web[2], web[3]] : ssh !== null ? ['https', ssh[1], ssh[2]] : []
  if (scheme === undefined || host === undefined || path === undefined || !path.includes('/') || NOT_GITLAB_HOSTS.test(host)) return undefined

  return { api: `${scheme}://${host}/api/v4`, host, path }
}

export const projectUrl = (p: GitLabProject) => `${p.api}/projects/${encodeURIComponent(p.path)}`

// 最新的 CI_RECENT 條（整理成分支清單）。
export const recentPipelinesUrl = (p: GitLabProject) => `${projectUrl(p)}/pipelines?per_page=${CI_RECENT}`
export const pipelinesUrl = (p: GitLabProject, ref: string, page: number) =>
  `${projectUrl(p)}/pipelines?per_page=${CI_PAGE}&page=${page + 1}&ref=${encodeURIComponent(ref)}`
// 名稱裡有這段字的分支（搜尋時找最近沒跑 pipeline 的）。
export const branchSearchUrl = (p: GitLabProject, query: string) => `${projectUrl(p)}/repository/branches?per_page=${CI_PAGE}&search=${encodeURIComponent(query)}`
// 分支上最新的 commit（拿 pipeline 的 commit 標題）。
export const commitsUrl = (p: GitLabProject, ref: string) => `${projectUrl(p)}/repository/commits?per_page=${CI_RECENT}&ref_name=${encodeURIComponent(ref)}`
export const pipelineUrl = (p: GitLabProject, id: number) => `${projectUrl(p)}/pipelines/${id}`
// 一條 pipeline 最多列 100 個 job（GitLab 一頁的上限）。
export const JOBS_LIMIT = 100
export const jobsUrl = (p: GitLabProject, pipelineId: number) => `${projectUrl(p)}/pipelines/${pipelineId}/jobs?per_page=${JOBS_LIMIT}`
// 跑、重跑（POST）：重跑 pipeline 裡失敗的 job、跑 manual job（play）、重跑一個 job（retry，GitLab 會開一個新的 job）。
export const retryPipelineUrl = (p: GitLabProject, id: number) => `${projectUrl(p)}/pipelines/${id}/retry`
export const jobActionUrl = (p: GitLabProject, id: number, kind: CiJobAction) => `${projectUrl(p)}/jobs/${id}/${kind}`
export const traceUrl = (p: GitLabProject, jobId: number) => `${projectUrl(p)}/jobs/${jobId}/trace`
// 存 token 前確認它能用，順便拿登入的帳號名稱。
export const userUrl = (p: GitLabProject) => `${p.api}/user`

// job 照 stage 分組，stage 照第一次出現的順序（job 已經由舊到新排好，就是 pipeline 跑的順序）。
export function stageGroups(jobs: readonly CiJob[]): { stage: string; jobs: CiJob[] }[] {
  const groups = new Map<string, CiJob[]>()
  for (const j of jobs) {
    const list = groups.get(j.stage)
    if (list === undefined) groups.set(j.stage, [j])
    else list.push(j)
  }

  return [...groups].map(([stage, list]) => ({ stage, jobs: list }))
}

// 還會變的狀態：pipeline、job 停在這些時，log 和狀態要繼續重讀。
const ACTIVE = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running'])
export const isActive = (status: string) => ACTIVE.has(status)

const PENDING_STYLE = { mark: '○', theme: 'warning' }
export const statusStyle = (status: string) => CI_STATUS_STYLE[status] ?? PENDING_STYLE

// 跑了多久：「45s」、「4m 8s」、「1h 2m」。
export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`

  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// GitLab runner 的 log：每段開頭結尾有「section_start:時間:名稱[選項]\r\e[0K」的標記，其餘是 ANSI 顏色碼；
// 進度列用 \r 蓋掉同一行，只留最後一次。
const SECTION_MARK = /section_(?:start|end):\d+:[^\r\n]*\r(?:\x1b\[0K)?/g
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// Code 只畫得了 tab 和換行這兩個控制字元，其他的（落單的 \x1b、退格）拿掉。
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

export function cleanTrace(raw: string): string {
  return raw
    .replace(SECTION_MARK, '')
    .replace(ANSI, '')
    .split('\n')
    .map(line => {
      const body = line.endsWith('\r') ? line.slice(0, -1) : line

      return body.slice(body.lastIndexOf('\r') + 1)
    })
    .join('\n')
    .replace(CONTROL, '')
}

// 太長的 log 只留最後 CI_TRACE_MAX_CHARS 字（切在行首）：失敗的原因通常在最後面。
export function traceTail(text: string): { text: string; isTruncated: boolean } {
  if (text.length <= CI_TRACE_MAX_CHARS) return { text, isTruncated: false }
  const start = text.indexOf('\n', text.length - CI_TRACE_MAX_CHARS)

  return { text: text.slice(start === -1 ? text.length - CI_TRACE_MAX_CHARS : start + 1), isTruncated: true }
}
