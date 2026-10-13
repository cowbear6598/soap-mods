// 畫出來的樹裡有哪些按鈕：按的按鈕重畫後不見了（整塊換掉、那列消失），焦點要移到還在的按鈕上。
// 見 register.tsx 的 checkPressed。

import type { RenderChildren } from 'claude-code'

type Node = { type?: unknown; props?: { key?: unknown; hotkey?: unknown }; children?: RenderChildren }

// 走過樹裡每顆 Button，收集 pick 給的字串（沒有就略過）。
function collectButtons(tree: RenderChildren, pick: (props: Node['props']) => unknown): Set<string> {
  const found = new Set<string>()
  const walk = (node: RenderChildren) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node !== 'object' || node === null) return
    const { type, props, children } = node as Node
    const value = type === 'Button' ? pick(props) : undefined
    if (typeof value === 'string') found.add(value)
    walk(children)
  }
  walk(tree)

  return found
}

/** Every Button key drawn in `tree`. */
export function buttonKeys(tree: RenderChildren): Set<string> {
  return collectButtons(tree, props => props?.key)
}

// Button 的 hotkey 只能是一個小寫字母或數字。
const HOTKEYS = [...'abcdefghijklmnopqrstuvwxyz0123456789']

/**
 * The hotkeys no Button in `tree` binds. Soap Panel binds these to hidden buttons that do nothing:
 * an unbound key pressed in the pane would otherwise go to the prompt box and take the focus with it.
 */
export function unboundHotkeys(tree: RenderChildren): string[] {
  const bound = collectButtons(tree, props => props?.hotkey)

  return HOTKEYS.filter(k => !bound.has(k))
}

/** The icon of the tab in view: the sub tab's under Git, else the tab's (keys as panel.tsx's iconBar draws them). */
export function tabIconKey(tab: string, subTab: string): string {
  return tab === 'git' ? `sub:${subTab}` : `tab:${tab}`
}

/**
 * Where the focus ring lands once the pressed button is gone: `prefer` (the
 * button a press swaps in), the drawn `*:back` (diff, merge, commit, folder; one at a time), else the tab
 * icon. The first of these that is drawn; undefined when none is.
 */
export function ringAnchor(keys: Set<string>, tab: string, subTab: string, prefer?: string): string | undefined {
  const back = [...keys].find(k => k.endsWith(':back'))

  return [prefer, back, tabIconKey(tab, subTab)].find(k => k !== undefined && keys.has(k))
}
