// Wiki 子分頁的純邏輯：哪些路徑算頁面、checked.txt 和草稿檔的格式、帶給 Claude 的文字、Distill 的提示和回覆。

import type { SessionMessage } from 'claude-code'

import type { WikiModel } from '../../types'
import { WIKI_CHECKED_FILE, WIKI_DIR, WIKI_DRAFTS_DIR, WIKI_MODELS } from '../config'

/** A page's text as it is handed around: its path under `.soap/wiki` and its Markdown. */
export type PageText = { path: string; text: string }

/**
 * Whether `path` (relative to `.soap/wiki`, with `/`) names a page: a `.md` file with no empty, `.` or `..` part, no
 * part starting with `.` (the drafts folder, hidden files), and nothing that reaches outside (`/` first, `\`, `:`).
 */
export function isPagePath(path: string): boolean {
  if (!/\.md$/i.test(path) || /[\\:\p{Cc}]/u.test(path)) return false

  return path.split('/').every(part => part !== '' && !part.startsWith('.'))
}

export const wikiPath = (path: string) => `${WIKI_DIR}/${path}`
export const CHECKED_PATH = wikiPath(WIKI_CHECKED_FILE)
export const DRAFTS_PATH = wikiPath(WIKI_DRAFTS_DIR)

/** `checked.txt` → the page paths it lists, once each: one per line, blank lines and `#` comments skipped. */
export function parseChecked(text: string): string[] {
  const paths = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))

  return [...new Set(paths)]
}

/** The `checked.txt` that lists `paths`. */
export function formatChecked(paths: readonly string[]): string {
  return [
    `# Pages under ${WIKI_DIR}/ that Claude reads at the start of every conversation, one per line.`,
    '# Soap Panel rewrites this file when a checkbox in the Wiki tab changes; editing it by hand works too.',
    ...paths,
    '',
  ].join('\n')
}

/** `paths` with `path` added (at the end) or, when it is there, taken out. */
export function toggled(paths: readonly string[], path: string): string[] {
  return paths.includes(path) ? paths.filter(p => p !== path) : [...paths, path]
}

// 草稿檔：第一行「target: 頁面路徑」，空一行後是頁面的 Markdown。
/** A draft file's text for the page at `target`. */
export function draftText(target: string, body: string): string {
  return `target: ${target}\n\n${body.trim()}\n`
}

/** A draft file's text → the page it becomes and its Markdown; null when the first line names no page. */
export function parseDraft(text: string): { target: string; body: string } | null {
  const m = /^target:[ \t]*(.*?)[ \t]*(?:\r?\n|$)/.exec(text)
  const target = m?.[1] ?? ''
  if (m === null || !isPagePath(target)) return null

  return { target, body: text.slice(m[0].length).trim() }
}

/** What Claude reads when the user sends `pages` from the Wiki tab. */
export function pagesContext(pages: readonly PageText[]): string {
  const body = pages.map(p => `## ${p.path}\n\n${p.text.trim()}`).join('\n\n')

  return (
    `The user sent these pages from this project's wiki (\`${WIKI_DIR}/\`) for you to know in this conversation. ` +
    `Treat them as standing knowledge about the project; each is a file under that folder.\n\n${body}`
  )
}

/** The model family `value` names (a stored pick, or an id such as `claude-opus-5-5[1m]`); '' when it names none. */
export function wikiModelOf(value: unknown): WikiModel | '' {
  const text = typeof value === 'string' ? value.toLowerCase() : ''

  return WIKI_MODELS.find(m => text === m.id || text.includes(`-${m.id}`) || text.startsWith(`${m.id}-`))?.id ?? ''
}

/** A family's name as the tab shows it (`Opus`); '' for none. */
export const wikiModelLabel = (model: WikiModel | '') => WIKI_MODELS.find(m => m.id === model)?.label ?? ''

// 給另外問的模型看的對話：一則一段，工具呼叫只留名稱和截短的輸入、結果。
const TOOL_INPUT_CHARS = 300
const TOOL_RESULT_CHARS = 500
// 先切掉遠超過 n 的部分再壓空白，大的工具輸入不用整段跑一遍。
const clip = (text: string, n: number) => {
  const flat = text.slice(0, n * 4).replace(/\s+/g, ' ').trim()

  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

/** The conversation as plain text for a model that cannot read it itself; past `maxChars` the newest part is kept. */
export function transcriptText(messages: readonly SessionMessage[], maxChars: number): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.text.trim() !== '') lines.push(`[${m.role}] ${m.text.trim()}`)
    for (const u of m.toolUses) {
      const out = u.text === undefined ? '' : ` -> ${u.isError === true ? 'error: ' : ''}${clip(u.text, TOOL_RESULT_CHARS)}`
      lines.push(`  (tool ${u.tool}) ${clip(JSON.stringify(u.input), TOOL_INPUT_CHARS)}${out}`)
    }
  }
  const text = lines.join('\n')

  return text.length > maxChars ? `(earlier part left out)\n${text.slice(-maxChars)}` : text
}

/**
 * Which pages Distill shows whole: going through `pages` (already in path order), each one whose size still fits in what is left of `maxBytes`;
 * the rest are only named. Sizes come from the listing, so the pages left out are never read.
 */
export function pickPages(pages: readonly { path: string; size: number }[], maxBytes: number): { shown: string[]; named: string[] } {
  let left = maxBytes
  const shown: string[] = []
  const named: string[] = []
  for (const p of pages) {
    if (p.size <= left) {
      shown.push(p.path)
      left -= p.size
    } else named.push(p.path)
  }

  return { shown, named }
}

/**
 * The question Distill asks: what is worth keeping, as drafts in a fixed format, given the pages the wiki already has
 * (`pages` whole, `named` by path alone). `conversation`: the conversation as text, for a
 * model that does not read it itself; left out, the question is asked at the end of the conversation.
 */
export function distillPrompt(pages: readonly PageText[], named: readonly string[], conversation?: string): string {
  const blocks = [...pages.map(p => `--- ${p.path}\n${p.text.trim()}`), ...named.map(path => `--- ${path} (not shown: too long)`)]
  const existing = blocks.length === 0 ? '(none yet)' : blocks.join('\n\n')

  return [
    ...(conversation === undefined ? [] : ['<conversation>', conversation, '</conversation>', '']),
    `Distill this conversation into the project wiki (\`${WIKI_DIR}/\`, Markdown pages). Keep only what a future conversation in this project needs: conventions, decisions and their reasons, domain facts, workflows, gotchas, and the user's corrections and preferences.`,
    'Leave out what the existing pages below already say, details that only mattered for this one task, and any account of what happened in the conversation.',
    'Write tersely: one fact or rule per bullet, the conclusion first, no filler. Write in the language the user writes in.',
    '',
    'Answer with drafts only. Start each one with a header line, then the page\'s Markdown:',
    '=== new <path>.md   (a page that does not exist yet; path relative to the wiki folder, lowercase-kebab-case)',
    '=== edit <path>.md  (a change to an existing page: write the whole page as it should read afterwards)',
    'Prefer adding to an existing page over a new one when the topic fits. If nothing is worth keeping, answer exactly: NOTHING',
    '',
    'Existing pages:',
    existing,
  ].join('\n')
}

const DRAFT_HEADER = /^===[ \t]*(?:new|edit)[ \t]+(.+?)[ \t]*$/i

/** Distill's reply → its drafts, in order; a header naming no page, or one with no text under it, is skipped. */
export function parseDistill(reply: string): { target: string; body: string }[] {
  const drafts: { target: string; body: string }[] = []
  let current: { target: string; lines: string[] } | undefined
  const flush = () => {
    const body = current?.lines.join('\n').trim() ?? ''
    if (current !== undefined && body !== '' && isPagePath(current.target)) drafts.push({ target: current.target, body })
  }
  for (const line of reply.split(/\r?\n/)) {
    const m = DRAFT_HEADER.exec(line)
    if (m === null) {
      current?.lines.push(line)
      continue
    }
    flush()
    // 模型有時把 wiki 資料夾、./ 或反引號也寫進路徑。
    const target = (m[1] ?? '').replace(/^`|`$/g, '').replace(/^\.\//, '').replace(new RegExp(`^${WIKI_DIR.replace(/\./g, '\\.')}/`), '')
    current = { target, lines: [] }
  }
  flush()

  return drafts
}
