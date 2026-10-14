import type { FolderEntry } from '../../../types'
import { childPath, formatSize } from '../../files/list'
import { DANGER, FILES_WALK_LIMIT, FOLDER_COLOR, MENU_BG, MENU_WIDTH, MUTED } from '../../config'
import { splitPath } from '../../git/parse'
import { hasQuery } from '../../search'
import { backButton } from '../stepBar'
import type { TabBody, TabContext } from './context'

// Files 分頁：session 資料夾（或點進去的子資料夾）裡有什麼。資料夾在前、點了進去。
// 子資料夾裡最上面是 ← Back（b）回上一層、旁邊是路徑；session 資料夾本身兩個都不畫，也就走不出去。
// 檔案列名稱和大小，點了在 Soap Panel 裡看內容（fileView）；register 只存前 FILES_ROW_LIMIT 筆，其餘寫「… N more」。
// 最上面的搜尋框有字時，改列整個 session 資料夾裡檔名符合的檔案（searchBody）。
// 每列最右邊有 ⋯，按了在那列旁邊浮出選單（menuCard），蓋在別列上面、不推動列表。
export const filesTab: TabBody = ctx => {
  const { w, d, a } = ctx
  const { Box, Text } = w
  const f = d.files
  const hidden = f.total - f.entries.length
  const isSearching = hasQuery(f.query)

  const paths = f.entries.map(e => childPath(f.dir, e.name))

  // 資料夾點了進去；檔案（連結也是）點了看內容，大小貼在最右邊。
  const entryRow = (e: FolderEntry, i: number) => {
    const path = paths[i] ?? ''
    const trailing = moreButton(ctx, path)

    return e.kind === 'dir'
      ? w.pressRow({ key: `files:dir:${e.name}`, label: `${e.name}/`, color: FOLDER_COLOR, trailing, onPress: () => a.openDir(path) })
      : w.pressRow({
          key: `files:file:${e.name}`,
          label: e.name,
          isDim: e.kind === 'other',
          isTruncated: true,
          rest: e.kind === 'file' && <Text dimColor>{formatSize(e.size)}</Text>,
          trailing,
          onPress: () => a.openFile(path),
        })
  }

  const body = !f.isLoaded ? (
    <Text dimColor>Loading…</Text>
  ) : f.error !== '' ? (
    <Text color="error">{f.error}</Text>
  ) : f.total === 0 ? (
    <Text dimColor>This folder is empty.</Text>
  ) : (
    <Box flexDirection="column" position="relative">
      {f.entries.map(entryRow)}
      {hidden > 0 && note(ctx, `… ${hidden} more`)}
      {menuCard(ctx, paths, Number(hidden > 0))}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      {w.searchField('files:search', f.query, text => a.searchFiles(text))}
      {!isSearching && f.dir !== '' && (
        <Box gap={1} alignItems="center">
          {backButton(w, w.press, 'files', () => a.openDir(splitPath(f.dir).dir))}
          <Text bold dimColor wrap="truncate-start">{`${f.dir}/`}</Text>
        </Box>
      )}
      {isSearching ? searchBody(ctx) : body}
    </Box>
  )
}

// 搜尋結果：一個檔案一列，檔名、淡色的所在資料夾；found 是 null 時還在走資料夾。
function searchBody(ctx: TabContext) {
  const { w, a } = ctx
  const { Box, Text } = w
  const found = ctx.d.files.found
  if (found === null) return <Text dimColor>Searching…</Text>
  if (found.total === 0) return <Text dimColor>No files match.</Text>
  const hidden = found.total - found.paths.length

  return (
    <Box flexDirection="column" position="relative">
      {found.paths.map(path => {
        const { name, dir } = splitPath(path)

        return w.pressRow({
          key: `files:found:${path}`,
          label: name,
          isTruncated: true,
          rest: dir !== '' && <Text dimColor wrap="truncate-start">{dir}</Text>,
          trailing: moreButton(ctx, path),
          onPress: () => a.openFile(path),
        })
      })}
      {hidden > 0 && note(ctx, `… ${hidden} more`)}
      {found.isCapped && note(ctx, `Only the first ${FILES_WALK_LIMIT} files were searched.`)}
      {menuCard(ctx, found.paths, Number(hidden > 0) + Number(found.isCapped))}
    </Box>
  )
}

const moreKey = (path: string) => `files:more:${path}`

// 一列最右邊的 ⋯：選單開著時亮底。
function moreButton({ w, d, a }: TabContext, path: string) {
  return w.iconButton(moreKey(path), 'more', 'More', d.files.menu === path, () => a.toggleFileMenu(path))
}

// 打開的選單：有框、有底色的卡片，貼著列表右邊，浮在 ⋯ 那列下面（最後幾列放不下就浮在上面）。
// 畫在列表最後面，才蓋得住後面的列。paths 是列表一列一列的路徑，用來算是第幾列；notes 是列表底下還有幾行說明。
// 往上浮時用 bottom 貼著那列的上緣：桌面版框線不佔一整行，卡片多高算不準。
// Show in Explorer 按了選單收起來，焦點圈回到 ⋯；Delete 按一次變紅字待確認，再按才刪；做不成的原因寫在卡片裡。
function menuCard({ w, d, a }: TabContext, paths: readonly string[], notes: number) {
  const { Box, Text } = w
  const f = d.files
  const at = paths.indexOf(f.menu)
  if (f.menu === '' || at < 0) return null
  // 終端機裡兩個選項加上下框線，有錯誤再多一行：只用來決定往上還是往下。
  const height = 4 + (f.menuError === '' ? 0 : 1)
  const isAbove = at + 1 + height > paths.length && at >= height
  const place = isAbove ? { bottom: paths.length + notes - at } : { top: at + 1 }

  return (
    <Box
      key="files:menu"
      position="absolute"
      {...place}
      right={0}
      width={MENU_WIDTH}
      flexDirection="column"
      borderStyle="round"
      borderColor={MUTED}
      backgroundColor={MENU_BG}
    >
      {w.pressRow({
        key: `files:reveal:${f.menu}`,
        label: d.isWindows ? 'Show in Explorer' : 'Show in Finder',
        indent: 1,
        ringKey: moreKey(f.menu),
        onPress: () => a.revealFile(f.menu),
      })}
      {w.pressRow({
        key: `files:delete:${f.menu}`,
        label: f.isDeleteArmed ? 'Press again to delete' : 'Delete',
        color: f.isDeleteArmed ? DANGER.theme : undefined,
        indent: 1,
        onPress: () => a.deleteFile(f.menu),
      })}
      {f.menuError !== '' && (
        <Box paddingLeft={1}>
          <Text color="error">{f.menuError}</Text>
        </Box>
      )}
    </Box>
  )
}

// 列表底下淡色的一行說明（還有幾筆沒畫、只找了前幾個檔案）。
function note({ w }: TabContext, text: string) {
  const { Box, Text } = w

  return (
    <Box paddingLeft={2}>
      <Text dimColor>{text}</Text>
    </Box>
  )
}
