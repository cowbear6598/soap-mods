// branch 分頁：切換、刪除分支，Fetch／Pull，複製分支名稱。

import type { RenderSurface } from 'claude-code'

import type { GitSync } from '../../types'
import { SYNC_TIMEOUT_MS } from '../config'
import { NO_MESSAGES } from '../defaults'
import { arm, armedNow, busyFlag, disarm, flash } from '../shell'
import { branchId } from './parse'
import { SYNC_ARGS, gitErrorText } from './repo'
import { type GitInit, type GitIo, gitOk, isGitConfirmed } from './run'

// 切換分支要按兩次：第一次只把那列標成「再按一次」，DELETE_ARM_MS 內再按同一列才切；按別列就改標那列。
// 切的時候那列寫「switching…」，再按不理；切好、重讀完（● 移過去）才拿掉。
const switching = busyFlag('')

export const switchingNow = switching.get

export async function switchBranch(io: GitIo, name: string, isRemote: boolean) {
  const id = branchId({ name, isRemote })
  if (switching.get() !== '' || !(await isGitConfirmed(io, `switch:${id}`))) return
  switching.set(io, id)
  try {
    await gitOk(io, isRemote ? ['switch', '--track', name] : ['switch', name])
    // 不跳 toast：目前分支的 ● 本來就會移過去。丟掉的焦點交給 focusWhenShown 補。
    await io.setView(NO_MESSAGES)
    await io.refresh()
  } catch (err) {
    await io.setView({ branchError: gitErrorText(err) })
  } finally {
    switching.set(io, '')
  }
}

// 遠端分支（my/fork/feature/x）屬於哪個遠端：名稱最長的那個前綴，遠端名稱裡也可以有「/」。
async function remoteOf(io: GitIo, name: string) {
  const remotes = (await gitOk(io, ['remote'])).stdout.split('\n').map(r => r.trim())
  const remote = remotes.filter(r => r !== '' && name.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]
  if (remote === undefined) throw new Error(`No remote holds ${name}`)

  return { remote, branch: name.slice(remote.length + 1) }
}

// 刪分支要按兩次：垃圾桶按了換成打勾，DELETE_ARM_MS 內再按才真的刪；按別的垃圾桶，原本的就收回。
// 本地用 -d，有沒合併的 commit 時 git 不肯刪，換成強制刪除的打勾（-D），讓人決定要不要連那些 commit 一起丟掉。
// 遠端的推一個「:refs/heads/x」上去刪（分支名稱是遠端給的，不能讓它變成 git 的選項）；跟 Fetch 一樣不讓 git 停下來問帳密。
export async function deleteBranch(io: GitIo, name: string, isRemote: boolean) {
  const id = branchId({ name, isRemote })
  // 強制刪除的打勾還在就照它（-D），不然是一般的刪除。
  const isForce = armedNow() === `force:${id}`
  if (!(await isGitConfirmed(io, `${isForce ? 'force' : 'delete'}:${id}`))) return
  try {
    if (isRemote) {
      const { remote, branch } = await remoteOf(io, name)
      await gitOk(io, ['push', remote, `:refs/heads/${branch}`], NO_PROMPT)
    } else {
      await gitOk(io, ['branch', isForce ? '-D' : '-d', '--', name])
    }
  } catch (err) {
    const message = gitErrorText(err)
    if (!isRemote && !isForce && message.includes('not fully merged')) {
      arm(io, `force:${id}`)
      await io.setView(NO_MESSAGES)
    } else await io.setView({ ...NO_MESSAGES, branchError: message })

    return
  }

  // 刪除都不跳 toast：那列不見就是刪掉了，toast 還會把焦點搶出 Soap Panel。
  await io.leaveRow()
  await io.setView(NO_MESSAGES)
  await io.refresh()
}

// 正在跑的 Fetch／Pull，'' 是沒有。放模組變數不放 atom：atom 熱重載後還在，跑到一半被重載中斷的話
// 會一直停在「Pulling…」；模組變數跟著重載歸零。也順便擋住連按兩下。
const syncing = busyFlag<GitSync | ''>('')

export const syncingNow = syncing.get

// 連遠端的 git（Fetch、Pull、刪遠端分支）：要帳密時 git 不能停下來問（沒有地方打字），GIT_TERMINAL_PROMPT=0 讓它直接失敗；
// Windows 的認證視窗照常會跳。
const NO_PROMPT: GitInit = { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: SYNC_TIMEOUT_MS }

// branch 分頁上方的 Fetch／Pull，按了才跑。跑的時候那顆按鈕寫「Pulling…」、再按不理，跑完重讀分支（ahead／behind 跟著更新）。
export async function syncBranches(io: GitIo, kind: GitSync) {
  if (syncing.get() !== '') return
  syncing.set(io, kind)
  disarm(io)
  await io.setView(NO_MESSAGES)
  try {
    const r = await gitOk(io, SYNC_ARGS[kind], NO_PROMPT)
    io.toast(kind === 'fetch' ? 'Fetched' : r.stdout.includes('Already up to date') ? 'Already up to date' : 'Pulled')
  } catch (err) {
    await io.setView({ branchError: gitErrorText(err) })
  } finally {
    syncing.set(io, '')
  }
  await io.refresh()
}

// branch 分頁的複製按鈕：把分支名稱（遠端的含 origin/）放到按的那個畫面的剪貼簿，按鈕亮一下。
export async function copyBranchName(io: GitIo, name: string, surface: RenderSurface) {
  const r = await io.copy({ text: name, surface })
  if (!r.isCopied) return io.setView({ ...NO_MESSAGES, branchError: `Couldn't copy ${name} (${r.reason})` })
  flash(io, `copy:${name}`)
}
