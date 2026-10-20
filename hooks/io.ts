// 各分頁的動作碰外面用的介面。引擎不讓 $ 和 atom 跨檔，所以 register.tsx 把它們包成閉包（baseIo、xxxIo）交給各分頁；
// 分頁的檔案只看得到這裡的型別，不碰 $。

import type { EngineInterface, FsEntry, FsStat, ProcessRunInit, ProcessRunResult, Timer } from 'claude-code'

export type Io = {
  root: () => Promise<string>
  list: (abs: string) => Promise<FsEntry[]>
  stat: (abs: string) => Promise<FsStat>
  readFile: (abs: string) => Promise<string>
  writeFile: (abs: string, text: string) => Promise<void>
  exists: (abs: string) => Promise<boolean>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  // 環境變數 OS（引擎要在呼叫處看到變數名稱，所以只開放這一個）。
  osEnv: () => Promise<string | undefined>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeDelete: (key: string) => Promise<void>
  now: () => Promise<number>
  after: (ms: number, fn: () => unknown) => Timer
  sleep: (ms: number) => Promise<void>
  toast: (text: string) => void
  // 模組變數（正在跑的狀態）改了，叫面板重畫。
  invalidate: () => void
  submit: EngineInterface['prompt']['submit']
  // Soap Panel：捲回最上面、把焦點圈移到某顆按鈕、按的那列要被刪掉時先把焦點圈移到鄰居（見 register.tsx 的 leaveRow）。
  scrollTop: () => Promise<void>
  scrollTo: (key: string) => Promise<void>
  ringOn: (key: string) => Promise<void>
  leaveRow: (rowKey?: string) => Promise<void>
}
