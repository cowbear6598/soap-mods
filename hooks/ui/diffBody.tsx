// 差異本身：一行一列自己畫，加的行綠字、減的行紅字，跟配對那行比起來改到的字詞才反白。由 widgets 的 w.diff 依畫面呼叫。

import type { RenderChildren } from 'claude-code'

import { CODE_MAX_CHARS, DIFF_LINE_MAX_CHARS, DIFF_PAGE_ROWS, DIFF_STYLE } from '../config'
import type { DiffRow, LineRow } from '../git/wordDiff'
import { markWords, parseDiffRows } from '../git/wordDiff'
import { clampPage, truncate } from '../text'
import type { Ui } from './actions'

const ROW_STYLE = {
  add: { mark: '+', ...DIFF_STYLE.add },
  remove: { mark: '-', ...DIFF_STYLE.remove },
  same: { mark: ' ', text: undefined, word: undefined },
} as const

// 面板每次重畫都會走到這裡：同一份差異只切一次行、分一次頁，字詞 diff（逐對跑 Myers，不便宜）只算畫的那頁，也只算一次。
// starts：每頁第一行是第幾行（最後再放總行數）。
let parsed: { source: string; rows: LineRow[]; starts: number[]; width: number } = { source: '', rows: [], starts: [0, 0], width: 1 }
let marked: { source: string; from: number; rows: DiffRow[] } = { source: '', from: -1, rows: [] }
function parse(source: string) {
  if (parsed.source === source) return parsed
  const rows = parseDiffRows(source).map(r => ({ ...r, text: truncate(r.text, DIFF_LINE_MAX_CHARS) }))
  // 行號的寬度照整份算：換頁時數字不會左右跳。
  const width = String(rows.reduce((n, r) => Math.max(n, r.kind === 'hunk' ? 0 : r.line), 0)).length
  const starts = [0]
  let at = 0
  let chars = 0
  rows.forEach((r, i) => {
    // 行號和 +／- 那欄也算進字數。
    const size = r.text.length + width + 3
    if (i > at && (i - at >= DIFF_PAGE_ROWS || chars + size > CODE_MAX_CHARS)) {
      starts.push(i)
      at = i
      chars = 0
    }
    chars += size
  })
  starts.push(rows.length)
  parsed = { source, rows, starts, width }

  return parsed
}
function pageRows(source: string, rows: LineRow[], from: number, to: number) {
  if (marked.source !== source || marked.from !== from) marked = { source, from, rows: markWords(rows, from, to) }

  return marked.rows
}

/** The page the diff shows and the pager under it: `pager` draws the bar from what this page holds. */
export type DiffPaging = {
  page: number
  pager: (p: { page: number; from: number; count: number; hasNext: boolean; total: number }) => RenderChildren
}

/**
 * `source`: unified-diff hunks. Off the terminal the text is drawn monospaced
 * (`mono`), so numbers and indents line up; the terminal is monospaced already
 * and refuses the prop. `divider`: the panel's divider, drawn above every hunk
 * but the first on the page. A page past the last (the diff got shorter) shows the last.
 */
export function diffBody(ui: Pick<Ui, 'Box' | 'Text'>, source: string, isTerminal: boolean, divider: RenderChildren, paging: DiffPaging) {
  const { Box, Text } = ui
  const { rows, starts, width } = parse(source)
  const page = clampPage(paging.page, starts.length - 1, 1)
  const from = starts[page] ?? 0
  const to = starts[page + 1] ?? rows.length
  const shown = pageRows(source, rows, from, to)
  const mono = isTerminal ? {} : { mono: true }
  const bar = paging.pager({ page, from, count: shown.length, hasNext: to < rows.length, total: rows.length })
  // 段落開頭：這頁第二段起上面先空一行、畫分隔線，一看就知道跳到檔案的別處了。
  const hunk = (i: number, body: RenderChildren) => (
    <Box key={`diff:${from + i}`} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
      {i > 0 && divider}
      {body}
    </Box>
  )

  return (
    <Box key="diff" flexDirection="column">
      {shown.map((r, i) => {
        if (r.kind === 'hunk') return hunk(i, <Text {...mono} color="suggestion" wrap="truncate-end">{r.text}</Text>)
        const style = ROW_STYLE[r.kind]
        const hasChange = r.segs.some(s => s.isChanged)

        return (
          <Box key={`diff:${from + i}`} flexDirection="row">
            <Text {...mono} dimColor>{`${String(r.line).padStart(width)} ${style.mark} `}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text {...mono} color={style.text}>
                {!hasChange
                  ? r.segs.map(s => s.text).join('') || ' '
                  : r.segs.map((s, j) => (
                      <Text key={`s${j}`} {...(s.isChanged ? { color: 'text', backgroundColor: style.word } : {})}>
                        {s.text}
                      </Text>
                    ))}
              </Text>
            </Box>
          </Box>
        )
      })}
      {bar != null && (
        <Box key="diff:pager" marginTop={1}>
          {bar}
        </Box>
      )}
    </Box>
  )
}
