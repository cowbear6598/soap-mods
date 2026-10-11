import type { RenderChildren } from 'claude-code'

import type { Actions, PanelData } from '../actions'
import type { Widgets } from '../widgets'

// 每個分頁畫內容時拿到的東西：共用元件、整個面板的資料、動作。分頁是純函式，不碰 $。
export type TabContext = { w: Widgets; d: PanelData; a: Actions }

export type TabBody = (ctx: TabContext) => RenderChildren
