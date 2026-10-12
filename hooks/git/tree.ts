import type { GitBranch } from '../../types'

// 分支名稱照「/」拆成資料夾樹，像 feature/login、soap/feature/login。

export type BranchFolder = {
  /** 從樹根到這裡的路徑（含結尾的 /），例如 `soap/feature/`；同一組（Local／Remote）裡不重複。 */
  path: string
  /** 畫在列上的名稱：只有一個子資料夾、沒有分支的那層會併進來，例如 `soap/feature/`。 */
  label: string
  folders: BranchFolder[]
  branches: GitBranch[]
  /** 底下（含更深層）共幾個分支。 */
  count: number
}

const folder = (path: string, label: string): BranchFolder => ({ path, label, folders: [], branches: [], count: 0 })

/** 每個分支依名稱放進資料夾；保留傳入的順序，資料夾在前、分支在後。 */
export function branchTree(branches: GitBranch[]): BranchFolder {
  const root = folder('', '')
  // 分支上千個時，每層用 find 找資料夾太慢；整棵樹共用一張路徑 → 資料夾的表。
  const byPath = new Map<string, BranchFolder>()

  for (const b of branches) {
    const parts = b.name.split('/')
    parts.pop()
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
    node.branches.push(b)
  }
  root.folders = root.folders.map(compact)

  return root
}

// 只有一個子資料夾、沒有分支的那層跟子資料夾併成一列（soap/ → feature/ 變成 soap/feature/）。樹是剛建的，直接改。
function compact(f: BranchFolder): BranchFolder {
  const only = f.folders[0]
  if (f.branches.length === 0 && f.folders.length === 1 && only !== undefined) {
    only.label = `${f.label}${only.label}`

    return compact(only)
  }
  f.folders = f.folders.map(compact)

  return f
}

export type TreeRow =
  | { kind: 'folder'; folder: BranchFolder; depth: number; isOpen: boolean }
  /** label 是分支名稱扣掉所在資料夾的路徑。 */
  | { kind: 'branch'; branch: GitBranch; label: string; depth: number }
  /** 沒畫的分支有幾個：path 是那個資料夾（直屬的超過 limit），'*' 是整組超過 total。 */
  | { kind: 'more'; path: string; hidden: number; depth: number }

/**
 * 依開合狀態攤平成要畫的列。`isOpen(path, fallback)` 決定資料夾開不開；fallback 是預設：
 * 一層裡只有這一個資料夾（沒有別的資料夾或分支，例如 Remote 底下只有 origin/）時預設打開，其餘預設收起。
 * 每個資料夾（含最外層）直屬的分支最多 limit 個，其餘收成一列 more；整組最多 total 列（搜尋全打開時才擋得住），
 * 超過的分支在最後收成一列 more。
 */
export function treeRows(
  root: BranchFolder,
  isOpen: (path: string, fallback: boolean) => boolean,
  limit = Infinity,
  total = Infinity,
): TreeRow[] {
  const rows: TreeRow[] = []
  let cut = 0
  const push = (row: TreeRow, branches: number) => {
    if (rows.length < total) rows.push(row)
    else cut += branches
  }
  const walk = (node: BranchFolder, depth: number) => {
    const isAlone = node.folders.length === 1 && node.branches.length === 0
    for (const f of node.folders) {
      const open = isOpen(f.path, isAlone)
      push({ kind: 'folder', folder: f, depth, isOpen: open }, open ? 0 : f.count)
      if (open) walk(f, depth + 1)
    }
    for (const branch of node.branches.slice(0, limit)) {
      push({ kind: 'branch', branch, label: branch.name.slice(node.path.length), depth }, 1)
    }
    const hidden = node.branches.length - limit
    if (hidden > 0) push({ kind: 'more', path: node.path, hidden, depth }, hidden)
  }
  walk(root, 0)
  if (cut > 0) rows.push({ kind: 'more', path: '*', hidden: cut, depth: 0 })

  return rows
}
