// Claude 用 Write／Edit 寫了 Soap Panel 看得懂的檔案（plan.yaml、wiki 草稿）：寫完檢查格式。

import type { ToolCallResult } from 'claude-code'

import type { Io } from './io'
import { checkPlanWrite } from './spec/actions'
import { isPlanPath } from './spec/parse'
import { checkDraftWrite } from './wiki/actions'
import { isDraftPath } from './wiki/parse'

// Write／Edit 的結果 ran：寫的是 plan.yaml 或 wiki 草稿、寫成功了才檢查。讀不回來就不管，工具結果照原樣給 Claude。
export async function checkWrite<R extends ToolCallResult>(io: Io, path: string, ran: R): Promise<R> {
  if (ran.deny !== undefined || ran.isError === true) return ran
  const checked = isPlanPath(path) ? checkPlanWrite(io, path) : isDraftPath(path) ? checkDraftWrite(io, path) : undefined
  const note = await checked?.catch(() => undefined)

  return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
}
