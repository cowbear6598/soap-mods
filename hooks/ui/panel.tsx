import type { RenderChildren } from 'claude-code'

import type { GitSubTab, RepoSummary, SubTabs, TabId } from '../../types'
import { DANGER, SUB_TABS, TABS, type Tint, WORKTREE_MENU, hasSubTabs } from '../config'
import { isConflict } from '../git/parse'
import type { Actions, PanelData, Press, Ui } from './actions'
import { diffView } from './diffView'
import { fileView } from './fileView'
import { unboundHotkeys } from './keys'
import { mergeView } from './mergeView'
import { branchTab } from './tabs/branch'
import { conflictTab } from './tabs/conflict'
import { ciTab } from './tabs/ci'
import type { TabBody, TabContext } from './tabs/context'
import { diffTab } from './tabs/diff'
import { filesTab } from './tabs/files'
import { httpPageBar } from './tabs/http'
import { logTab } from './tabs/log'
import { mrTab } from './tabs/mr'
import { docsTab } from './tabs/docs'
import { toolsTab } from './tabs/tools'
import { usageBar } from './usage'
import { type Widgets, floatFieldWidth, makeWidgets } from './widgets'

const GIT_SUB_TAB_BODIES: Record<GitSubTab, TabBody> = {
  diff: diffTab,
  branch: branchTab,
  log: logTab,
  ci: ciTab,
  mr: mrTab,
  conflict: conflictTab,
}

const gitTab: TabBody = ctx => {
  const { Text } = ctx.w
  if (!ctx.d.view.isLoaded) return <Text dimColor>Loading…</Text>
  if (!ctx.d.view.isRepo) return <Text dimColor>This folder is not a git repo.</Text>

  return GIT_SUB_TAB_BODIES[ctx.d.subTabs.git](ctx)
}

const TAB_BODIES: Record<TabId, TabBody> = {
  git: gitTab,
  files: filesTab,
  tools: toolsTab,
  docs: docsTab,
}

// repo 名稱加上記號：「a*」是有未提交的變更，「!」是有衝突。
const marked = (name: string, r: RepoSummary | undefined) => `${name}${r?.isDirty === true ? '*' : ''}${r?.hasConflict === true ? ' !' : ''}`

// Git Tab 的那排 repo。session 資料夾本身是 repo 時只有它一個；
// 不是的話是下一層的 repo，點了換 Git 分頁看的 repo；面板不會自己換。
// rest 是底下的子分頁和內容：worktree 選單打開時浮在它們上面，要畫在它們後面才蓋得住（見 floatSelect）。
function repoBar(ctx: TabContext, rest: RenderChildren) {
  const { w, d, a } = ctx
  const { Box, Button } = w
  const v = d.view
  if (v.repos.length === 0) return rest
  const labels = v.repos.map(r => marked(r.name, r))
  // 終端機的按鈕畫成「[ 名稱 ]」，一顆後面空一格。
  const menu = worktreeMenu(ctx, labels.reduce((n, l) => n + l.length + 5, 0))

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box gap={1} flexWrap="wrap" justifyContent="center" width="100%">
        {v.repos.map((r, i) => (
          <Button
            key={`repo:${r.name}`}
            label={labels[i]}
            variant={r.name === v.repo ? 'primary' : 'secondary'}
            onPress={w.press(() => a.selectRepo(r.name))}
          />
        ))}
        {menu.field}
      </Box>
      <Box flexDirection="column" flexGrow={1} position="relative">
        {divider(w)}
        {rest}
        {menu.card}
      </Box>
    </Box>
  )
}

// 選中的 repo 有 worktree 時，repo bar 下面的「worktree:」選單：main 是 repo 本身，其他的是它的 worktree，
// 記號跟 repo bar 一樣。選了 Git 分頁就看那個 worktree；面板不會自己換到 Claude 進去的 worktree。
// 放在那排置中的 repo 最後面；打開時選項從那排底下的分隔線開始往下浮。before 是前面那些 repo 按鈕佔幾欄，
// 用來算選單在置中那排的左緣；那排放不下一行（換行了）就讓卡片置中。
function worktreeMenu({ w, d, a }: TabContext, before: number) {
  const v = d.view
  if (v.worktrees.length === 0) return { field: null, card: null }
  const options = [
    { value: '', label: marked('main', v.repos.find(r => r.name === v.repo)) },
    ...v.worktrees.map(r => ({ value: r.root, label: marked(r.name, r) })),
  ]
  const rowWidth = before + floatFieldWidth('worktree', options.find(o => o.value === v.worktree)?.label ?? v.worktree)

  return w.floatSelect(WORKTREE_MENU, {
    label: 'worktree',
    value: v.worktree,
    options,
    onSelect: root => a.selectWorktree(root),
    onOpen: a.readWorktreeMenu,
    top: 0,
    left: rowWidth > d.bodyColumns ? undefined : Math.floor((d.bodyColumns - rowWidth) / 2) + before,
  })
}

// 面板上的分隔線左右各空一格，跟分頁內容一樣不貼邊。
const divider = ({ Box, divider }: Widgets) => <Box paddingX={1}>{divider}</Box>

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
  const w = makeWidgets(ui, isTerminal, d.bodyColumns, press, a.focusInput, { open: d.openMenu, toggle: a.toggleMenu })
  const { Box, Text } = w
  const ctx: TabContext = { w, d, a }
  const isGit = d.tab === 'git'
  const cover = coverView(ui, w, d, a, press)

  // 分頁列底下的：子分頁列和分頁內容。
  const tabBody = (
    <Box flexDirection="column" gap={1} flexGrow={1}>
      <Box flexDirection="column">
        {isGit ? subTabBar(ctx, 'git', d.view.files.some(isConflict) ? { conflict: DANGER } : {}) : hasSubTabs(d.tab) && subTabBar(ctx, d.tab)}
        {d.tab === 'tools' && d.subTabs.tools === 'http' && [httpPageBar(ctx), divider(w)]}
      </Box>
      <Box flexDirection="column" gap={1} paddingX={1}>
        {isGit && d.view.error !== '' && <Text color="error">{d.view.error}</Text>}
        {TAB_BODIES[d.tab](ctx)}
      </Box>
    </Box>
  )

  const content =
    cover !== null ? (
      <Box flexDirection="column" flexGrow={1}>
        {cover}
      </Box>
    ) : (
      <Box flexDirection="column" flexGrow={1}>
        {w.iconBar('tab', TABS, d.tab, id => a.selectTab(id))}
        {divider(w)}
        {isGit ? repoBar(ctx, tabBody) : tabBody}
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
