// 差異本身：一行一列自己畫，加的行綠字、減的行紅字，跟配對那行比起來改到的字詞才反白。
// 行數太多就交回引擎的 Code（有語法高亮，沒有字詞反白）。由 widgets 的 w.diff 依畫面呼叫。

import { DIFF_STYLE, WORD_DIFF_MAX_ROWS } from '../config'
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
function rowsOf(source: string) {
  if (parsed.source !== source) {
    const rows = parseDiffRows(source)
    const width = String(Math.max(0, ...rows.map(r => (r.kind === 'hunk' ? 0 : r.line)))).length
    parsed = { source, rows, width }
  }

  return parsed
}

/**
 * `source`: unified-diff hunks, as `Code format="diff"` takes them. Off the
 * terminal the text is drawn monospaced (`mono`), so numbers and indents line
 * up; the terminal is monospaced already and refuses the prop.
 */
export function diffBody(ui: Pick<Ui, 'Box' | 'Code' | 'Text'>, source: string, path: string, isTerminal: boolean) {
  const { Box, Code, Text } = ui
  if (source.split('\n').length > WORD_DIFF_MAX_ROWS) return <Code source={source} format="diff" path={path} />
  const { rows, width } = rowsOf(source)
  const mono = isTerminal ? {} : { mono: true }

  return (
    <Box key="diff" flexDirection="column">
      {rows.map((r, i) => {
        if (r.kind === 'hunk') return <Text key={`diff:${i}`} {...mono} dimColor wrap="truncate-end">{r.text}</Text>
        const style = ROW_STYLE[r.kind]
        const hasChange = r.segs.some(s => s.isChanged)

        return (
          <Box key={`diff:${i}`} flexDirection="row">
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
    </Box>
  )
}
