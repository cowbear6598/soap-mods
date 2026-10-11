import type { GitBranch } from '../../../types'
import { ARMED_TINT } from '../../config'
import { filterBranches, searchWords } from '../../git/parse'
import type { TabBody } from './context'

// branch 分頁。parseBranches 已經排好：目前分支第一個，其餘照名稱。切換後被點的那列會搬位置、面板丟掉焦點，
// 由 focusWhenShown 補回來。
// 搜尋時只留名稱符合的分支，Remote 直接展開（不用再按 ▸），沒有符合的那組整組不畫。
export const branchTab: TabBody = ({ w, d, a }) => {
  const { Box, Button, Text } = w
  const { view: v, branchQuery: query, showRemote: isRemoteOpen } = d
  const isSearching = searchWords(query).length > 0
  const isRemoteShown = isSearching || isRemoteOpen
  const shown = filterBranches(v.branches, query)
  const locals = shown.filter(b => !b.isRemote)
  const remotes = shown.filter(b => b.isRemote)
  const hasCurrent = locals[0]?.isCurrent === true

  // 目前分支的 ● 落在縮排的空位裡，名稱跟其他分支對齊；點它不做事。
  // 右邊的 log 圖示按了到 log 分頁看這個分支；不是目前分支的本地分支前面多一個垃圾桶，按了換成打勾。
  const branchRow = (b: GitBranch) => {
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
      label: b.name,
      isDim: b.isRemote,
      isBold: b.isCurrent,
      color: b.isCurrent ? 'success' : undefined,
      indent: b.isCurrent ? 0 : undefined,
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
          {!isSearching && !hasCurrent && (
            <Box paddingLeft={2}>
              <Text dimColor>No current branch (detached HEAD?)</Text>
            </Box>
          )}
          {locals.map(branchRow)}
        </Box>
      )}
      {remotes.length > 0 && (
        <Box flexDirection="column">
          {isSearching ? (
            <Text bold dimColor>{`Remote · ${remotes.length}`}</Text>
          ) : (
            w.pressRow({
              key: 'remote:toggle',
              label: `Remote · ${remotes.length} ${isRemoteOpen ? '▾' : '▸'}`,
              isDim: true,
              isBold: true,
              indent: 0,
              onPress: () => a.toggleRemote(),
            })
          )}
          {isRemoteShown && remotes.map(branchRow)}
        </Box>
      )}
    </Box>
  )
}
