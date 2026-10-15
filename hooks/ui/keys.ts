// 畫出來的樹裡有哪些按鈕：按的按鈕重畫後不見了（整塊換掉、那列消失），焦點要移到還在的按鈕上
// （見 register.tsx 的 checkPressed）；哪些快捷鍵沒人綁（見 panel.tsx 的 strayKeys）。

import type { RenderChildren } from 'claude-code'

import { neighbour } from '../neighbour'

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

/** Every key a Button can take as its hotkey: one lowercase letter or digit. */
export const HOTKEYS = [...'abcdefghijklmnopqrstuvwxyz0123456789']

/** The hotkeys not in `bound` (panel.tsx's strayKeys holds them). */
export function unboundHotkeys(bound: ReadonlySet<string>): string[] {
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

/**
 * The button of the same kind as `key` (same key up to its last `:`, `delete:l:dev` → `delete:l:`) next to it in
 * `before`, the keys drawn before it went, that is still in `keys`: the one after it, else the one before.
 */
export function neighbourKey(before: string[], key: string, keys: Set<string>): string | undefined {
  const kind = key.slice(0, key.lastIndexOf(':') + 1)
  if (kind === '') return undefined
  const row = before.filter(k => k === key || (k.startsWith(kind) && !k.slice(kind.length).includes(':') && keys.has(k)))
  const isKey = (k: string) => k === key

  return neighbour(row, isKey, 1) ?? neighbour(row, isKey, -1)
}
