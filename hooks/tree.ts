// 名稱照「/」拆成資料夾樹：分支（feature/login、soap/feature/login）和 wiki 頁面（db/schema.md）共用。

type TreeFolder<T> = {
  /** 從樹根到這裡的路徑（含結尾的 /），例如 `soap/feature/`；同一棵樹裡不重複。 */
  path: string
  /** 畫在列上的名稱：只有一個子資料夾、沒有項目的那層會併進來，例如 `soap/feature/`。 */
  label: string
  folders: TreeFolder<T>[]
  /** 直屬的項目，和畫在列上的名稱（扣掉所在資料夾的路徑）。 */
  items: { item: T; label: string }[]
  /** 底下（含更深層）共幾個項目。 */
  count: number
}

const folder = <T>(path: string, label: string): TreeFolder<T> => ({ path, label, folders: [], items: [], count: 0 })

/**
 * 每個項目依 nameOf 的名稱放進資料夾；保留傳入的順序，資料夾在前、項目在後。
 * skipLoneRoot：最外層只有一個資料夾、沒有項目時（Remote 只有 origin/）跳過它，直接從它裡面開始。
 */
export function pathTree<T>(list: readonly T[], nameOf: (item: T) => string, skipLoneRoot = false): TreeFolder<T> {
  const root = folder<T>('', '')
  // 分支上千個時，每層用 find 找資料夾太慢；整棵樹共用一張路徑 → 資料夾的表。
  const byPath = new Map<string, TreeFolder<T>>()

  for (const item of list) {
    const parts = nameOf(item).split('/')
    const label = parts.pop() ?? ''
    let node = root
    node.count++
    for (const part of parts) {
      const path = `${node.path}${part}/`
      let child = byPath.get(path)
      if (child === undefined) {
        child = folder(path, `${part}/`)
        byPath.set(path, child)
        node.folders.push(child)
      }
      child.count++
      node = child
    }
    node.items.push({ item, label })
  }
  const lone = root.folders[0]
  const top = skipLoneRoot && root.items.length === 0 && root.folders.length === 1 && lone !== undefined ? lone : root
  top.folders = top.folders.map(compact)

  return top
}

// 只有一個子資料夾、沒有項目的那層跟子資料夾併成一列（soap/ → feature/ 變成 soap/feature/）。樹是剛建的，直接改。
function compact<T>(f: TreeFolder<T>): TreeFolder<T> {
  const only = f.folders[0]
  if (f.items.length === 0 && f.folders.length === 1 && only !== undefined) {
    only.label = `${f.label}${only.label}`

    return compact(only)
  }
  f.folders = f.folders.map(compact)

  return f
}

type TreeRow<T> =
  | { kind: 'folder'; folder: TreeFolder<T>; depth: number; isOpen: boolean }
  | { kind: 'item'; item: T; label: string; depth: number }
  /** 沒畫的項目有幾個：path 是那個資料夾（直屬的超過 limit），'*' 是整棵超過 total。 */
  | { kind: 'more'; path: string; hidden: number; depth: number }

/**
 * 依開合狀態攤平成要畫的列。`isOpen(path, fallback)` 決定資料夾開不開；fallback 是預設：
 * 一層裡只有這一個資料夾（沒有別的資料夾或項目，例如 Local 的分支全在 feature/ 底下）時預設打開，其餘預設收起。
 * 每個資料夾（含最外層）直屬的項目最多 limit 個，其餘收成一列 more；整棵最多 total 列（搜尋全打開時才擋得住），
 * 超過的項目在最後收成一列 more。
 */
export function treeRows<T>(
  root: TreeFolder<T>,
  isOpen: (path: string, fallback: boolean) => boolean,
  limit = Infinity,
  total = Infinity,
): TreeRow<T>[] {
  const rows: TreeRow<T>[] = []
  let cut = 0
  const push = (row: TreeRow<T>, items: number) => {
    if (rows.length < total) rows.push(row)
    else cut += items
  }
  const walk = (node: TreeFolder<T>, depth: number) => {
    const isAlone = node.folders.length === 1 && node.items.length === 0
    for (const f of node.folders) {
      const open = isOpen(f.path, isAlone)
      push({ kind: 'folder', folder: f, depth, isOpen: open }, open ? 0 : f.count)
      if (open) walk(f, depth + 1)
    }
    for (const { item, label } of node.items.slice(0, limit)) push({ kind: 'item', item, label, depth }, 1)
    const hidden = node.items.length - limit
    if (hidden > 0) push({ kind: 'more', path: node.path, hidden, depth }, hidden)
  }
  walk(root, 0)
  if (cut > 0) rows.push({ kind: 'more', path: '*', hidden: cut, depth: 0 })

  return rows
}
