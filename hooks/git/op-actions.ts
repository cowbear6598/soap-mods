// conflict 分頁：merge／rebase／cherry-pick／revert 停在衝突時的 abort、continue。

import type { MergeOp } from '../../types'
import { OP_LABEL, SYNC_TIMEOUT_MS } from '../config'
import { errorText } from '../errors'
import { isConfirmed } from '../shell'
import { type GitIo, gitArm, gitOk } from './run'

// abort／continue：成功跳 toast，失敗把錯誤留在 conflict 分頁，最後重讀狀態。
// 逾時跟 Fetch 一樣長：commit 會跑 pre-commit hook（lint、測試），預設的逾時砍掉它會留下 index.lock。
async function runOp(io: GitIo, op: Exclude<MergeOp, ''>, args: string[], done: string, env?: Record<string, string>) {
  let opError = ''
  try {
    await gitOk(io, args, { env, timeoutMs: SYNC_TIMEOUT_MS })
    io.toast(`${OP_LABEL[op]} ${done}`)
  } catch (err) {
    opError = errorText(err)
  }
  await io.setView({ isAbortArmed: false, opError })
  await io.refresh()
}

// abort 要按兩次：第一次只把按鈕換成確認，DELETE_ARM_MS 後收回。
export async function abortOp(io: GitIo) {
  const v = await io.getView()
  if (v.op === '') return
  const arm = () => io.setView({ isAbortArmed: true, opError: '' })
  if (!(await isConfirmed(io, gitArm, v.isAbortArmed, arm, () => io.setView({ isAbortArmed: false })))) return
  await runOp(io, v.op, [v.op, '--abort'], 'aborted')
}

// 所有衝突都解完後繼續：merge 是直接 commit（用預設訊息），其他是 --continue。
// GIT_EDITOR=true 讓 git 不開編輯器、直接用預設的 commit 訊息。
export async function continueOp(io: GitIo) {
  const v = await io.getView()
  if (v.op === '') return
  const args = v.op === 'merge' ? ['commit', '--no-edit'] : [v.op, '--continue']
  await runOp(io, v.op, args, 'continued', { GIT_EDITOR: 'true' })
}
