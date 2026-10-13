// 改物件 atom 的幾個欄位。register.tsx 的 setView、setLog… 都經過這裡（atom 本身只能在那裡碰）。

/** `obj` with `change` applied; `obj` itself when every changed field already holds the same value, so nothing redraws. */
export function patch<T extends object>(obj: T, change: Partial<T>): T {
  const keys = Object.keys(change) as (keyof T)[]
  const isSame = keys.every(k => {
    const [a, b] = [obj[k], change[k]]
    if (a === b) return true
    // 長度不同的清單一定不一樣，不用把整份序列化來比。
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false

    return JSON.stringify(a) === JSON.stringify(b)
  })

  return isSame ? obj : { ...obj, ...change }
}
