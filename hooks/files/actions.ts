// Files 分頁的動作。引擎不讓 $ 跨檔，所以這裡不碰 $，只呼叫 register.tsx 給的 FilesIo（每個都是抓著 $ 的閉包）。

import type { FileView, FilesView } from '../../types'
import { FILES_ROW_LIMIT, FILES_WALK_LIMIT, FILES_WALK_SKIP, FILE_VIEW_MAX_BYTES } from '../config'
import { EMPTY_FILE_VIEW, NO_FILE_MENU } from '../defaults'
import { errorText } from '../errors'
import { splitPath } from '../git/parse'
import type { Io } from '../io'
import { latestOnly } from '../latest'
import { neighbour } from '../neighbour'
import { patch } from '../patch'
import { hasQuery } from '../search'
import { powershellArgv } from '../services/scan'
import { type ArmSlot, isConfirmed, isWindows, removePath, runOk } from '../shell'
import { type WalkRule, absPath, fileSteps, formatSize, matchPaths, sortEntries, statStamp, viewText, walkTree } from './list'

export type FilesIo = Io & {
  getFiles: () => Promise<FilesView>
  setFiles: (change: Partial<FilesView>) => Promise<void>
  updateFiles: (fn: (f: FilesView) => FilesView) => Promise<unknown>
  getFileCover: () => Promise<FileView>
  showFileCover: (shown: FileView) => Promise<unknown>
}

// 連點兩個資料夾時，先點的讀得比較慢也不會蓋掉後點的。
const folderLoads = latestOnly()

// 列出 dir（相對 session 資料夾，'' 是它本身）。用 session.root 不用 cwd，跟 Git 分頁一樣不跟著 Bash 的 cd 跑。
// 只存畫得到的前 FILES_ROW_LIMIT 筆：每次重列比對、每次重畫都不用帶著上千筆。
export async function loadFiles(io: FilesIo, dir: string) {
  const isStale = folderLoads.start()
  const root = await io.root()
  const listed = await io.list(absPath(root, dir)).then(
    list => ({ entries: sortEntries(list), error: '' }),
    (err: unknown) => ({ entries: [], error: `Couldn't list ./${dir}: ${errorText(err)}` }),
  )
  if (isStale()) return
  await io.setFiles({ dir, isLoaded: true, entries: listed.entries.slice(0, FILES_ROW_LIMIT), total: listed.entries.length, error: listed.error })
}

export async function reloadFiles(io: FilesIo) {
  await loadFiles(io, (await io.getFiles()).dir)
}

type Walk = { paths: string[]; isCapped: boolean }

// 搜尋用的 session 資料夾底下所有檔案，第一次搜的時候才走一遍，之後打字只重新過濾；換分頁、回合結束丟掉。
let walked: Promise<Walk> | undefined
// 打字很快時，晚算完的舊搜尋不寫。
const fileSearches = latestOnly()

// 搜尋用的：整個 session 資料夾，跳過 FILES_WALK_SKIP。之後每次打字只要依序挑出符合的，不用再排。
async function walkFiles(io: FilesIo): Promise<Walk> {
  const rule: WalkRule = { limit: FILES_WALK_LIMIT, skipDir: name => FILES_WALK_SKIP.includes(name), keep: () => true }
  const { found, isCapped } = await walkTree(io.list, await io.root(), rule).catch(() => ({ found: [], isCapped: false }))

  return { paths: found.map(f => f.path), isCapped }
}

// 搜尋框有字就從整個 session 資料夾挑出符合的檔案（存前 FILES_ROW_LIMIT 筆）；沒字就回到資料夾列表。
async function findFiles(io: FilesIo, query: string) {
  const isStale = fileSearches.start()
  if (!hasQuery(query)) return io.setFiles({ found: null })
  const all = await (walked ??= walkFiles(io))
  if (isStale()) return
  await io.setFiles({ found: { ...matchPaths(all.paths, query, FILES_ROW_LIMIT), isCapped: all.isCapped } })
}

export async function searchFiles(io: FilesIo, text: string) {
  await io.setFiles({ query: text })
  await findFiles(io, text)
}

export async function clearFilesQuery(io: FilesIo) {
  walked = undefined
  fileSearches.drop()
  await io.setFiles({ ...NO_FILE_MENU, query: '', found: null })
}

// Files 選單裡 Delete 的待確認計時；開關選單就停掉。
const fileArm: ArmSlot = {}

// ⋯ 選單一次只開一列的，換列、離開分頁、開檔案都收起來（換資料夾、搜尋見 setFiles）。
export async function toggleFileMenu(io: FilesIo, path: string) {
  fileArm.timer?.cancel()
  await io.updateFiles(f => patch(f, { ...NO_FILE_MENU, menu: f.menu === path ? '' : path }))
}

// Windows：直接跑 explorer 會照引擎隱藏子程式視窗的設定，開成看不見的視窗；改由 Start-Process 用一般視窗開。
// 路徑從環境變數給，不拼進指令。
const REVEAL_ARGV = powershellArgv(
  "$ErrorActionPreference = 'Stop'; Start-Process -FilePath explorer.exe -WindowStyle Normal -ArgumentList ('/select,\"' + $env:SOAP_PATH + '\"')",
)

// 在檔案總管裡選起它（資料夾也是在上一層選起來）；macOS 用 open -R。
export async function revealFile(io: FilesIo, path: string) {
  const abs = absPath(await io.root(), path)
  try {
    if (await isWindows(io)) await runOk(io, REVEAL_ARGV, 'Explorer', { env: { SOAP_PATH: abs.replace(/\//g, '\\') } })
    else await runOk(io, ['open', '-R', abs], 'open')
  } catch (err) {
    await io.setFiles({ menuError: `Couldn't show ${splitPath(path).name}: ${errorText(err)}` })

    return
  }
  await io.setFiles(NO_FILE_MENU)
}

// 刪檔案或整個資料夾要按兩次：Delete 按了換成紅字，DELETE_ARM_MS 內再按才刪，不經過資源回收筒。
export async function deleteFile(io: FilesIo, path: string) {
  const f = await io.getFiles()
  const arm = () => io.setFiles({ isDeleteArmed: true, menuError: '' })
  if (!(await isConfirmed(io, fileArm, f.isDeleteArmed, arm, () => io.setFiles({ isDeleteArmed: false })))) return
  const { name } = splitPath(path)
  try {
    await removePath(io, absPath(await io.root(), path))
  } catch (err) {
    await io.setFiles({ isDeleteArmed: false, menuError: `Couldn't delete ${name}: ${errorText(err)}` })

    return
  }
  await io.leaveRow(`files:more:${path}`)
  // 搜尋用的檔案清單只濾掉刪掉的，不重走整個 session 資料夾。
  walked = walked?.then(w => ({ ...w, paths: w.paths.filter(p => p !== path && !p.startsWith(`${path}/`)) }))
  await io.setFiles(NO_FILE_MENU)
  await Promise.all([reloadFiles(io), findFiles(io, f.query)])
}

// 連按 Next、或讀到一半按了 Back，晚到的舊內容不寫。
const fileReads = latestOnly()

// 關掉蓋住分頁的畫面時：讀到一半的檔案內容晚到也不寫。
export function dropFileRead() {
  fileReads.drop()
}

// 讀一個檔案（path 相對 session 資料夾）要畫的內容。太大的、二進位檔、資料夾的連結不畫內容，只說為什麼。
// known：畫面上已經是這個檔案時它的 stamp；修改時間和大小都沒變就不讀內容，回傳 null（回合結束重讀時常常沒變）。
async function readFileView(io: FilesIo, path: string, known: string): Promise<FileView | null> {
  try {
    const full = absPath(await io.root(), path)
    const stat = await io.stat(full)
    const stamp = statStamp(stat)
    if (stamp === known) return null
    const shown = { ...EMPTY_FILE_VIEW, path, stamp }
    if (stat.kind !== 'file') return { ...shown, note: 'Not a file; nothing to show.' }
    if (stat.size > FILE_VIEW_MAX_BYTES) return { ...shown, note: `Too large to show (${formatSize(stat.size)}).` }
    const text = viewText(await io.readFile(full))
    if (text === null) return { ...shown, note: 'Binary file; nothing to show.' }

    return text.text === '' ? { ...shown, note: 'Empty file.' } : { ...shown, ...text }
  } catch (err) {
    return { ...EMPTY_FILE_VIEW, path, error: `Couldn't read ${path}: ${errorText(err)}` }
  }
}

// 在 Soap Panel 裡看檔案內容（蓋掉分頁）。換了檔案才捲回最上面，回合結束重讀同一個檔案不捲；內容沒變不寫，不重畫。
export async function showFile(io: FilesIo, path: string) {
  const isStale = fileReads.start()
  const prev = await io.getFileCover()
  const shown = await readFileView(io, path, prev.path === path ? prev.stamp : '')
  if (isStale() || shown === null) return
  await io.showFileCover(shown)
  if (prev.path !== path) await io.scrollTop()
}

export async function stepFile(io: FilesIo, step: 1 | -1) {
  const [shown, list] = await Promise.all([io.getFileCover(), io.getFiles()])
  const next = neighbour(fileSteps(list), p => p === shown.path, step)
  if (next !== undefined) await showFile(io, next)
}

// 回合結束：Claude 可能改了檔案。重列（有搜尋就重新走一遍再找），開著檔案內容就重讀。
export async function reloadShownFiles(io: FilesIo) {
  const [shown, list] = await Promise.all([io.getFileCover(), io.getFiles()])
  walked = undefined
  await Promise.all([reloadFiles(io), findFiles(io, list.query), shown.path === '' ? undefined : showFile(io, shown.path)])
}
