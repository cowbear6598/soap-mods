// 差異本身：一行一列自己畫，加的行綠字、減的行紅字，跟配對那行比起來改到的字詞才反白。
// 行數太多就交回引擎的 Code（有語法高亮，沒有字詞反白），一段一個 Code，段落之間一樣有分隔線。由 widgets 的 w.diff 依畫面呼叫。

import type { RenderChildren } from 'claude-code'

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
// 行數太多的只切成段落（hunks）交給 Code：內容行開頭是空白、+、-、\，只有段落標頭是 @@，在那裡切開。
let parsed: { source: string; hunks: string[] | null; rows: DiffRow[]; width: number } = { source: '', hunks: null, rows: [], width: 1 }
function parse(source: string) {
  if (parsed.source === source) return parsed
  if (source.split('\n').length > WORD_DIFF_MAX_ROWS) parsed = { source, hunks: source.split(/\n(?=@@)/), rows: [], width: 1 }
  else {
    const rows = parseDiffRows(source)
    const width = String(Math.max(0, ...rows.map(r => (r.kind === 'hunk' ? 0 : r.line)))).length
    parsed = { source, hunks: null, rows, width }
  }

  return parsed
}

/**
 * `source`: unified-diff hunks, as `Code format="diff"` takes them. Off the
 * terminal the text is drawn monospaced (`mono`), so numbers and indents line
 * up; the terminal is monospaced already and refuses the prop. `divider`:
 * the panel's divider, drawn above every hunk but the first.
 */
export function diffBody(ui: Pick<Ui, 'Box' | 'Code' | 'Text'>, source: string, path: string, isTerminal: boolean, divider: RenderChildren) {
  const { Box, Code, Text } = ui
  // 段落開頭：第二段起上面先空一行、畫分隔線，一看就知道跳到檔案的別處了。
  const hunk = (i: number, body: RenderChildren) => (
    <Box key={`diff:${i}`} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
      {i > 0 && divider}
      {body}
    </Box>
  )
  const { hunks, rows, width } = parse(source)
  if (hunks !== null) {
    return (
      <Box key="diff" flexDirection="column">
        {hunks.map((h, i) => hunk(i, <Code source={h} format="diff" path={path} />))}
      </Box>
    )
  }
  const mono = isTerminal ? {} : { mono: true }

  return (
    <Box key="diff" flexDirection="column">
      {rows.map((r, i) => {
        if (r.kind === 'hunk') return hunk(i, <Text {...mono} color="suggestion" wrap="truncate-end">{r.text}</Text>)
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
