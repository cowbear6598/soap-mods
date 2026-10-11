import type { ProcessRunResult } from 'claude-code'

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// 指令失敗時的錯誤：stderr、stdout，都沒有就說它的結束碼。
export const failure = (r: ProcessRunResult, what: string) =>
  new Error(r.stderr.trim() || r.stdout.trim() || `${what} exited with ${r.exitCode}`)

// 程式根本跑不起來（沒裝、不在 PATH 上）。
export const isMissingCommand = (err: unknown) => /ENOENT|not found|cannot start/i.test(errorText(err))
