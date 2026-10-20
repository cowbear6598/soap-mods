// Git 分頁各動作共用的：GitIo、選中的 repo、跑 git、要按兩次的按鈕。

import type { EngineInterface } from 'claude-code'

import type { Cover, GitView, LogView, SubTabs } from '../../types'
import { NO_ARMED, NO_MESSAGES } from '../defaults'
import { failure } from '../errors'
import type { Io } from '../io'
import { type ArmSlot, isConfirmed } from '../shell'
import type { Repo } from './repo'
import { GIT_ENV } from './repo'

export type GitIo = Io & {
  getView: () => Promise<GitView>
  setView: (change: Partial<GitView>) => Promise<void>
  getLog: () => Promise<LogView>
  setLog: (change: Partial<LogView>) => Promise<void>
  updateLog: (fn: (l: LogView) => LogView) => Promise<unknown>
  getLogQuery: () => Promise<string>
  setLogQuery: (text: string) => Promise<unknown>
  getCover: () => Promise<Cover>
  updateCover: (fn: (c: Cover) => Cover) => Promise<unknown>
  getSubTabs: () => Promise<SubTabs>
  copy: EngineInterface['ui']['copy']
  // 關掉差異、合併、檔案內容，回到分頁（register.tsx 的 closeCover）。
  closeCover: () => Promise<void>
  // 重讀 Git 分頁（status.ts 的 refresh）：動作不 import status.ts，免得互相 import。
  refresh: () => Promise<void>
}

// current：Git 分頁正在看的 repo。
// list：那排 repo 按鈕。session 資料夾本身是 repo 時只有它一個；不是的話（例如在 company/ 開，底下 a、b、c
// 各是一個 repo）是下一層找到的 repo，照名稱排。每次 refresh 重找，新 clone 的也會出現。
export const repos: { current: Repo | undefined; list: Repo[] } = { current: undefined, list: [] }

export type GitInit = { cwd?: string; env?: Record<string, string>; timeoutMs?: number }

// 預設在選中的 repo 根目錄跑；init.cwd 指定別的資料夾（找 repo、看其他 repo 的狀態）。
// LC_ALL=C：有些錯誤是看 git 的英文訊息判斷的（not a git repository、not fully merged），不能被翻譯。
// GIT_ENV：面板每個回合都自己跑 git，repo 的設定不能讓它執行別的指令（見 git/repo.ts）。
export async function git(io: Io, args: string[], init: GitInit = {}) {
  return io.run(['git', '-c', 'core.quotepath=false', ...args], {
    cwd: init.cwd ?? repos.current?.root,
    env: { ...GIT_ENV, LC_ALL: 'C', ...init.env },
    timeoutMs: init.timeoutMs,
  })
}

export async function gitOk(io: Io, args: string[], init?: GitInit) {
  const r = await git(io, args, init)
  if (r.exitCode !== 0) throw failure(r, `git ${args.join(' ')}`)

  return r
}

export const inRepo = (path: string) => (repos.current === undefined ? path : `${repos.current.root}/${path}`)

// 待確認的刪除、捨棄（打勾）、切換（再按一次）一次只有一個。
export const gitArm: ArmSlot = {}

export const armGit = (io: GitIo, armed: Partial<GitView>) =>
  io.setView({ ...NO_MESSAGES, ...armed })

export const isGitConfirmed = (io: GitIo, isArmed: boolean, armed: Partial<GitView>) =>
  isConfirmed(io, gitArm, isArmed, () => armGit(io, armed), () => io.setView(NO_ARMED))
