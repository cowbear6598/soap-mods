import type { ToolsSubTab } from '../../../types'
import { dbTab } from './db'
import type { TabBody } from './context'
import { httpTab } from './http'
import { servicesTab } from './services'

// Tools 分頁：開發小工具，一個工具一個子分頁。之後要加，在 config.ts 的 SUB_TABS.tools 加一筆，再在這裡補上它的內容。
const TOOLS_SUB_TAB_BODIES: Record<ToolsSubTab, TabBody> = {
  services: servicesTab,
  db: dbTab,
  http: httpTab,
}

export const toolsTab: TabBody = ctx => TOOLS_SUB_TAB_BODIES[ctx.d.subTabs.tools](ctx)
