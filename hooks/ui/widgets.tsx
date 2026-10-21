// Soap Panel 上共用的小元件：圖示按鈕、整行可點的列、檔案列、搜尋框、圖示分頁列、差異、分隔線。
// 依畫面（終端機／桌面版）決定怎麼畫，分頁只管要畫什麼。

import type { RenderChildren } from 'claude-code'

import type { FileKind } from '../../types'
import { splitPath } from '../git/parse'
import { truncate } from '../text'
import type { IconName, Tint } from '../config'
import {
  ACTIVE_BG,
  ARMED_TINT,
  DIVIDER_PX,
  DIVIDER_TEXT,
  FIELD_MIN_WIDTH,
  ICON_BUTTON_LABEL,
  ICON_PX,
  KIND_STYLE,
  PATH_NAME_WIDTH,
  ROW_BUTTON_LABEL,
  ROW_OVERLAY_WIDTH,
} from '../config'
import type { Actions, PanelData, Press, Ui } from './actions'
import { diffBody } from './diffBody'
import { DIVIDER_SVG, iconSvg } from './svg'

type Row = {
  key: string
  label: string
  onPress: () => unknown
  // 按了這列會不見時，焦點圈移到這顆（Press 的 ringKey）。
  ringKey?: string
  isDim?: boolean
  isBold?: boolean
  isTruncated?: boolean
  labelWidth?: number
  color?: string
  indent?: number
  lead?: RenderChildren
  rest?: RenderChildren
  // 名稱後面淡色的一段字（pathRow 的資料夾），取代 rest：桌面版吃掉剩下的寬度、太長截頭；
  // 終端機畫在名稱同一顆按鈕裡（名稱補滿 labelWidth、太長截尾），點到 trailing 前都算。
  detail?: string
  // 終端機上整行都要能點（log 的 commit 列）：lead 畫進名稱那顆按鈕裡（一項後面空一格）、rest 自己也是一顆一樣作用的按鈕。
  // 這時 lead、rest 只能是字串和 Text（按鈕裡不能放 Box），用 cell 排。
  isWholePressable?: boolean
  trailing?: RenderChildren
}

// press：這個面板上的按鈕都經過它，動作做完後丟了焦點會補回來。focusInput：把焦點圈移到某個輸入框。
export function makeWidgets(ui: Ui, isTerminal: boolean, press: Press, focusInput: (key: string) => unknown) {
  const { Box, Button, Code, Markdown, Text } = ui
  // 終端機畫不出 Svg（元素表裡有這個 key，但畫成空的），那邊退回文字按鈕。
  const Svg = !isTerminal && 'Svg' in ui ? ui.Svg : undefined

  // 只有圖示的按鈕，三層疊起來（後畫的 absolute 疊在上面）：
  // 1. 墊底的 Button 撐出外框大小，選中的底色畫在外框上；它被蓋住，點不到；
  // 2. Svg 那層鋪滿外框、置中；
  // 3. 最上層是一模一樣的 Button，剛好蓋滿外框，接點擊，hover 的亮底也就是外框大小。
  // tint：圖示固定用這個顏色（停止鈕的紅色）；終端機沒有 Svg，就在按鈕前面放一個同色的方塊、字也用這個顏色（Confirm、停止是紅字，Copied 是綠字）。
  // tint.background：外框固定用這個底色（等著確認刪除的紅底），蓋過選中的底色。
  const iconButton = (key: string, icon: IconName, label: string, isActive: boolean, action: () => unknown, tint?: Tint) => {
    const onPress = press(action)

    return Svg === undefined ? (
      <Box key={`${key}:box`}>
        {tint !== undefined && <Text color={tint.theme}>■</Text>}
        <Button key={key} label={label} variant={isActive ? 'primary' : 'secondary'} onPress={onPress}>
          {tint !== undefined && <Text color={tint.theme}>{label}</Text>}
        </Button>
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

  // 要按兩次的按鈕：圖示按了換成紅底打勾，再按才做。垃圾桶、rollback 都是。
  const armedButton = (key: string, icon: IconName, label: string, isArmed: boolean, action: () => unknown, armedLabel = 'Confirm') =>
    iconButton(key, isArmed ? 'check' : icon, isArmed ? armedLabel : label, false, action, isArmed ? ARMED_TINT : undefined)

  const deleteButton = (key: string, isArmed: boolean, action: () => unknown, armedLabel = 'Confirm') =>
    armedButton(key, 'trash', 'Delete', isArmed, action, armedLabel)

  const rollbackButton = (key: string, isArmed: boolean, action: () => unknown) => armedButton(key, 'rollback', 'Rollback', isArmed, action)

  // 整行都能點的列表項目；indent 是名稱前面空幾格（預設 2；不縮排的列：標題、Files、log、DB、wiki 頁面給 0）。
  // 桌面版：內容照常排，上面疊一顆透明按鈕。按鈕本身是 fit-content，靠一長串不換行空白撐開；
  // 包它的那層比整行寬很多、超出的部分被裁掉，按鈕就不會被壓到整行寬而在最右邊畫出「…」，
  // 看得到的 hover 亮底剛好是整行。
  // 終端機：疊上去的空白會蓋掉底下的字，所以是名稱自己當按鈕，名稱後面接一長串空白撐滿名稱那格（跟桌面版一樣用外層裁掉），
  // 點名稱右邊的空白也算。名稱那格：有 labelWidth 就那麼寬；isTruncated 或沒有 rest 時吃掉剩下的寬度；
  // 其餘（rest 要緊跟在名稱後面，branch 的切換提示）只有名稱。trailing 貼最右邊。
  // isTruncated：名稱撐滿剩下的寬度、太長時在桌面版截成「…」，rest 留在同一行、貼著最右邊（commit 的 subject 和時間）。
  // 要 minWidth 0 才縮得比內容窄，不然長的名稱會把 rest 擠出畫面。
  // labelWidth：名稱固定這麼寬、太長時截尾，rest 從同一個位置開始，一列一列對齊（檔案列的檔名和資料夾）。
  // trailing：放在整行最右邊、自己能按的東西（branch 列的 log 圖示），不在透明按鈕底下，才按得到。
  // 疊在一格上面、比它寬很多再裁掉的那層，按鈕放在裡面（兩種版面共用）。
  const rowOverlay = (button: RenderChildren) => (
    <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
      <Box width={ROW_OVERLAY_WIDTH} flexShrink={0}>
        {button}
      </Box>
    </Box>
  )

  // 名稱裡的空白換成不換行空白：不然後面那串空白連不上，按鈕在名稱的空白處折行，反白只亮到那裡（Show in Explorer）。
  const NBSP = ' '
  const nbsp = (text: string) => text.replace(/ /g, NBSP)

  // 名稱剛好 width 格：太長截成「…」，太短補空白。
  const fit = (text: string, width: number) => truncate(text, width).padEnd(width)

  // 固定 width 格寬的一欄字（log 的 sha、作者、時間）。桌面版字寬不一，是固定寬的 Box、太長截尾；
  // 終端機是 Text 補空白（能放進按鈕裡），太長截成「…」。空白不上色：焦點反白整顆按鈕時，上了色的空白會變成一塊色塊。
  const cell = (key: string, text: string, width: number, style: { color?: string; isDim?: boolean; isEnd?: boolean } = {}) => {
    const shown = (
      <Text key={key} color={style.color} dimColor={style.isDim} wrap={isTerminal ? undefined : 'truncate-end'}>
        {isTerminal ? nbsp(truncate(text, width)) : text}
      </Text>
    )
    if (!isTerminal) {
      return (
        <Box key={key} width={width} flexShrink={0} overflow="hidden" justifyContent={style.isEnd === true ? 'flex-end' : undefined}>
          {shown}
        </Box>
      )
    }
    const pad = NBSP.repeat(Math.max(0, width - text.length))

    return style.isEnd === true ? [pad, shown] : [shown, pad]
  }

  const pressRow = (row: Row) => {
    if (isTerminal) {
      // 有 detail 時名稱和它一起當按鈕、吃掉剩下的寬度，labelWidth 改成把名稱補滿那麼寬。
      const hasDetail = row.detail !== undefined
      const labelWidth = hasDetail ? undefined : row.labelWidth
      const grows = labelWidth === undefined && (row.isTruncated === true || !row.rest)
      const fills = labelWidth !== undefined || grows
      const shown = hasDetail && row.labelWidth !== undefined ? fit(row.label, row.labelWidth) : row.label
      const onPress = press(row.onPress, row.ringKey)
      // 按鈕本身吃不到顏色、粗體，名稱包一層 Text（資料夾列的 FOLDER_COLOR、標題列的粗體）。
      const name = (text: string) => (
        <Text bold={row.isBold} color={row.color}>
          {text}
        </Text>
      )

      const rowButton = (key: string, children: RenderChildren) => (
        <Button key={key} label={row.label} plain dimColor={row.isDim} onPress={onPress}>
          {children}
        </Button>
      )
      const isWhole = row.isWholePressable === true
      const outerLead = isWhole ? undefined : row.lead
      const innerLead = isWhole && row.lead !== undefined ? [row.lead].flat().flatMap(item => [item, NBSP]) : undefined
      const rest = isWhole && row.rest ? rowButton(`${row.key}:rest`, row.rest) : row.rest

      return (
        <Box key={`${row.key}:row`} gap={1} paddingLeft={row.indent ?? 2} hover={{ backgroundColor: ACTIVE_BG }}>
          {outerLead}
          {fills ? (
            // 底下照常排的名稱只用來撐出寬度（被上面蓋住）；按鈕放在 absolute 那層，那串空白才不會把 rest、trailing 擠出畫面。
            <Box position="relative" width={labelWidth} flexGrow={grows ? 1 : undefined} flexShrink={1} minWidth={0} overflow="hidden">
              <Text wrap="truncate-end">{row.label}</Text>
              {rowOverlay(
                rowButton(row.key, [
                  innerLead,
                  name(nbsp(shown)),
                  row.detail && <Text dimColor>{nbsp(` ${row.detail}`)}</Text>,
                  ROW_BUTTON_LABEL,
                ]),
              )}
            </Box>
          ) : (
            rowButton(row.key, [innerLead, name(row.label)])
          )}
          {grows && rest ? <Box flexShrink={0}>{rest}</Box> : rest}
          {row.trailing !== undefined && <Box flexShrink={0}>{row.trailing}</Box>}
        </Box>
      )
    }
    const shrinks = row.isTruncated === true || row.labelWidth !== undefined
    const label = (
      <Text bold={row.isBold} color={row.color} dimColor={row.isDim} wrap={shrinks ? 'truncate-end' : undefined}>
        {row.label}
      </Text>
    )
    const hasTrailing = row.trailing !== undefined
    const pressable = (
      <Box
        key={`${row.key}:row`}
        position="relative"
        flexGrow={hasTrailing ? 1 : undefined}
        flexShrink={hasTrailing ? 1 : undefined}
        minWidth={hasTrailing && shrinks ? 0 : undefined}
      >
        <Box gap={1} paddingLeft={row.indent ?? 2} flexGrow={shrinks ? 1 : undefined} minWidth={shrinks ? 0 : undefined}>
          {row.lead}
          {shrinks ? (
            <Box width={row.labelWidth} flexGrow={row.labelWidth === undefined ? 1 : undefined} flexShrink={1} minWidth={0} overflow="hidden">
              {label}
            </Box>
          ) : (
            label
          )}
          {row.detail ? (
            <Box flexGrow={1} flexShrink={3} minWidth={0} overflow="hidden">
              <Text dimColor wrap="truncate-start">
                {row.detail}
              </Text>
            </Box>
          ) : (
            row.rest
          )}
        </Box>
        {rowOverlay(<Button key={row.key} label={ROW_BUTTON_LABEL} plain onPress={press(row.onPress, row.ringKey)} />)}
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

  // 一個檔案一列：彩色狀態字母（status，Files 搜尋沒有）、固定寬的檔名、淡色的說明和資料夾。
  // 資料夾吃掉剩下的寬度，太長時截頭，縮得比檔名快，右邊的按鈕才不會被擠出去。diff、log、conflict、Files 搜尋共用。
  // 終端機上檔名和資料夾是同一顆按鈕（detail），點到右邊的按鈕前都算，沒有資料夾時右邊的按鈕也一樣貼最右邊。
  const pathRow = (
    key: string,
    path: string,
    onPress: () => unknown,
    { status, note = '', trailing, indent }: { status?: { letter: string; kind: FileKind }; note?: string; trailing?: RenderChildren; indent?: number } = {},
  ) => {
    const { name, dir } = splitPath(path)
    const detail = [note, dir].filter(s => s !== '').join(' · ')

    return pressRow({
      key,
      label: name,
      onPress,
      labelWidth: PATH_NAME_WIDTH,
      indent,
      detail,
      lead: status && (
        <Text bold color={KIND_STYLE[status.kind].theme}>
          {status.letter}
        </Text>
      ),
      trailing,
    })
  }

  // 一個輸入框（搜尋、DB 分頁的連線字串和查詢）；手機版沒有 Input，是 null。onInput 沒給就只在 Enter 時拿到字。
  // 終端機的框只有淡色的 placeholder 一行字，看不出能打字：墊一塊至少 FIELD_MIN_WIDTH 寬的 ACTIVE_BG 底色。
  // 框本身只有字那麼寬，點底色的其他地方點不到它：底下先墊一顆一樣大的透明按鈕（rowOverlay），按了把焦點移到框上。
  // 按鈕要先畫、框後畫：終端機後畫的蓋在上面，反過來按鈕的空白會蓋掉框裡的字。
  // isFixed：底色固定 FIELD_MIN_WIDTH 寬，打長了也不撐寬（搜尋框，免得把旁邊的 Clear 擠走）。
  const field = (
    key: string,
    props: {
      placeholder: string
      value: string
      submitLabel: string
      isFixed?: boolean
      onInput?: (text: string) => unknown
      onSubmit: (text: string) => unknown
    },
  ) => {
    const { onInput } = props
    if (!('Input' in ui)) return null
    const fixed = props.isFixed === true ? ({ width: FIELD_MIN_WIDTH, flexShrink: 0, overflow: 'hidden' } as const) : {}
    const input = (
      <ui.Input
        key={key}
        placeholder={props.placeholder}
        value={props.value}
        submitLabel={props.submitLabel}
        onInput={onInput && (text => void onInput(text))}
        onSubmit={text => void props.onSubmit(text)}
      />
    )

    return isTerminal ? (
      <Box
        key={`${key}:bg`}
        position="relative"
        minWidth={FIELD_MIN_WIDTH}
        {...fixed}
        paddingX={1}
        backgroundColor={ACTIVE_BG}
      >
        {rowOverlay(<Button key={`${key}:focus`} label={ROW_BUTTON_LABEL} plain onPress={() => void focusInput(key)} />)}
        {input}
      </Box>
    ) : (
      input
    )
  }

  // 下拉選單（Wiki 的模型）；手機版沒有 Select，是 null。終端機的 Select 只吃鍵盤（滑鼠點選項沒反應、展開還會變寬、點了收不回去），
  // 自己畫一個：ACTIVE_BG 底的「Opus ▾」點了開合（isOpen、onToggle），底下隔一條線列出選項，選的在箭頭那欄打勾；
  // 點了就選、收起來，焦點圈回到「Opus ▾」。每一列都補到同一個寬度，開合時不會變寬。
  const select = (
    key: string,
    props: {
      label: string
      value: string
      options: { value: string; label: string }[]
      onSelect: (value: string) => unknown
      isOpen: boolean
      onToggle: (isOpen: boolean) => unknown
    },
  ) => {
    if (!('Select' in ui)) return null
    if (!isTerminal) {
      return <ui.Select key={key} label={props.label} value={props.value} options={props.options} onSelect={value => void props.onSelect(value)} />
    }
    const width = Math.max(...props.options.map(o => o.label.length))
    // 每一列「 名稱 ✓ 」：名稱前後各一格、箭頭或勾一格、再一格。
    const rowWidth = width + 4
    const current = props.options.find(o => o.value === props.value)?.label ?? props.value

    return (
      <Box key={`${key}:row`} gap={1} alignItems="flex-start">
        <Text>{`${props.label}:`}</Text>
        <Box key={`${key}:bg`} flexDirection="column" backgroundColor={ACTIVE_BG}>
          <Button key={key} label={` ${fit(current, width)} ${props.isOpen ? '▴' : '▾'} `} plain onPress={press(() => props.onToggle(!props.isOpen))} />
          {props.isOpen && [
            <Text key={`${key}:divider`} dimColor>
              {'─'.repeat(rowWidth)}
            </Text>,
            ...props.options.map(o => (
              <Button
                key={`${key}:${o.value}`}
                label={` ${fit(o.label, width)} ${o.value === props.value ? '✓' : ' '} `}
                plain
                onPress={press(() => props.onSelect(o.value), key)}
              />
            )),
          ]}
        </Box>
      </Box>
    )
  }

  // branch、log、Files 分頁最上面的搜尋框。手機版沒有 Input，就不畫。邊打邊過濾；桌面版拔不掉框旁邊的 submit 按鈕，
  // 就讓它（和 Enter）清空搜尋（onInput('')）。框不能設寬度、撐不滿，所以整組水平置中。
  // trailing：同一行最右邊的按鈕（branch 的 Fetch／Pull），搜尋框靠左、中間一條直線隔開 Clear；沒有搜尋框時只剩它，靠右。
  // 終端機的框旁邊沒有 submit 按鈕（只在有焦點時畫一個「↵ Clear」提示），自己補一顆 [ Clear ]，跟桌面版一樣。
  const searchField = (
    key: string,
    value: string,
    onInput: (text: string) => unknown,
    trailing?: RenderChildren,
  ) => {
    const clear = () => onInput('')
    // 終端機已經有自己的 [ Clear ]，引擎在框旁邊畫的提示給空字串，不要再畫一次「↵ Clear」。
    const input = field(key, { placeholder: 'Search', value, submitLabel: isTerminal ? '' : 'Clear', isFixed: true, onInput, onSubmit: clear })
    if (input === null && trailing === undefined) return null
    const justify = trailing === undefined ? 'center' : input === null ? 'flex-end' : 'space-between'

    const box =
      isTerminal && input !== null ? (
        <Box key={`${key}:field`} gap={1} alignItems="center">
          {input}
          <Button key={`${key}:clear`} label="Clear" variant="secondary" onPress={press(clear)} />
        </Box>
      ) : (
        input
      )

    return (
      <Box key={`${key}:row`} width="100%" gap={1} alignItems="center" justifyContent={justify}>
        {box}
        {trailing !== undefined && (
          <Box key={`${key}:trailing`} gap={1} alignItems="center" flexShrink={0}>
            {input !== null && <Text dimColor>│</Text>}
            {trailing}
          </Box>
        )}
      </Box>
    )
  }

  const withDividers = (items: RenderChildren[], prefix: string) =>
    items.flatMap((item, i) => (i === 0 ? [item] : [<Text key={`${prefix}:div:${i}`} dimColor>│</Text>, item]))

  // 一排置中的圖示分頁，中間用直線隔開。tints：某幾個分頁的圖示固定用這個顏色（有衝突時 conflict 變紅）。
  // 終端機不畫直線：[ label ] 的括號本身就隔開了，直線夾在中間左右空白不一樣寬，看起來很散；改成等寬的空白。
  const iconBar = <T extends string>(
    prefix: string,
    items: { id: T; label: string; icon: IconName }[],
    active: T,
    onSelect: (id: T) => unknown,
    tints: Partial<Record<T, Tint>> = {},
  ) => {
    const buttons = items.map(t => iconButton(`${prefix}:${t.id}`, t.icon, t.label, t.id === active, () => onSelect(t.id), tints[t.id]))

    return (
      <Box gap={isTerminal ? 2 : 1} alignItems="center" justifyContent="center" width="100%">
        {isTerminal ? buttons : withDividers(buttons, prefix)}
      </Box>
    )
  }

  // 拉滿整行的橫條圖（stretchedSvg 畫的），落在這一列的正中間。
  const stretched = (source: string, alt: string, heightPx: number) =>
    Svg === undefined ? null : (
      <Box width="100%" height={1} overflow="hidden" alignItems="center">
        <Svg source={source} alt={alt} width={DIVIDER_PX} height={heightPx} />
      </Box>
    )

  // 換頁列（diff、log 分頁，長的差異）：← Previous、Next →，後面是這頁的範圍（「31–60」，知道總數再加「of 80」）。只有一頁就不畫。
  // 一次只畫一頁、一頁 size 列，不越畫越多：每列有 Svg 圖示鈕或很寬的透明按鈕，畫到一兩百列桌面版就卡住。
  // 按的那顆換頁後不見了（到第一頁、最後一頁），焦點圈移到另一顆。count 是這頁實際有幾列。
  const pager = (
    prefix: string,
    { page, size, count, hasNext, total }: { page: number; size: number; count: number; hasNext: boolean; total?: number },
    onPage: (page: number) => unknown,
  ) => {
    if (page === 0 && !hasNext) return null
    const prevKey = `${prefix}:prev`
    const nextKey = `${prefix}:next`
    const from = page * size
    const range = `${from + 1}–${from + count}${total === undefined ? '' : ` of ${total}`}`

    return (
      <Box key={`${prefix}:pager`} gap={1} alignItems="center" flexWrap="wrap">
        {page > 0 && <Button key={prevKey} label="← Previous" onPress={press(() => onPage(page - 1), nextKey)} />}
        {hasNext && <Button key={nextKey} label="Next →" onPress={press(() => onPage(page + 1), prevKey)} />}
        <Text dimColor>{range}</Text>
      </Box>
    )
  }

  // 差異（unified-diff hunk），改到的字詞反白；終端機以外用等寬字。長的分頁畫，換頁列的 key 是「place:prev」這種。
  // place 是畫在哪（diffpage、wikidiff），id 是哪一份：pages 記的是別份就從第一頁看。
  const diff = (source: string, place: string, id: string, pages: PanelData['diffPages'], show: Actions['showDiffPage']) => {
    const at = pages[place]
    const page = at?.id === id ? at.page : 0

    return diffBody(ui, source, isTerminal, divider, { page, pager: p => pager(place, p, n => show(place, id, n)) })
  }

  // 分隔線：夾在兩條線中間的東西就會上下對稱。
  const divider =
    Svg === undefined ? (
      <Box width="100%" height={1} overflow="hidden">
        <Text dimColor>{DIVIDER_TEXT}</Text>
      </Box>
    ) : (
      stretched(DIVIDER_SVG, 'Divider', 1)
    )

  return { Box, Button, Code, Markdown, Text, cell, diff, hasSvg: Svg !== undefined, press, iconButton, deleteButton, rollbackButton, pressRow, pathRow, pager, searchField, field, select, iconBar, stretched, divider }
}

export type Widgets = ReturnType<typeof makeWidgets>
