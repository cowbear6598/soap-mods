// Soap Panel 本體：最上面的 Tab、repo 列、子分頁，中間是分頁內容，最底下是用量。
// 打開了衝突檔案、檔案的差異或 Files 分頁的檔案時，上面整塊換成合併（mergeView）、差異（diffView）或內容（fileView），Back 回來。
// 加分頁：config.ts 的 TABS／SUB_TABS 加一筆，這裡的 TAB_BODIES／SUB_TAB_BODIES 加它的內容。

import type { GitSubTab, TabId } from '../../types'
import { DANGER, SUB_TABS, TABS } from '../config'
import { isConflict } from '../git/parse'
import type { Actions, PanelData, Press, Ui } from './actions'
import { diffView } from './diffView'
import { fileView } from './fileView'
import { mergeView } from './mergeView'
import { branchTab } from './tabs/branch'
import { conflictTab } from './tabs/conflict'
import type { TabBody, TabContext } from './tabs/context'
import { diffTab } from './tabs/diff'
import { filesTab } from './tabs/files'
import { logTab } from './tabs/log'
import { servicesTab } from './tabs/services'
import { usageBar } from './usage'
import { makeWidgets } from './widgets'

const SUB_TAB_BODIES: Record<GitSubTab, TabBody> = {
  diff: diffTab,
  branch: branchTab,
  log: logTab,
  conflict: conflictTab,
}

// Git Tab：還沒讀到、不是 repo 時先擋下來，其餘交給子分頁。
const gitTab: TabBody = ctx => {
  const { Text } = ctx.w
  if (!ctx.d.view.isLoaded) return <Text dimColor>Loading…</Text>
  if (!ctx.d.view.isRepo) return <Text dimColor>This folder is not a git repo.</Text>

  return SUB_TAB_BODIES[ctx.d.subTab](ctx)
}

const TAB_BODIES: Record<TabId, TabBody> = {
  git: gitTab,
  files: filesTab,
  services: servicesTab,
}

// Git Tab 的上半部：那排 repo、子分頁圖示（有衝突時 conflict 變紅）。
// repo 排成一排：「a*」是有未提交的變更，「!」是有衝突。session 資料夾本身是 repo 時只有它一個；
// 不是的話是下一層的 repo，點了換 Git 分頁看的 repo；面板不會自己換。
function gitHeader({ w, d, a }: TabContext) {
  const { Box, Button } = w
  const v = d.view
  const repoBar =
    v.repos.length === 0 ? null : (
      <Box gap={1} flexWrap="wrap" justifyContent="center" width="100%">
        {v.repos.map(r => (
          <Button
            key={`repo:${r.name}`}
            label={`${r.name}${r.isDirty ? '*' : ''}${r.hasConflict ? ' !' : ''}`}
            variant={r.name === v.repo ? 'primary' : 'secondary'}
            onPress={w.press(() => a.selectRepo(r.name))}
          />
        ))}
      </Box>
    )

  return (
    <Box flexDirection="column">
      {repoBar}
      {repoBar !== null && w.divider}
      {w.iconBar('sub', SUB_TABS, d.subTab, id => a.selectSubTab(id), v.files.some(isConflict) ? { conflict: DANGER } : {})}
      {w.divider}
    </Box>
  )
}

// 打開了衝突檔案、檔案的差異或檔案內容：蓋掉分頁畫它；都沒有是 null。
function coverOf(ui: Ui, d: PanelData, a: Actions, press: Press) {
  if (d.merge.path !== '') return mergeView(ui, d.merge, d.isMergeBusy, a, press)
  if (d.diff.path !== '') return diffView(ui, d.diff, a, press)
  if (d.fileView.path !== '') return fileView(ui, d.fileView, d.files, a, press)

  return null
}

export function renderPanel(ui: Ui, d: PanelData, a: Actions, press: Press) {
  const w = makeWidgets(ui, d.surface === 'terminal', press)
  const { Box, Text } = w
  const ctx: TabContext = { w, d, a }
  const isGit = d.tab === 'git'
  const cover = coverOf(ui, d, a, press)

  // 整棵樹至少跟面板一樣高、內容區撐滿剩下的高度，用量就會被推到面板最底下；
  // 內容比面板還長時用量跟在後面。面板的高度只有引擎知道（bodyRows），百分比高度量不到。
  return (
    <Box flexDirection="column" minHeight={d.bodyRows}>
      {cover !== null ? (
        <Box flexDirection="column" flexGrow={1}>
          {cover}
        </Box>
      ) : (
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <Box flexDirection="column">
            {w.iconBar('tab', TABS, d.tab, id => a.selectTab(id))}
            {w.divider}
            {isGit && gitHeader(ctx)}
          </Box>
          {isGit && d.view.error !== '' && <Text color="error">{d.view.error}</Text>}
          {TAB_BODIES[d.tab](ctx)}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {w.divider}
        {usageBar(w, d.usage, d.now)}
      </Box>
    </Box>
  )
}
