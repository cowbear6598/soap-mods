// 解衝突的三欄畫面，像 JetBrains 的合併視窗：左邊 Ours、右邊 Theirs、中間是結果。
// 畫在 Soap Panel 裡蓋掉分頁，最上面 ← Back（b）回分頁。
// 每段衝突左邊按「Accept ≫」、右邊按「≪ Accept」把那一邊放進中間，中間也可以兩邊都要或重選；
// 全部選好才能 Apply（寫回檔案並 git add）。
// 只畫當下用得到的按鈕。按了之後按鈕被換掉（Ours + Theirs 變成 Reset）焦點會掉，所以把焦點圈移到換上來的那顆。

import type { RenderChildren } from 'claude-code'

import type { MergeChoice, MergeOp, MergeView } from '../../types'
import { KIND_STYLE, MERGE_COLUMN_WIDTH, MERGE_CONTEXT } from '../config'
import { choose, chooseAll, chunkResult, takesSide, toggleApplied } from '../merge/algo'
import type { Actions, Press, Ui } from './actions'
import { backButton } from './stepBar'

// isBusy：正在套用或用某一邊解掉。op 是進行中的操作（rebase 時提醒 ours／theirs 是反的）。
export function mergeView(ui: Ui, m: MergeView, op: MergeOp, isBusy: boolean, a: Actions, press: Press) {
  const { Box, Button, Code, Text } = ui

  // 套用中不能離開：做到一半放掉，結果會不見。
  const back = isBusy ? null : backButton(ui, press, 'merge', () => a.closeCover())
  const title = (
    <Box gap={1} flexWrap="wrap" alignItems="center">
      {back}
      <Text bold color={KIND_STYLE.conflict.theme}>
        {KIND_STYLE.conflict.label}
      </Text>
      <Text bold>{m.path}</Text>
      <Button key="merge:open" label="Open" onPress={press(() => a.openMergeFile())} />
    </Box>
  )
  const error = m.error !== '' ? <Text color="error">{m.error}</Text> : null
  // rebase 時 ours／theirs 跟直覺相反，提醒一下。
  const rebaseHint =
    op === 'rebase' ? (
      <Text dimColor>Rebasing: ours is the branch you are rebasing onto, theirs is your commit being replayed.</Text>
    ) : null

  // 沒有衝突標記可以一段一段選：整個檔案用某一邊，或照目前的樣子標成已解決。
  if (!m.hasMarkers) {
    return (
      <Box flexDirection="column" gap={1}>
        {title}
        {error}
        {rebaseHint}
        <Text dimColor>
          This file has no conflict markers to pick from (one side deleted it, it is binary, or the markers were already
          removed). Choose the whole file:
        </Text>
        {isBusy ? (
          <Text dimColor>Working…</Text>
        ) : (
          <Box gap={1} flexWrap="wrap">
            <Button key="merge:take-ours" label="Use ours" onPress={press(() => a.takeSide('ours'))} />
            <Button key="merge:take-theirs" label="Use theirs" onPress={press(() => a.takeSide('theirs'))} />
            <Button key="merge:take-as-is" label="Mark resolved as is" onPress={press(() => a.takeSide('as-is'))} />
            <Button key="merge:claude" label="Ask Claude" onPress={press(() => a.askClaude())} />
          </Box>
        )}
      </Box>
    )
  }

  const conflicts = m.chunks.filter(c => c.kind === 'conflict')
  const done = conflicts.filter(c => c.choice !== 'none').length
  const isAllResolved = done === conflicts.length

  // 程式碼一律包一層撐滿整格的 Box：桌面版的 Code 只跟內容一樣寬（有個最小寬度），
  // 短的那幾格會比長的窄；要它跟著撐到整格寬，每一格的程式碼區塊才會一樣寬。
  const code = (lines: string[], startLine?: number) =>
    lines.length === 0 ? (
      <Text dimColor>(nothing)</Text>
    ) : (
      <Box width="100%" flexDirection="column" alignItems="stretch">
        <Code source={lines.join('\n')} path={m.path} startLine={startLine} />
      </Box>
    )

  // 一格：外框的顏色（淡掉的沒框色）、框上一排標籤和按鈕（跟程式碼隔一行）、程式碼。null 是空格子。
  type Cell = { color?: string; isDim?: boolean; bar?: RenderChildren; content: RenderChildren } | null
  // 三欄一列，固定各占 MERGE_COLUMN_WIDTH（剩下的當欄距）。每一格都由這裡包上一樣的外框：
  // 桌面版沒包框的 Code 會比有框的窄一點，全部同一種結構，每一列的欄寬才會一致。
  // 左欄的那排按鈕靠右（靠近中間）、右欄的靠左；同一列的三格一樣高，所以每一段左右對齊。
  const columns = (key: string, cells: RenderChildren[]) => (
    <Box key={key} flexDirection="row" justifyContent="space-between" width="100%">
      {cells.map((cell, i) => (
        <Box key={`${key}:${i}`} flexDirection="column" width={MERGE_COLUMN_WIDTH} flexShrink={0} overflow="hidden">
          {cell}
        </Box>
      ))}
    </Box>
  )
  const BAR_ALIGN = ['flex-end', 'flex-start', 'flex-start'] as const
  const row = (key: string, cells: [Cell, Cell, Cell]) =>
    columns(
      key,
      cells.map((cell, i) =>
        cell === null ? null : (
          <Box
            flexDirection="column"
            alignItems="stretch"
            gap={1}
            paddingX={1}
            borderStyle="round"
            borderColor={cell.color}
            borderDimColor={cell.isDim}
          >
            {cell.bar !== undefined && (
              <Box gap={1} flexWrap="wrap" alignItems="center" justifyContent={BAR_ALIGN[i]}>
                {cell.bar}
              </Box>
            )}
            {cell.content}
          </Box>
        ),
      ),
    )

  // 三欄各自的下一個行號：左邊照 ours 的檔案算、右邊照 theirs、中間照結果（還沒選的衝突不佔行）。
  const at = { ours: 1, result: 1, theirs: 1 }
  const advance = (ours: number, result: number, theirs: number) => {
    at.ours += ours
    at.result += result
    at.theirs += theirs
  }
  const rows: RenderChildren[] = []
  const sameRows = (key: string, lines: string[]) => {
    const cell = (startLine: number): Cell => ({ isDim: true, content: code(lines, startLine) })
    rows.push(row(key, [cell(at.ours), cell(at.result), cell(at.theirs)]))
    advance(lines.length, lines.length, lines.length)
  }

  m.chunks.forEach((c, k) => {
    if (c.kind === 'same') {
      // 檔頭只留下一段改動前的幾行、檔尾只留上一段改動後的幾行，中間的段落兩頭都留，其餘收起來。
      const head = k === 0 ? 0 : MERGE_CONTEXT
      const tail = k === m.chunks.length - 1 ? 0 : MERGE_CONTEXT
      if (c.lines.length <= head + tail + 1) {
        sameRows(`same:${k}`, c.lines)

        return
      }
      if (head > 0) sameRows(`same:${k}:head`, c.lines.slice(0, head))
      const hidden = c.lines.length - head - tail
      rows.push(
        <Box key={`same:${k}:gap`} justifyContent="center" width="100%">
          <Text dimColor>{`⋯ ${hidden} unchanged line${hidden === 1 ? '' : 's'}`}</Text>
        </Box>,
      )
      advance(hidden, hidden, hidden)
      if (tail > 0) sameRows(`same:${k}:tail`, c.lines.slice(c.lines.length - tail))

      return
    }

    const out = chunkResult(c) ?? []

    // 只有一邊改的（或兩邊改得一樣）：git 會自己合，不用選。改的那邊和中間是藍框，
    // 中間可以 Undo（結果留原本的樣子）再 Apply 回來；沒改的那邊淡掉，顯示原本的樣子。
    if (c.kind === 'auto') {
      const label = c.from === 'both' ? 'Same change on both sides' : `Auto-merged from ${c.from}`
      const side = (lines: string[], startLine: number, isChanged: boolean): Cell =>
        isChanged
          ? { color: 'suggestion', bar: <Text color="suggestion">changed</Text>, content: code(lines, startLine) }
          : lines.length === 0
            ? null
            : { isDim: true, content: code(lines, startLine) }
      const middle: Cell = {
        color: c.isApplied ? 'suggestion' : undefined,
        isDim: !c.isApplied,
        bar: [
          <Text key="state" color={c.isApplied ? 'suggestion' : undefined} dimColor={!c.isApplied}>
            {c.isApplied ? label : `${label} · undone`}
          </Text>,
          <Button
            key={`merge:toggle:${k}`}
            label={c.isApplied ? 'Undo' : 'Apply'}
            onPress={press(() => a.editChunks(cs => toggleApplied(cs, k)))}
          />,
        ],
        content: code(out, at.result),
      }
      rows.push(
        row(`auto:${k}`, [side(c.ours, at.ours, c.from !== 'theirs'), middle, side(c.theirs, at.theirs, c.from !== 'ours')]),
      )
      advance(c.ours.length, out.length, c.theirs.length)

      return
    }

    const isOpen = c.choice === 'none'
    // ringKey：中間的按鈕按了就換掉（兩邊都要 → Reset，Reset → 兩邊都要），焦點圈跟過去。兩邊的 Accept 一直都在。
    const pick = (choice: MergeChoice, ringKey?: string) => press(() => a.editChunks(cs => choose(cs, k, choice)), ringKey)
    // 還沒選：三格都是紅框。選好了：中間和被選進去的那邊綠框，沒被選的那邊淡掉。
    const side = (which: 'ours' | 'theirs', lines: string[], startLine: number): Cell => {
      const isTaken = takesSide(c.choice, which)

      return {
        color: isOpen ? 'error' : isTaken ? 'success' : undefined,
        isDim: !isOpen && !isTaken,
        bar: (
          <Button
            key={`merge:${which}:${k}`}
            label={which === 'ours' ? 'Accept ≫' : '≪ Accept'}
            dimColor={c.choice === which}
            onPress={pick(which)}
          />
        ),
        content: code(lines, startLine),
      }
    }
    const middle: Cell = {
      color: isOpen ? 'error' : 'success',
      // 只放用得到的按鈕：還沒選時是「兩邊都要」，選好之後只剩 Reset。
      bar: isOpen
        ? [
            <Text key="state" bold color="error">
              Conflict
            </Text>,
            <Button key={`merge:both:${k}`} label="Ours + Theirs" onPress={pick('ours-theirs', `merge:reset:${k}`)} />,
            <Button key={`merge:both-rev:${k}`} label="Theirs + Ours" onPress={pick('theirs-ours', `merge:reset:${k}`)} />,
          ]
        : [
            <Text key="state" bold color="success">
              Resolved
            </Text>,
            <Button key={`merge:reset:${k}`} label="Reset" onPress={pick('none', `merge:both:${k}`)} />,
          ],
      // 還沒選時中間顯示兩邊改之前的樣子；原本那裡沒有東西，就是兩邊在同一處各自加了內容。
      content: !isOpen ? (
        code(out, at.result)
      ) : c.base === null ? (
        <Text dimColor>Pick a side, or both.</Text>
      ) : c.base.length === 0 ? (
        <Text dimColor>Both sides added lines here. Pick a side, or both.</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>Base (before either side changed it):</Text>
          {code(c.base)}
        </Box>
      ),
    }

    rows.push(row(`conflict:${k}`, [side('ours', c.ours, at.ours), middle, side('theirs', c.theirs, at.theirs)]))
    advance(c.ours.length, out.length, c.theirs.length)
  })

  const columnTitle = (label: string, detail: string, align: 'flex-start' | 'center' | 'flex-end') => (
    <Box justifyContent={align} gap={1}>
      <Text bold>{label}</Text>
      {detail !== '' && <Text dimColor>{detail}</Text>}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      {title}
      {error}
      {rebaseHint}
      {/* 第二行：進度和上一段／下一段；第三行：整個檔案的動作。 */}
      <Box gap={1} flexWrap="wrap" alignItems="center">
        <Text color={isAllResolved ? 'success' : 'warning'}>{`${done} of ${conflicts.length} conflicts resolved`}</Text>
        {conflicts.length > 0 && [
          <Button key="merge:prev" label="↑ Previous" hotkey="n" onPress={press(() => a.jumpConflict(-1))} />,
          <Button key="merge:next" label="↓ Next" hotkey="m" onPress={press(() => a.jumpConflict(1))} />,
        ]}
      </Box>
      <Box gap={1} flexWrap="wrap" alignItems="center">
        <Button key="merge:all-ours" label="All ours" onPress={press(() => a.editChunks(cs => chooseAll(cs, 'ours')))} />
        <Button key="merge:all-theirs" label="All theirs" onPress={press(() => a.editChunks(cs => chooseAll(cs, 'theirs')))} />
        <Button key="merge:claude" label="Ask Claude" onPress={press(() => a.askClaude())} />
        {/* 每段衝突都選好才能 Apply；套用中換成文字，不能再按一次。 */}
        {isBusy ? (
          <Text dimColor>Applying…</Text>
        ) : isAllResolved ? (
          <Button key="merge:apply" label="Apply & mark resolved" variant="primary" onPress={press(() => a.applyMerge())} />
        ) : null}
      </Box>
      <Box flexDirection="column" gap={1}>
        {columns('titles', [
          columnTitle('Ours', m.oursLabel, 'flex-start'),
          columnTitle('Result', '', 'center'),
          columnTitle('Theirs', m.theirsLabel, 'flex-end'),
        ])}
        {rows}
      </Box>
    </Box>
  )
}
