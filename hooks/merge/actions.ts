// 解衝突（三欄合併，畫在 Soap Panel 裡）：讀 git 留著的三個版本、跳到下一段衝突、Apply、用某一邊、交給 Claude。

import type { GitFile, MergeChunk, MergeView } from '../../types'
import { coverData, patchCover, showCover } from '../cover'
import { EMPTY_MERGE } from '../defaults'
import { errorText } from '../errors'
import { isConflict, isPromptSafePath } from '../git/parse'
import { type GitIo, git, gitOk, inRepo } from '../git/run'
import { neighbour } from '../neighbour'
import { busyFlag, openFile, openReason } from '../shell'
import { buildResult, isResolved, keepChoices, merge3, nextConflict, parseConflicts, splitLines } from './algo'

// 開著的合併；開著的不是合併就是空的（path 是 ''）。
async function readMerge(io: GitIo) {
  return coverData(await io.getCover(), 'merge') ?? EMPTY_MERGE
}

// 只改開著的合併；開著的不是合併就不動。
async function setMerge(io: GitIo, change: Partial<MergeView>) {
  await io.updateCover(c => patchCover(c, 'merge', change))
}

export async function editChunks(io: GitIo, edit: (chunks: MergeChunk[]) => MergeChunk[]) {
  await io.updateCover(c => patchCover(c, 'merge', { chunks: edit(coverData(c, 'merge')?.chunks ?? []) }))
}

// git 為這個衝突檔案留了哪幾個版本（1 共同祖先、2 ours、3 theirs）。每列是「mode sha stage<TAB>path」，
// 所以整段輸出也代表了這組版本：版本換了（例如 rebase 換到下一個 commit）它就跟著變。
async function listStages(io: GitIo, path: string) {
  const r = await gitOk(io, ['ls-files', '-u', '-z', '--', path])
  const stages = new Set(r.stdout.split('\0').map(line => Number(line.split('\t')[0]?.split(' ')[2])))

  return { key: r.stdout, stages }
}

// 三個版本做完三方比對的段落；少了 ours 或 theirs（一邊刪掉）比不了是 null。
type Stages = { path: string; key: string; chunks: MergeChunk[] | null }
// 上一次讀到的版本和比對結果：同一個檔案、同一組版本就不用再跑三次 git show，也不用再比一次。
let stageCache: Stages | undefined

// git 留著的某一個版本；那一邊沒有這個檔案、或大到讀不完（拿去比對的話，Apply 會寫回截掉的檔案）就是 null。
async function readStage(io: GitIo, stage: 1 | 2 | 3, path: string) {
  const r = await git(io, ['show', `:${stage}:${path}`]).catch(() => null)

  return r === null || r.exitCode !== 0 || r.isStdoutTruncated ? null : splitLines(r.stdout)
}

async function readStages(io: GitIo, path: string, key: string | null): Promise<Stages> {
  if (key !== null && stageCache?.path === path && stageCache.key === key) return stageCache
  const [base, ours, theirs] = await Promise.all([readStage(io, 1, path), readStage(io, 2, path), readStage(io, 3, path)])
  const stages = { path, key: key ?? '', chunks: ours !== null && theirs !== null ? merge3(base, ours, theirs) : null }
  if (key !== null) stageCache = stages

  return stages
}

// 讀衝突的檔案。檔案裡還有衝突標記，就拿 git 留著的三個版本自己做三方比對，
// 分出沒動過的、只有一邊改（自動合入）的、真的衝突的段落；讀不到版本才退回只看衝突標記。
// 同一個檔案重讀時，沒變的段落保留已經做的選擇；結果跟現在畫的一樣就不寫，面板不會白白重畫。回傳讀到的結果。
async function loadMerge(io: GitIo, path: string): Promise<MergeView> {
  const [text, listed, m] = await Promise.all([
    io.readFile(inRepo(path)).catch(() => null),
    listStages(io, path).catch(() => null),
    readMerge(io),
  ])
  const parsed = text === null ? null : parseConflicts(text)
  let next: MergeView = { ...EMPTY_MERGE, path }
  if (parsed !== null) {
    const { chunks } = await readStages(io, path, listed?.key ?? null)
    next = {
      ...next,
      ...parsed,
      hasMarkers: true,
      chunks: keepChoices(m.path === path ? m.chunks : [], chunks ?? parsed.chunks),
    }
  }
  await io.updateCover(c => showCover(c, 'merge', next))

  return next
}

// 上一次跳到的衝突（chunks 的位置）；換了檔案就從頭算。
let conflictCursor = { path: '', at: -1 }

// 跳到下一段（step 1）或上一段（-1）衝突：焦點放在 ours 的 Accept 上，捲到那一列的頂端。
// 已經在最後一段（往前是第一段）再按：換到下一個（上一個）衝突檔案的第一段（最後一段）；
// 已經是最後一個（第一個）檔案就不動，不繞回去，焦點也留在原地。
// 換檔不走 openMerge：不用先捲回最上面（馬上就捲到那段）。
// 先移焦點再捲：換了檔案時那一列還沒畫出來，focus 會等它畫好，scroll 不會。
// 捲不動、焦點移不過去（面板沒拿著鍵盤）都不算錯，下次按再試。
export async function jumpConflict(io: GitIo, step: 1 | -1) {
  let m = await readMerge(io)
  let at = nextConflict(m.chunks, conflictCursor.path === m.path ? conflictCursor.at : -1, step)
  if (at === null) {
    if (isMergeBusy.get()) return
    const conflicted = (await io.getView()).files.filter(isConflict)
    const other = neighbour(conflicted, f => f.path === m.path, step)
    if (other === undefined) return
    m = await loadMerge(io, other.path)
    at = nextConflict(m.chunks, -1, step)
    // 那個檔案沒有可以一段一段選的衝突：停在它的最上面。
    if (at === null) return io.scrollTop()
  }
  conflictCursor = { path: m.path, at }
  await io.ringOn(`merge:ours:${at}`)
  await io.scrollTo(`conflict:${at}`)
}

export async function openMerge(io: GitIo, path: string) {
  await loadMerge(io, path)
  await io.scrollTop()
}

// refresh 之後：合併的檔案已經不是衝突了（解掉了、abort 了）就回到分頁，否則重讀一次（檔案可能被改過）。
export async function syncMerge(io: GitIo, files: GitFile[]) {
  if (isMergeBusy.get()) return
  const m = await readMerge(io)
  if (m.path === '') return
  const file = files.find(f => f.path === m.path)
  // 合併畫面整塊不見時，焦點圈由 checkCover 移到分頁圖示。
  if (file === undefined || !isConflict(file)) await io.closeCover()
  else await loadMerge(io, m.path)
}

// 正在套用合併或用某一邊解掉。跟 syncing 一樣放模組變數不放 atom，免得被熱重載中斷後一直卡著；
// 卡著的話不能再解檔案、也不能換 repo。離開合併時歸零。
const isMergeBusy = busyFlag(false)

export const mergeBusy = isMergeBusy.get

// 解掉合併畫面上的檔案：做事的期間顯示處理中；失敗把錯誤留在畫面上，
// 成功就回到分頁、重讀狀態。
async function resolveFile(io: GitIo, what: string, work: (path: string) => Promise<unknown>) {
  if (isMergeBusy.get()) return
  const m = await readMerge(io)
  if (m.path === '') return
  isMergeBusy.set(io, true)
  await setMerge(io, { error: '' })
  try {
    await work(m.path)
  } catch (err) {
    isMergeBusy.set(io, false)
    await setMerge(io, { error: `${what} failed: ${errorText(err)}` })

    return
  }
  await io.closeCover()
  await io.refresh()
  io.toast(`Resolved ${m.path}`)
}

// 把中間那欄寫回檔案並 git add（標成已解決）。每一段衝突都選好了才做。
export async function applyMerge(io: GitIo) {
  const m = await readMerge(io)
  if (!m.hasMarkers || !isResolved(m.chunks)) return
  await resolveFile(io, 'Apply', async path => {
    await io.writeFile(inRepo(path), buildResult(m))
    await gitOk(io, ['add', '--', path])
  })
}

// 沒有衝突標記的檔案（一邊刪掉、二進位檔）：整個檔案用某一邊，或照目前的樣子標成已解決。
// 那一邊沒有這個檔案（被刪掉了）就 git rm。
export async function takeSide(io: GitIo, side: 'ours' | 'theirs' | 'as-is') {
  await resolveFile(io, 'Resolve', async path => {
    if (side === 'as-is') return gitOk(io, ['add', '-A', '--', path])
    const { stages } = await listStages(io, path)
    if (!stages.has(side === 'ours' ? 2 : 3)) return gitOk(io, ['rm', '-q', '--', path])
    await gitOk(io, ['checkout', `--${side}`, '--', path])

    return gitOk(io, ['add', '--', path])
  })
}

// 用系統預設的 app 開衝突中的檔案（在那邊選取、複製）。
export async function openMergeFile(io: GitIo) {
  const m = await readMerge(io)
  if (m.path === '') return
  await setMerge(io, { error: await openReason(io, m.path, () => openFile(io, inRepo(m.path))) })
}

// 交給 Claude 解這個檔案：當作使用者自己打的訊息送出，session 空下來就會跑。
// 檔名來自被合併的分支，會原樣放進以使用者身分送出的訊息：有反引號、換行這些的就不送，免得檔名夾帶指令。
export async function askClaude(io: GitIo) {
  const [m, { op }] = await Promise.all([readMerge(io), io.getView()])
  if (m.path === '') return
  if (!isPromptSafePath(m.path)) {
    await setMerge(io, { error: 'Ask Claude is off for this file: its name has a backtick or a control character.' })

    return
  }
  const during = op === '' ? '' : ` (a ${op} is in progress; do not continue or abort it)`
  await io.submit({
    text: `Resolve the git conflicts in \`${inRepo(m.path)}\`${during}. Keep what both sides meant to do, remove every conflict marker, then run \`git add\` on the file.`,
    asUser: true,
  })
  io.toast('Sent to Claude')
}

// 關掉合併畫面時：選到一半的結果放掉（檔案沒動過，下次打開從頭選），處理中歸零。
export function resetMerge(io: GitIo) {
  stageCache = undefined
  isMergeBusy.set(io, false)
}
