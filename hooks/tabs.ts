// 看著的 Tab 和各 Tab 的子分頁。$.state 裡的值可能是舊版存的（熱重載後沿用）：上層 Tab 是 services、db（現在是 Tools 的子分頁），
// 子分頁少了後來加的 Tab；讀的時候都經過 normalizeTabs，畫面和動作只看得到現在的樣子。

import type { OldTabId, SubTabs, TabId } from '../types'
import { DEFAULT_SUB_TABS, SUB_TABS, TABS } from './config'

const isTab = (t: string): t is TabId => TABS.some(x => x.id === t)

/** The tab and sub tabs as this code knows them: an old top tab becomes its Tools sub tab, a missing or unknown sub tab its default. */
export function normalizeTabs(tab: TabId | OldTabId | string, subs: Partial<SubTabs> | undefined): { tab: TabId; subTabs: SubTabs } {
  const pick = <T extends keyof SubTabs>(t: T): SubTabs[T] => {
    const v = subs?.[t]

    return SUB_TABS[t].some(x => x.id === v) ? (v as SubTabs[T]) : DEFAULT_SUB_TABS[t]
  }
  const subTabs: SubTabs = { git: pick('git'), spec: pick('spec'), tools: pick('tools') }
  if (tab === 'services' || tab === 'db') return { tab: 'tools', subTabs: { ...subTabs, tools: tab } }

  return { tab: isTab(tab) ? tab : 'files', subTabs }
}
