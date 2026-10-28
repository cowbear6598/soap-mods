// 外面來的 JSON（GitLab 給的、$.store 裡的）不信任它的型別：每個欄位都檢查過才用，型別不對就當成空的（CI、MR、HTTP 共用）。

export type Json = Record<string, unknown>

export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
export const str = (v: unknown) => (typeof v === 'string' ? v : '')
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
export const obj = (v: unknown): Json => (isObject(v) ? v : {})
export const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : [])
// 只留值是文字的欄位。
export const texts = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(obj(v)).filter((e): e is [string, string] => typeof e[1] === 'string'))

// ISO 時間轉成 epoch 秒（跟 GitCommit.time 一樣，formatAgo 用）；讀不懂是 0。
export const seconds = (iso: unknown) => {
  const ms = Date.parse(str(iso))

  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}

// what：錯誤訊息裡的名稱（「a pipeline」）。
export function parseObject(out: string, what: string): Json {
  const data: unknown = JSON.parse(out)
  if (!isObject(data)) throw new Error(`GitLab did not return ${what}.`)

  return data
}

export function parseArray(out: string): Json[] {
  const data: unknown = JSON.parse(out)
  if (!Array.isArray(data)) throw new Error('GitLab did not return a list.')

  return list(data)
}
