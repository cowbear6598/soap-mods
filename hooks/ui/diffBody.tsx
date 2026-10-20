// 差異本身：一行一列自己畫，加的行綠字、減的行紅字，跟配對那行比起來改到的字詞才反白。
// 一頁最多 DIFF_PAGE_ROWS 行，底下用換頁列換頁（一次畫幾千個 Text 會把桌面版卡住）。由 widgets 的 w.diff 依畫面呼叫。

import type { RenderChildren } from 'claude-code'

import { DIFF_PAGE_ROWS, DIFF_STYLE } from '../config'
import type { DiffRow } from '../git/wordDiff'
import { parseDiffRows } from '../git/wordDiff'
import type { Ui } from './actions'

const ROW_STYLE = {
  add: { mark: '+', ...DIFF_STYLE.add },
  remove: { mark: '-', ...DIFF_STYLE.remove },
  same: { mark: ' ', text: undefined, word: undefined },
} as const

// 面板每次重畫都會走到這裡：同一份差異只解析一次（逐對跑字詞 diff 不便宜）。
let parsed: { source: string; rows: DiffRow[]; width: number } = { source: '', rows: [], width: 1 }
function parse(source: string) {
  if (parsed.source === source) return parsed
  const rows = parseDiffRows(source)
  // 行號的寬度照整份算：換頁時數字不會左右跳。
  const width = String(Math.max(0, ...rows.map(r => (r.kind === 'hunk' ? 0 : r.line)))).length
  parsed = { source, rows, width }

  return parsed
}

/** The page the diff shows and the pager under it: `pager` draws the bar from what this page holds. */
export type DiffPaging = {
  page: number
  pager: (p: { page: number; size: number; count: number; hasNext: boolean; total: number }) => RenderChildren
}

/**
 * `source`: unified-diff hunks. Off the terminal the text is drawn monospaced
 * (`mono`), so numbers and indents line up; the terminal is monospaced already
 * and refuses the prop. `divider`: the panel's divider, drawn above every hunk
 * but the first on the page. A page past the last (the diff got shorter) shows the last.
 */
export function diffBody(ui: Pick<Ui, 'Box' | 'Text'>, source: string, isTerminal: boolean, divider: RenderChildren, paging: DiffPaging) {
  const { Box, Text } = ui
  const { rows, width } = parse(source)
  const page = Math.min(paging.page, Math.max(0, Math.ceil(rows.length / DIFF_PAGE_ROWS) - 1))
  const from = page * DIFF_PAGE_ROWS
  const shown = rows.slice(from, from + DIFF_PAGE_ROWS)
  const mono = isTerminal ? {} : { mono: true }
  const bar = paging.pager({ page, size: DIFF_PAGE_ROWS, count: shown.length, hasNext: from + DIFF_PAGE_ROWS < rows.length, total: rows.length })
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
