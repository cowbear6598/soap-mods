// Soap Panel 本體：最上面的 Tab、repo 列（Git）、子分頁（SUB_TABS 有列的 Tab），中間是分頁內容，最底下是用量。
// 打開了衝突檔案、檔案的差異或 Files 分頁的檔案時，上面整塊換成合併（mergeView）、差異（diffView）或內容（fileView），Back 回來。

import type { GitSubTab, SubTabs, TabId } from '../../types'
import { DANGER, SUB_TABS, TABS, type Tint, hasSubTabs } from '../config'
import { isConflict } from '../git/parse'
import type { Actions, PanelData, Press, Ui } from './actions'
import { diffView } from './diffView'
import { fileView } from './fileView'
import { unboundHotkeys } from './keys'
import { mergeView } from './mergeView'
import { branchTab } from './tabs/branch'
import { conflictTab } from './tabs/conflict'
import type { TabBody, TabContext } from './tabs/context'
import { dbTab } from './tabs/db'
import { diffTab } from './tabs/diff'
import { filesTab } from './tabs/files'
import { logTab } from './tabs/log'
import { servicesTab } from './tabs/services'
import { specTab } from './tabs/spec'
import { usageBar } from './usage'
import { type Widgets, makeWidgets } from './widgets'

const GIT_SUB_TAB_BODIES: Record<GitSubTab, TabBody> = {
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

  return GIT_SUB_TAB_BODIES[ctx.d.subTabs.git](ctx)
}

const TAB_BODIES: Record<TabId, TabBody> = {
  git: gitTab,
  files: filesTab,
  services: servicesTab,
  spec: specTab,
  db: dbTab,
}

// Git Tab 的那排 repo：「a*」是有未提交的變更，「!」是有衝突。session 資料夾本身是 repo 時只有它一個；
// 不是的話是下一層的 repo，點了換 Git 分頁看的 repo；面板不會自己換。
function repoBar({ w, d, a }: TabContext) {
  const { Box, Button } = w
  const v = d.view
  if (v.repos.length === 0) return null

  return (
    <Box flexDirection="column">
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
      {divider(w)}
    </Box>
  )
}

// 面板上的分隔線左右各空一格，跟分頁內容一樣不貼邊。
const divider = ({ Box, divider }: Widgets) => <Box paddingX={1}>{divider}</Box>

// 子分頁圖示列；tints 是要上色的子分頁。
function subTabBar<T extends keyof SubTabs>({ w, d, a }: TabContext, tab: T, tints: Partial<Record<SubTabs[T], Tint>> = {}) {
  const { Box } = w

  return (
    <Box flexDirection="column">
      {w.iconBar<SubTabs[T]>('sub', SUB_TABS[tab], d.subTabs[tab], id => a.selectSubTab(tab, id), tints)}
      {divider(w)}
    </Box>
  )
}

// 打開了衝突檔案、檔案的差異或檔案內容：蓋掉分頁畫它；都沒有是 null。
function coverView(ui: Ui, w: Widgets, d: PanelData, a: Actions, press: Press) {
  const c = d.cover
  switch (c.kind) {
    case 'merge':
      return mergeView(ui, c.data, d.view.op, d.isMergeBusy, a, press)
    case 'diff':
      return diffView(ui, w, c.data, d.diffPages, a, press)
    case 'file':
      return fileView(ui, c.data, d.files, a, press)
    case 'none':
      return null
  }
}

export function renderPanel(drawUi: Ui, d: PanelData, a: Actions, press: Press) {
  const isTerminal = d.surface === 'terminal'
  const bound = new Set<string>()
  const ui = recordHotkeys(drawUi, bound)
  const w = makeWidgets(ui, isTerminal, press, a.focusInput)
  const { Box, Text } = w
  const ctx: TabContext = { w, d, a }
  const isGit = d.tab === 'git'
  const cover = coverView(ui, w, d, a, press)

  const content =
    cover !== null ? (
      <Box flexDirection="column" flexGrow={1}>
        {cover}
      </Box>
    ) : (
      <Box flexDirection="column" gap={1} flexGrow={1}>
        <Box flexDirection="column">
          {w.iconBar('tab', TABS, d.tab, id => a.selectTab(id))}
          {divider(w)}
          {isGit && repoBar(ctx)}
          {isGit ? subTabBar(ctx, 'git', d.view.files.some(isConflict) ? { conflict: DANGER } : {}) : hasSubTabs(d.tab) && subTabBar(ctx, d.tab)}
        </Box>
        {/* 分頁內容左右各空一格，不貼著面板邊。 */}
        <Box flexDirection="column" gap={1} paddingX={1}>
          {isGit && d.view.error !== '' && <Text color="error">{d.view.error}</Text>}
          {TAB_BODIES[d.tab](ctx)}
        </Box>
      </Box>
    )

  // 整棵樹至少跟面板一樣高、內容區撐滿剩下的高度，用量就會被推到面板最底下；
  // 內容比面板還長時用量跟在後面。面板的高度只有引擎知道（bodyRows），百分比高度量不到。
  return (
    <Box flexDirection="column" minHeight={d.bodyRows}>
      {content}
      <Box flexDirection="column" marginTop={1}>
        {divider(w)}
        {usageBar(w, d.usage, d.now)}
      </Box>
      {!isTerminal && strayKeys(w, bound)}
    </Box>
  )
}

// 包住 ui.Button：畫的時候順手把綁的快捷鍵記進 bound，不用畫完再走一遍整棵樹找。
function recordHotkeys(ui: Ui, bound: Set<string>): Ui {
  const Button: Ui['Button'] = props => {
    if (typeof props.hotkey === 'string') bound.add(props.hotkey)

    return ui.Button(props)
  }

  return { ...ui, Button }
}

const NOOP = () => undefined

// 這個畫面沒綁（bound 以外）的字母、數字，各綁一顆藏起來、按了不做事的按鈕：沒人接的鍵桌面版會交給輸入框，
// 焦點跟著跑過去（log 分頁按 m）。只有桌面版會這樣，終端機不畫。要在整個畫面都畫完後才呼叫，bound 才是齊的。
function strayKeys(w: Widgets, bound: ReadonlySet<string>) {
  const { Box, Button } = w

  return (
    <Box key="stray" display="none">
      {unboundHotkeys(bound).map(k => (
        <Button key={`stray:${k}`} label={k} hotkey={k} onPress={NOOP} />
      ))}
    </Box>
  )
}
