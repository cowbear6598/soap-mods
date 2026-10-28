// CI、MR 子分頁共用。不碰 $，用 register.tsx 給的 fetch（$.http.fetch）；token 的存讀在 ci/token.ts。

import type { HttpInit, HttpResponse } from 'claude-code'

import { type GitLabProject, parseApiMessage, parseRemote } from './ci/parse'
import { readToken } from './ci/token'
import { CI_IDLE_REFRESH_MS } from './config'
import { git, repos } from './git/run'
import type { Io } from './io'
import { lastRead } from './latest'
import { openUrl } from './shell'

export type GitLabIo = Io & { fetch: (url: string, init?: HttpInit) => Promise<HttpResponse> }

const NO_REPO = 'This folder is not a git repo.'
const NOT_GITLAB = "This repo's remote is not a GitLab project."
const TOKEN_REFUSED = 'GitLab refused the saved token (401): it expired or was revoked. Paste a new one.'

// 選中的 repo 的 GitLab 專案：看 origin，沒有 origin 就看第一個 remote。
// 照 repo 記著：定時重讀每 CI_REFRESH_MS 好幾個讀取都要它，remote 幾乎不會變；換 repo（root 不同）、讀失敗就重問 git。
const project = lastRead<GitLabProject>()

export function repoProject(io: Io): Promise<GitLabProject> {
  const root = repos.current?.root
  if (root === undefined) return Promise.reject(new Error(NO_REPO))

  return project.read(root, false, async () => {
    const remotes = (await git(io, ['remote'])).stdout.split('\n').map(r => r.trim()).filter(r => r !== '')
    const name = remotes.includes('origin') ? 'origin' : remotes[0]
    const url = name === undefined ? undefined : await git(io, ['remote', 'get-url', name])
    const found = url?.exitCode === 0 ? parseRemote(url.stdout) : undefined
    if (found === undefined) throw new Error(NOT_GITLAB)

    return found
  })
}

// 401：token 失效，畫面要打開換 token 的框；其他錯誤照狀況說。
export class TokenRefused extends Error {}

type ApiInit = { method?: 'GET' | 'POST' | 'PUT'; token?: string; body?: unknown }

// 打 GitLab API（沒給 token 就用存著的）；不是 2xx 就丟出看得懂的錯誤。GET 以外是會改東西的（跑、重跑、approve、merge、commit）。
export async function api(io: GitLabIo, p: GitLabProject, url: string, { method = 'GET', token, body }: ApiInit = {}) {
  const headers: Record<string, string> = { 'PRIVATE-TOKEN': token ?? (await readToken(io, p.host)) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await io.fetch(url, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) })
  if (r.ok) return r
  if (r.status === 401) throw new TokenRefused(TOKEN_REFUSED)
  const message = parseApiMessage(r.text)
  if (r.status === 403) {
    throw new Error(
      method === 'GET'
        ? "The token can't read this (403): it needs the read_api or api scope."
        : `GitLab won't let this token do it (403): the token needs the api scope, and your role on the project must allow it (a protected branch may need more).${message === '' ? '' : ` GitLab said: ${message}`}`,
    )
  }
  if (r.status === 404) {
    throw new Error(`GitLab can't find ${repos.current?.name ?? 'this repo'}'s project with the saved token (404): your account (or a project token) has no access to it.`)
  }

  throw new Error(`GitLab answered ${r.status}${message === '' ? '' : `: ${message}`}`)
}

// 定時重讀：有跑著的就每次讀；沒有就隔 CI_IDLE_REFRESH_MS 才讀（新開的 pipeline 晚一點才出現）。
export const isDue = (now: number, readAt: number, isRunning: boolean) => isRunning || now - readAt >= CI_IDLE_REFRESH_MS

// 只開這台 GitLab 的網址。瀏覽器常開在後面，跳 toast 才看得出開了。
export async function openGitLabUrl(io: Io, url: string) {
  const p = await repoProject(io)
  if (!url.startsWith(`https://${p.host}/`) && !url.startsWith(`http://${p.host}/`)) throw new Error('not a link to this GitLab')
  await openUrl(io, url)
  io.toast('Opened in the browser')
}
