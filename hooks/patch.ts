// 改物件 atom 的幾個欄位。register.tsx 的 setView、setLog… 都經過這裡（atom 本身只能在那裡碰）。

/** `obj` with `change` applied; `obj` itself when every changed field already holds the same value, so nothing redraws. */
export function patch<T extends object>(obj: T, change: Partial<T>): T {
  const keys = Object.keys(change) as (keyof T)[]
  const isSame = keys.every(k => obj[k] === change[k] || JSON.stringify(obj[k]) === JSON.stringify(change[k]))

  return isSame ? obj : { ...obj, ...change }
}
