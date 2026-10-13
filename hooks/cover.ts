// Soap Panel 一次只蓋一個畫面（差異、合併、檔案內容）在分頁上：換上一個就換掉另一個，不用互相清。
// 狀態（atom）在 register.tsx，這裡是讀、改它的純函式。

import type { Cover } from '../types'
import { patch } from './patch'

type Shown = Exclude<Cover, { kind: 'none' }>
type Kind = Shown['kind']
type DataOf<K extends Kind> = { [C in Shown as C['kind']]: C['data'] }[K]

export const NO_COVER: Cover = { kind: 'none' }

/** What `c` shows when it is a `kind`, else undefined. */
export function coverData<K extends Kind>(c: Cover, kind: K): DataOf<K> | undefined {
  return c.kind === kind ? ((c as Shown).data as DataOf<K>) : undefined
}

/** `c` showing `data` as a `kind`; `c` itself when it already shows the same, so nothing redraws. */
export function showCover<K extends Kind>(c: Cover, kind: K, data: DataOf<K>): Cover {
  const cur = coverData(c, kind)

  return cur !== undefined && patch(cur, data) === cur ? c : ({ kind, data } as Cover)
}

/** `c` with the `kind` it shows patched by `change`; `c` itself when it shows another kind or nothing changed. */
export function patchCover<K extends Kind>(c: Cover, kind: K, change: Partial<DataOf<K>>): Cover {
  const cur = coverData(c, kind)
  const next = cur === undefined ? cur : patch(cur, change)

  return next === cur ? c : ({ kind, data: next } as Cover)
}
