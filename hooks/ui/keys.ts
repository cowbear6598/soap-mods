// 畫出來的樹裡有哪些按鈕：按的按鈕重畫後不見了（整塊換掉、那列消失），焦點要移到還在的按鈕上。
// 見 register.tsx 的 checkPressed。

import type { RenderChildren } from 'claude-code'

type Node = { type?: unknown; props?: { key?: unknown }; children?: RenderChildren }

/** Every Button key drawn in `tree`. */
export function buttonKeys(tree: RenderChildren): Set<string> {
  const keys = new Set<string>()
  const walk = (node: RenderChildren) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node !== 'object' || node === null) return
    const { type, props, children } = node as Node
    if (type === 'Button' && typeof props?.key === 'string') keys.add(props.key)
    walk(children)
  }
  walk(tree)

  return keys
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
