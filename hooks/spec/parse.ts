// Spec 分頁和 plan.yaml 檢查的純邏輯：讀 plan skill 寫的 plan.yaml、挑出格式哪裡不對、排 feature 清單。
// 引擎裡沒有 YAML 套件，這裡只讀 plan.yaml 用得到的那一小部分：最上層的「key: 值」、引號字串、
// > 和 | 區塊、- 清單、[] 和 [a, b]。其他寫法（巢狀物件、錨點）一律算格式錯誤。

import type { Plan, SpecEntry } from '../../types'
import { PLAN_FILE, SPEC_DIR } from '../config'
import { byName } from '../files/list'
import { escapeRegExp } from '../text'

type Value = string | string[]

// 必填的 key，照 skill 寫的順序；選填的只有使用者給了才寫的兩個公司欄位。
const LIST_KEYS = ['goals', 'constraints', 'related', 'verify'] as const
const REQUIRED = ['description', ...LIST_KEYS] as const
const OPTIONAL = ['branch', 'issue-number'] as const
const KNOWN = new Set<string>([...REQUIRED, ...OPTIONAL])

const KEY_LINE = /^([A-Za-z][\w-]*):(?:[ \t]+(.*))?$/
const ITEM_LINE = /^([ \t]*)-(?:[ \t]+(.*))?$/
const indentOf = (line: string) => line.length - line.trimStart().length

/** A scalar as written: quotes removed (with `''` / `\"` escapes), a plain one without its ` # comment`. */
function unquote(raw: string): string {
  const s = raw.trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s) as string
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'")

  return s.replace(/[ \t]+#.*$/, '')
}

// [] 或 [a, "b, c"]：逗號分開，引號裡的逗號不算。
function flowList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim()
  if (inner === '') return []
  const items: string[] = []
  let quote = ''
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charAt(i)
    if (quote !== '') quote = c === quote ? '' : quote
    else if (c === '"' || c === "'") quote = c
    else if (c === ',') {
      items.push(unquote(inner.slice(start, i)))
      start = i + 1
    }
  }
  items.push(unquote(inner.slice(start)))

  return items
}

// > 折成一行（空行是換行）、| 照原樣；- 結尾的不留最後的換行。lines 是區塊裡的行，縮排還在。
function blockScalar(style: string, lines: string[]): string {
  const indent = Math.min(...lines.filter(l => l.trim() !== '').map(indentOf))
  const body = lines.map(l => l.slice(Number.isFinite(indent) ? indent : 0))
  while (body.length > 0 && body[body.length - 1]?.trim() === '') body.pop()
  const text = style.startsWith('|')
    ? body.join('\n')
    : body.reduce((out, l) => (l === '' ? `${out}\n` : out === '' || out.endsWith('\n') ? out + l : `${out} ${l}`), '')

  return style.endsWith('-') ? text : `${text}\n`
}

/** The top-level keys of `text` with their values, and what could not be read, as `line N: …`. */
export function parseYaml(text: string): { values: Map<string, Value | null>; errors: string[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const values = new Map<string, Value | null>()
  const errors: string[] = []
  // 這個 key 底下縮排的行（或 - 開頭的行）都是它的值，收到下一個最上層的 key 為止。
  const ownLines = (from: number) => {
    let end = from
    for (let l = lines[end]; l !== undefined && (l.trim() === '' || indentOf(l) > 0 || l.startsWith('-')); l = lines[end]) end += 1

    return end
  }

  let i = 0
  for (let line = lines[0]; line !== undefined; line = lines[i]) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i += 1
      continue
    }
    const m = KEY_LINE.exec(line)
    if (m === null) {
      errors.push(`line ${i + 1}: expected "key: value", got "${line.trim()}"`)
      i = ownLines(i + 1)
      continue
    }
    const [, key = '', rest = ''] = m
    if (values.has(key)) errors.push(`line ${i + 1}: "${key}" appears twice`)
    const end = ownLines(i + 1)
    const own = lines.slice(i + 1, end)
    const head = rest.replace(/[ \t]+#.*$/, '').trim()

    const more = own.map(l => l.trim()).filter(l => l !== '')

    if (/^[>|][+-]?$/.test(head)) values.set(key, blockScalar(head, own))
    else if (head.startsWith('[') && head.endsWith(']')) {
      values.set(key, flowList(head))
      if (more.length > 0) errors.push(`line ${i + 2}: "${key}" is already [${head.slice(1, -1)}]; lines below it don't belong to it`)
    }
    // 太長換行的字串：接在後面，中間一個空白。
    else if (head !== '') values.set(key, unquote([rest, ...more].join(' ')))
    else values.set(key, readItems(own, i + 2, errors))
    i = end
  }

  return { values, errors }
}

// 「key:」底下的 - 清單。項目太長換行的接在後面（中間一個空白）。一行都沒有是 null（沒寫值）。
function readItems(own: string[], firstLine: number, errors: string[]): string[] | null {
  const items: string[] = []
  let itemIndent = -1
  own.forEach((line, n) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return
    const m = ITEM_LINE.exec(line)
    if (m !== null && (itemIndent === -1 || m[1]?.length === itemIndent)) {
      itemIndent = m[1]?.length ?? 0
      items.push(unquote(m[2] ?? ''))
    } else if (items.length > 0 && indentOf(line) > itemIndent) {
      items.push(`${items.pop()} ${unquote(line)}`)
    } else {
      errors.push(`line ${firstLine + n}: expected a "- item", got "${line.trim()}"`)
    }
  })

  return items.length === 0 && itemIndent === -1 ? null : items
}

const asText = (v: Value | null | undefined) => (typeof v === 'string' ? v.trim() : '')
const asList = (v: Value | null | undefined) => (Array.isArray(v) ? v : [])

/**
 * `text` (a plan.yaml) as the Spec sub tab draws it, and everything wrong with it: what could not be read,
 * a missing or mistyped key, a key the plan does not have. No problems means the plan is valid.
 */
export function readPlan(text: string): { plan: Plan; problems: string[] } {
  const { values, errors } = parseYaml(text)
  const problems = [...errors]
  for (const key of REQUIRED) {
    if (!values.has(key)) problems.push(`missing "${key}"`)
  }
  const description = values.get('description')
  if (values.has('description') && (typeof description !== 'string' || description.trim() === '')) {
    problems.push('"description" must be a non-empty string')
  }
  for (const key of LIST_KEYS) {
    const v = values.get(key)
    if (!values.has(key)) continue
    if (!Array.isArray(v)) problems.push(`"${key}" must be a list (use [] when empty)`)
    else if (v.some(item => item.trim() === '')) problems.push(`"${key}" has an empty item`)
  }
  for (const key of OPTIONAL) {
    if (values.has(key) && typeof values.get(key) !== 'string') problems.push(`"${key}" must be a string`)
  }
  for (const key of values.keys()) {
    if (KNOWN.has(key)) continue
    problems.push(key === 'goal' ? 'use "goals", not "goal"' : `unknown key "${key}"`)
  }

  return {
    plan: {
      branch: asText(values.get('branch')),
      issueNumber: asText(values.get('issue-number')),
      description: asText(description),
      goals: asList(values.get('goals')),
      constraints: asList(values.get('constraints')),
      related: asList(values.get('related')),
      verify: asList(values.get('verify')),
    },
    problems,
  }
}

/** The plan of feature `name`, relative to the session folder: `.soap/tasks/<name>/plan.yaml`. */
export const planPath = (name: string) => `${SPEC_DIR}/${name}/${PLAN_FILE}`

const PLAN_PATH = new RegExp(`(^|/)${escapeRegExp(SPEC_DIR)}/[^/]+/${escapeRegExp(PLAN_FILE)}$`)

/** Whether `path` (any separator) is a plan the plan skill writes: `…/.soap/tasks/<feature>/plan.yaml`. */
export const isPlanPath = (path: string) => PLAN_PATH.test(path.replace(/\\/g, '/'))

/** What Claude reads after writing a plan.yaml with `problems`: what to fix, and the keys a plan has. */
export function planFixNote(path: string, problems: readonly string[]): string {
  return [
    `${path} is not a valid soap-mods plan.yaml. Fix it:`,
    ...problems.map(p => `- ${p}`),
    `Required keys: description (non-empty string), ${LIST_KEYS.join(', ')} (lists; [] when empty). Optional: ${OPTIONAL.join(', ')} (strings).`,
  ].join('\n')
}

/** Newest plan first; folders without a plan.yaml last, by name. */
export function sortSpecs(specs: readonly SpecEntry[]): SpecEntry[] {
  return [...specs].sort((a, b) => Number(b.hasPlan) - Number(a.hasPlan) || b.mtimeMs - a.mtimeMs || byName(a.name, b.name))
}
