// Soap Panel 上共用的小元件：圖示按鈕、整行可點的列、檔案列、搜尋框、圖示分頁列、分隔線。
// 依畫面（終端機／桌面版）決定怎麼畫，分頁只管要畫什麼。

import type { RenderChildren } from 'claude-code'

import type { FileKind } from '../../types'
import { splitPath } from '../git/parse'
import type { IconName, Tint } from '../config'
import {
  ACTIVE_BG,
  DIVIDER_PX,
  DIVIDER_TEXT,
  ICON_BUTTON_LABEL,
  ICON_PX,
  KIND_STYLE,
  ROW_BUTTON_LABEL,
  ROW_OVERLAY_WIDTH,
} from '../config'
import type { Press, Ui } from './actions'
import { DIVIDER_SVG, iconSvg } from './svg'

type Row = {
  key: string
  label: string
  onPress: () => unknown
  isDim?: boolean
  isBold?: boolean
  isTruncated?: boolean
  color?: string
  indent?: number
  lead?: RenderChildren
  rest?: RenderChildren
  trailing?: RenderChildren
}

// press：這個面板上的按鈕都經過它，動作做完後丟了焦點會補回來。
export function makeWidgets(ui: Ui, isTerminal: boolean, press: Press) {
  const { Box, Button, Text } = ui
  // 終端機畫不出 Svg（元素表裡有這個 key，但畫成空的），那邊退回文字按鈕。
  const Svg = !isTerminal && 'Svg' in ui ? ui.Svg : undefined

  // 只有圖示的按鈕，三層疊起來（後畫的 absolute 疊在上面）：
  // 1. 墊底的 Button 撐出外框大小，選中的底色畫在外框上；它被蓋住，點不到；
  // 2. Svg 那層鋪滿外框、置中；
  // 3. 最上層是一模一樣的 Button，剛好蓋滿外框，接點擊，hover 的亮底也就是外框大小。
  // tint：圖示固定用這個顏色（停止鈕的紅色）；終端機沒有 Svg，就在按鈕前面放一個同色的方塊。
  // tint.background：外框固定用這個底色（等著確認刪除的紅底），蓋過選中的底色。
  const iconButton = (key: string, icon: IconName, label: string, isActive: boolean, action: () => unknown, tint?: Tint) => {
    const onPress = press(action)

    return Svg === undefined ? (
      <Box key={`${key}:box`}>
        {tint !== undefined && <Text color={tint.theme}>■</Text>}
        <Button key={key} label={label} variant={isActive ? 'primary' : 'secondary'} onPress={onPress} />
      </Box>
    ) : (
      <Box key={`${key}:box`} position="relative" backgroundColor={tint?.background ?? (isActive ? ACTIVE_BG : undefined)}>
        <Button key={`${key}:spacer`} label={ICON_BUTTON_LABEL} plain onPress={onPress} />
        <Box position="absolute" top={0} left={0} right={0} bottom={0} justifyContent="center" alignItems="center">
          <Svg source={iconSvg(icon, isActive, tint?.hex)} alt={label} width={ICON_PX} height={ICON_PX} />
        </Box>
        <Box position="absolute" top={0} left={0}>
          <Button key={key} label={ICON_BUTTON_LABEL} plain onPress={onPress} />
        </Box>
      </Box>
    )
  }

  // 整行都能點的列表項目；indent 是名稱前面空幾格（預設 2 給列表項目，標題列給 0）。
  // 桌面版：內容照常排，上面疊一顆透明按鈕。按鈕本身是 fit-content，靠一長串不換行空白撐開；
  // 包它的那層比整行寬很多、超出的部分被裁掉，按鈕就不會被壓到整行寬而在最右邊畫出「…」，
  // 看得到的 hover 亮底剛好是整行。
  // 終端機：疊上去的空白會蓋掉底下的字，所以只有名稱是按鈕。
  // isTruncated：名稱撐滿剩下的寬度、太長時在桌面版截成「…」，rest 留在同一行、貼著最右邊（commit 的 subject 和時間）。
  // 要 minWidth 0 才縮得比內容窄，不然長的名稱會把 rest 擠出畫面。
  // trailing：放在整行最右邊、自己能按的東西（branch 列的 log 圖示），不在透明按鈕底下，才按得到。
  const pressRow = (row: Row) => {
    if (isTerminal) {
      return (
        <Box key={`${row.key}:row`} gap={1} paddingLeft={row.indent ?? 2} hover={{ backgroundColor: ACTIVE_BG }}>
          {row.lead}
          <Button key={row.key} label={row.label} plain dimColor={row.isDim} onPress={press(row.onPress)} />
          {row.rest}
          {row.trailing}
        </Box>
      )
    }
    const label = (
      <Text bold={row.isBold} color={row.color} dimColor={row.isDim} wrap={row.isTruncated ? 'truncate-end' : undefined}>
        {row.label}
      </Text>
    )
    const hasTrailing = row.trailing !== undefined
    const pressable = (
      <Box key={`${row.key}:row`} position="relative" flexGrow={hasTrailing ? 1 : undefined} flexShrink={hasTrailing ? 1 : undefined}>
        <Box gap={1} paddingLeft={row.indent ?? 2} flexGrow={row.isTruncated ? 1 : undefined} minWidth={row.isTruncated ? 0 : undefined}>
          {row.lead}
          {row.isTruncated ? (
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              {label}
            </Box>
          ) : (
            label
          )}
          {row.rest}
        </Box>
        <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
          <Box width={ROW_OVERLAY_WIDTH} flexShrink={0}>
            <Button key={row.key} label={ROW_BUTTON_LABEL} plain onPress={press(row.onPress)} />
          </Box>
        </Box>
      </Box>
    )

    return hasTrailing ? (
      <Box key={`${row.key}:line`} gap={1} alignItems="center">
        {pressable}
        <Box flexShrink={0}>{row.trailing}</Box>
      </Box>
    ) : (
      pressable
    )
  }

  // 一個檔案一列：彩色狀態字母、檔名、淡色的說明和資料夾。diff、log、conflict 分頁共用。
  const pathRow = (key: string, path: string, letter: string, kind: FileKind, onPress: () => unknown, note = '') => {
    const { name, dir } = splitPath(path)
    const detail = [note, dir].filter(s => s !== '').join(' · ')

    return pressRow({
      key,
      label: name,
      onPress,
      lead: (
        <Text bold color={KIND_STYLE[kind].theme}>
          {letter}
        </Text>
      ),
      rest:
        detail === '' ? null : (
          <Text dimColor wrap="truncate-start">
            {detail}
          </Text>
        ),
    })
  }

  // branch、log 分頁最上面的搜尋框。手機版沒有 Input，就不畫。邊打邊過濾；桌面版拔不掉框旁邊的 submit 按鈕，
  // 就讓它（和 Enter）清空搜尋（onInput('')）。框不能設寬度、撐不滿，所以整組水平置中。
  // trailing：同一行最右邊的按鈕（branch 的 Fetch／Pull），搜尋框靠左、中間一條直線隔開 Clear；沒有搜尋框時只剩它，靠右。
  const searchField = (
    key: string,
    value: string,
    onInput: (text: string) => unknown,
    trailing?: RenderChildren,
  ) => {
    const input =
      'Input' in ui ? (
        <ui.Input
          key={key}
          placeholder="Search"
          value={value}
          submitLabel="Clear"
          onInput={text => void onInput(text)}
          onSubmit={() => void onInput('')}
        />
      ) : null
    if (input === null && trailing === undefined) return null
    const justify = trailing === undefined ? 'center' : input === null ? 'flex-end' : 'space-between'

    return (
      <Box key={`${key}:row`} width="100%" gap={1} alignItems="center" justifyContent={justify}>
        {input}
        {trailing !== undefined && (
          <Box key={`${key}:trailing`} gap={1} alignItems="center" flexShrink={0}>
            {input !== null && <Text dimColor>│</Text>}
            {trailing}
          </Box>
        )}
      </Box>
    )
  }

  // 項目之間插入直線分隔。
  const withDividers = (items: RenderChildren[], prefix: string) =>
    items.flatMap((item, i) => (i === 0 ? [item] : [<Text key={`${prefix}:div:${i}`} dimColor>│</Text>, item]))

  // 一排置中的圖示分頁，中間用直線隔開。tints：某幾個分頁的圖示固定用這個顏色（有衝突時 conflict 變紅）。
  const iconBar = <T extends string>(
    prefix: string,
    items: { id: T; label: string; icon: IconName }[],
    active: T,
    select: (id: T) => unknown,
    tints: Partial<Record<T, Tint>> = {},
  ) => (
    <Box gap={1} alignItems="center" justifyContent="center" width="100%">
      {withDividers(
        items.map(t => iconButton(`${prefix}:${t.id}`, t.icon, t.label, t.id === active, () => select(t.id), tints[t.id])),
        prefix,
      )}
    </Box>
  )

  // 拉滿整行的橫條圖（stretchedSvg 畫的），落在這一列的正中間。
  const stretched = (source: string, alt: string, heightPx: number) =>
    Svg === undefined ? null : (
      <Box width="100%" height={1} overflow="hidden" alignItems="center">
        <Svg source={source} alt={alt} width={DIVIDER_PX} height={heightPx} />
      </Box>
    )

  // 分隔線：夾在兩條線中間的東西就會上下對稱。
  const divider =
    Svg === undefined ? (
      <Box width="100%" height={1} overflow="hidden">
        <Text dimColor>{DIVIDER_TEXT}</Text>
      </Box>
    ) : (
      stretched(DIVIDER_SVG, 'Divider', 1)
    )

  return { Box, Button, Text, hasSvg: Svg !== undefined, press, iconButton, pressRow, pathRow, searchField, iconBar, stretched, divider }
}

export type Widgets = ReturnType<typeof makeWidgets>
