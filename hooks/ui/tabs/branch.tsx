import type { GitBranch } from '../../../types'
import { ARMED_TINT, BRANCH_ROW_LIMIT, BRANCH_TREE_LIMIT } from '../../config'
import { filterBranches, searchWords } from '../../git/parse'
import { branchTree, treeRows } from '../../git/tree'
import type { TabBody } from './context'

// branch 分頁。parseBranches 已經排好：目前分支第一個，其餘照名稱。切換後被點的那列會搬位置、面板丟掉焦點，
// 由 focusWhenShown 補回來。
// 搜尋時只留名稱符合的分支，Remote 直接展開（不用再按 ▸），沒有符合的那組整組不畫。
// 分支名稱照「/」分成資料夾（feature/、soap/feature/），點資料夾開合，預設收起；目前分支固定在最上面、寫全名。
// 搜尋時資料夾全部打開、點不動。每個資料夾直屬的分支最多畫 BRANCH_ROW_LIMIT 個，整組最多 BRANCH_TREE_LIMIT 列，
// 超過的提示用搜尋縮小範圍。
export const branchTab: TabBody = ({ w, d, a }) => {
  const { Box, Button, Text } = w
  const { view: v, branchQuery: query, showRemote: isRemoteOpen, branchFolders: folderState } = d
  const isSearching = searchWords(query).length > 0
  const isRemoteShown = isSearching || isRemoteOpen
  const shown = filterBranches(v.branches, query)
  const locals = shown.filter(b => !b.isRemote)
  const remotes = shown.filter(b => b.isRemote)
  const current = locals[0]?.isCurrent === true ? locals[0] : undefined
  const indentAt = (depth: number) => 2 + depth * 2

  // 目前分支的 ● 落在縮排的空位裡，名稱跟其他分支對齊；點它不做事。
  // 右邊的 log 圖示按了到 log 分頁看這個分支；不是目前分支的本地分支前面多一個垃圾桶，按了換成打勾。
  const branchRow = (b: GitBranch, label = b.name, depth = 0) => {
    const id = `${b.isRemote ? 'r' : 'l'}:${b.name}`
    const logButton = w.iconButton(`log:${id}`, 'log', 'Log', false, () => a.viewLog(b))
    const canDelete = !b.isRemote && !b.isCurrent
    const armed = canDelete && v.deleteArmed?.name === b.name ? v.deleteArmed : null
    const deleteButton =
      canDelete &&
      w.iconButton(
        `delete:${id}`,
        armed === null ? 'trash' : 'check',
        armed === null ? 'Delete' : armed.isForce ? 'Force delete' : 'Confirm',
        false,
        () => a.deleteBranch(b.name),
        armed === null ? undefined : ARMED_TINT,
      )

    return w.pressRow({
      key: `switch:${id}`,
      label,
      isDim: b.isRemote,
      isBold: b.isCurrent,
      color: b.isCurrent ? 'success' : undefined,
      indent: b.isCurrent ? 0 : indentAt(depth),
      lead: b.isCurrent ? <Text color="success">●</Text> : undefined,
      onPress: b.isCurrent ? () => undefined : () => a.switchBranch(b.name, b.isRemote),
      trailing: (
        <Box key={`trailing:${id}`} gap={1} alignItems="center">
          {deleteButton}
          {logButton}
        </Box>
      ),
    })
  }

  // 可以開合的標題（Remote、資料夾）：搜尋時全部打開，畫成點不動的字。
  const toggleRow = (key: string, label: string, isOpen: boolean, indent: number, onPress: () => unknown, isBold = false) =>
    isSearching ? (
      <Box key={key} paddingLeft={indent}>
        <Text bold={isBold} dimColor>
          {label}
        </Text>
      </Box>
    ) : (
      w.pressRow({ key, label: `${label} ${isOpen ? '▾' : '▸'}`, isDim: true, isBold, indent, onPress })
    )

  // 一組（Local／Remote）的樹，目前分支不在裡面。資料夾列寫「feature/ · 12 ▸」，跟分支名稱一樣縮排；
  // 開合狀態存在 branchFolders，key 是「l:路徑」或「r:路徑」。
  const treeBody = (group: 'l' | 'r', list: GitBranch[]) =>
    treeRows(
      branchTree(list),
      (path, fallback) => isSearching || (folderState[`${group}:${path}`] ?? fallback),
      BRANCH_ROW_LIMIT,
      BRANCH_TREE_LIMIT,
    ).map(row => {
      if (row.kind === 'branch') return branchRow(row.branch, row.label, row.depth)
      if (row.kind === 'more') {
        return (
          <Box key={`more:${group}:${row.path}`} paddingLeft={indentAt(row.depth)}>
            <Text dimColor>{`… ${row.hidden} more; search to narrow down`}</Text>
          </Box>
        )
      }
      const key = `${group}:${row.folder.path}`

      return toggleRow(`folder:${key}`, `${row.folder.label} · ${row.folder.count}`, row.isOpen, indentAt(row.depth), () =>
        a.toggleBranchFolder(key, !row.isOpen),
      )
    })

  // Fetch／Pull 跟搜尋框同一行、放右邊，按了才跑；跑的時候那顆寫「Fetching…」／「Pulling…」，兩顆都按不動（register 擋掉）。
  const syncButtons = [
    <Button key="branch:fetch" label={d.syncing === 'fetch' ? 'Fetching…' : 'Fetch'} onPress={w.press(() => a.syncBranches('fetch'))} />,
    <Button key="branch:pull" label={d.syncing === 'pull' ? 'Pulling…' : 'Pull'} onPress={w.press(() => a.syncBranches('pull'))} />,
  ]

  // 兩組的標題對齊最左邊、分支名稱縮兩格；搜尋那行下面是切換、刪除、同步失敗的訊息，換分頁就清掉。
  return (
    <Box flexDirection="column" gap={1}>
      {w.searchField(
        'branch:search',
        query,
        text => a.searchBranches(text),
        () => a.clearBranchQuery(),
        syncButtons,
      )}
      {v.branchError !== '' && <Text color="error">{v.branchError}</Text>}
      {v.deleteArmed?.isForce === true && (
        <Text color="error">{`${v.deleteArmed.name} has unmerged commits; press again to force delete and lose them.`}</Text>
      )}
      {isSearching && shown.length === 0 && <Text dimColor>No matching branches.</Text>}
      {(!isSearching || locals.length > 0) && (
        <Box flexDirection="column">
          <Text bold dimColor>{`Local · ${locals.length}`}</Text>
          {current !== undefined
            ? branchRow(current)
            : !isSearching && (
                <Box paddingLeft={2}>
                  <Text dimColor>No current branch (detached HEAD?)</Text>
                </Box>
              )}
          {treeBody('l', current === undefined ? locals : locals.slice(1))}
        </Box>
      )}
      {remotes.length > 0 && (
        <Box flexDirection="column">
          {toggleRow('remote:toggle', `Remote · ${remotes.length}`, isRemoteOpen, 0, () => a.toggleRemote(), true)}
          {isRemoteShown && treeBody('r', remotes)}
        </Box>
      )}
    </Box>
  )
}
