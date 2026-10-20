// Wiki 子分頁（.soap/wiki）的動作：列頁面、勾選、看頁面和草稿、Accept／Discard、Distill、Send。
// 不碰 $ 和 atom，用 register.tsx 給的 WikiIo（見 io.ts）。

import type { EngineInterface, ModelForkResult, SessionMessage } from 'claude-code'

import type { WikiModel, WikiSent, WikiView } from '../../types'
import {
  WIKI_DIR,
  WIKI_DISTILL_MAX_BYTES,
  WIKI_DISTILL_MAX_TOKENS,
  WIKI_DISTILL_TIMEOUT_MS,
  WIKI_MODEL_KEY,
  WIKI_PAGE_LIMIT,
  WIKI_TRANSCRIPT_MAX_CHARS,
} from '../config'
import { NO_WIKI_OPEN } from '../defaults'
import { errorText } from '../errors'
import { type Found, type WalkRule, walkTree } from '../files/actions'
import { byName } from '../files/list'
import type { Io } from '../io'
import { latestOnly } from '../latest'
import { unifiedDiff } from '../merge/algo'
import { type ArmSlot, isConfirmed, removePath } from '../shell'
import { cutAtLineEnd } from '../text'
import {
  type PageText,
  type ParsedDraft,
  DRAFTS_PATH,
  checkedKey,
  checkedList,
  draftFixNote,
  draftIdOf,
  draftPages,
  draftText,
  distillPrompt,
  isPagePath,
  pagesContext,
  parseDistill,
  parseDraft,
  pickPages,
  toggled,
  transcriptText,
  wikiDraft,
  wikiModelLabel,
  wikiModelOf,
  wikiPath,
} from './parse'

export type WikiIo = Io & {
  getWiki: () => Promise<WikiView>
  setWiki: (change: Partial<WikiView>) => Promise<void>
  updateWikiSent: (fn: (s: WikiSent) => WikiSent) => Promise<unknown>
  fill: EngineInterface['prompt']['fill']
  fork: EngineInterface['model']['fork']
  complete: EngineInterface['model']['complete']
  messages: () => Promise<SessionMessage[]>
  sessionModel: () => Promise<string>
  sessionId: () => Promise<string>
  append: EngineInterface['session']['append']
}

// 連點兩頁、讀到一半按了 Back，晚到的舊清單、舊內容不寫。
const wikiLoads = latestOnly()
const wikiReads = latestOnly()

const pageAbs = (root: string, path: string) => `${root}/${wikiPath(path)}`
const draftAbs = (root: string, id: string) => `${root}/${DRAFTS_PATH}/${id}`

// .soap/wiki 底下的頁面和大小：子資料夾也找（. 開頭的不看，草稿在那裡），最多 WIKI_PAGE_LIMIT 頁，照路徑排。
// 最上層列不出來就丟出去（loadWiki 再看是不存在還是讀不到）。
async function listPages(io: WikiIo, root: string): Promise<Found[]> {
  const rule: WalkRule = { limit: WIKI_PAGE_LIMIT, skipDir: name => name.startsWith('.'), keep: (path, e) => e.kind === 'file' && isPagePath(path) }

  return (await walkTree(io.list, `${root}/${WIKI_DIR}`, rule)).found
}

// 勾了哪幾頁：存在 $.store（每個 session 資料夾一個 key），專案裡不留檔案；讀不到就是一頁都沒勾。
async function readChecked(io: WikiIo, root: string): Promise<string[]> {
  return checkedList(await io.storeGet(checkedKey(root)).catch(() => undefined))
}

async function writeChecked(io: WikiIo, root: string, paths: readonly string[]) {
  await (paths.length === 0 ? io.storeDelete(checkedKey(root)) : io.storeSet(checkedKey(root), [...paths]))
}

// 勾著的頁面被搬走就換成新路徑（to），被刪掉就拿掉（沒給 to）。存不進去不擋住刪頁面、套用草稿。
async function moveChecked(io: WikiIo, root: string, from: string, to?: string) {
  const checked = await readChecked(io, root)
  if (!checked.includes(from)) return
  const next = [...new Set(checked.map(c => (c === from ? to : c)))].filter((c): c is string => c !== undefined)
  await writeChecked(io, root, next).catch(() => undefined)
}

// 畫面只畫還在的頁面：已經不在的留在 store 裡，不列出來。
const shownChecked = (checked: readonly string[], pages: readonly string[]) => checked.filter(c => pages.includes(c))

// 一份草稿做什麼；第一行看不懂就丟出去。
async function readDraft(io: WikiIo, root: string, id: string): Promise<ParsedDraft> {
  const d = parseDraft(await io.readFile(draftAbs(root, id)))
  if (d === null) throw new Error('its first line is none of target:, move: or delete:')

  return d
}

// 這幾頁的內容；不是頁面路徑的、讀不到的（刪掉了）略過。
async function readPages(io: WikiIo, root: string, paths: readonly string[]): Promise<PageText[]> {
  const read = await Promise.all(
    paths.filter(isPagePath).map(path => io.readFile(pageAbs(root, path)).then((text): PageText => ({ path, text }), () => undefined)),
  )

  return read.filter(p => p !== undefined)
}

// Distill 和 wiki skill 寫的草稿，照檔名排（Distill 的檔名是寫的時間，舊的在上面）；第一行看不懂的不算。
async function listDrafts(io: WikiIo, root: string): Promise<{ id: string; draft: ParsedDraft }[]> {
  const list = await io.list(`${root}/${DRAFTS_PATH}`).catch(() => [])
  const ids = list.filter(e => e.kind === 'file' && e.name.endsWith('.md')).map(e => e.name).sort(byName)
  const drafts = await Promise.all(
    ids.map(async id => {
      const draft = await io.readFile(draftAbs(root, id)).then(parseDraft, () => null)

      return draft === null ? undefined : { id, draft }
    }),
  )

  return drafts.filter(d => d !== undefined)
}

// 列出頁面、勾了哪幾頁、草稿。還沒有 .soap/wiki 是還沒有頁面，不是錯誤：列不出來時才看它在不在。
async function loadWiki(io: WikiIo) {
  const isStale = wikiLoads.start()
  const root = await io.root()
  const listing = (async () => {
    const [found, checked, drafts] = await Promise.all([listPages(io, root), readChecked(io, root), listDrafts(io, root)])
    const pages = found.map(f => f.path)
    const hasPage = (path: string) => pages.includes(path)

    return { pages, checked: shownChecked(checked, pages), drafts: drafts.map(d => wikiDraft(d.id, d.draft, hasPage)), error: '' }
  })().catch(async (err: unknown) => ({
    pages: [],
    checked: [],
    drafts: [],
    error: (await io.exists(`${root}/${WIKI_DIR}`).catch(() => true)) ? `Couldn't list ./${WIKI_DIR}: ${errorText(err)}` : '',
  }))
  const [listed, model] = await Promise.all([listing, readWikiModel(io)])
  if (isStale()) return
  await io.setWiki({ isLoaded: true, model, ...listed })
}

// Summary Conversation 選的模型；讀不到是 ''（跟對話同一種）。
async function readWikiModel(io: WikiIo): Promise<WikiModel | ''> {
  return wikiModelOf(await io.storeGet(WIKI_MODEL_KEY).catch(() => undefined))
}

export async function selectWikiModel(io: WikiIo, model: WikiModel) {
  await io.setWiki({ model, isModelOpen: false })
  await io.storeSet(WIKI_MODEL_KEY, model).catch(() => undefined)
}

// 存勾選，畫面只畫還在的頁面；存不進去就說。
async function saveChecked(io: WikiIo, root: string, checked: readonly string[]) {
  try {
    await writeChecked(io, root, checked)
    await io.setWiki({ checked: shownChecked(checked, (await io.getWiki()).pages), error: '' })
  } catch (err) {
    await io.setWiki({ error: `Couldn't save the checked pages: ${errorText(err)}` })
  }
}

// 勾選框：已經不在的頁面也留著。
export async function toggleWikiPage(io: WikiIo, path: string) {
  const root = await io.root()
  await saveChecked(io, root, toggled(await readChecked(io, root), path))
}

// 把路徑（session 資料夾底下的）當 @ 引用插進聊天框的游標位置；放不進去（有對話框擋著、沒有聊天框）就跳提示。
export async function mentionPath(io: WikiIo, path: string) {
  const r = await io.fill({ text: `@${path} `, mode: 'insert' })
  if (!r.isFilled) io.toast(r.refusal === 'dialog' ? 'Close the dialog first.' : "Couldn't put the path in the prompt box.")
}

// Uncheck all：已經不在的頁面也一起清掉。
export async function uncheckAllWikiPages(io: WikiIo) {
  await saveChecked(io, await io.root(), [])
}

// 在分頁裡看一頁的 Markdown。換了頁才捲回最上面；回合結束重讀同一頁，內容沒變就不重畫。
export async function openWikiPage(io: WikiIo, path: string) {
  const isStale = wikiReads.start()
  const shown = await io.readFile(pageAbs(await io.root(), path)).then(
    text => ({ ...cutAtLineEnd(text.trim()), readError: '' }),
    (err: unknown) => ({ text: '', isTruncated: false, readError: `Couldn't read ${wikiPath(path)}: ${errorText(err)}` }),
  )
  if (isStale()) return
  const prev = await io.getWiki()
  await io.setWiki({ ...NO_WIKI_OPEN, open: path, ...shown })
  if (prev.open !== path) await io.scrollTop()
}

// 看一份草稿：新頁面畫它的 Markdown；改既有頁面的畫原頁面到草稿的差異；搬移、刪除畫那頁現在的內容（讀不到就說，Accept 照樣按得到）。
// 頁面在不在看當下的，不看清單上的。
export async function openWikiDraft(io: WikiIo, id: string) {
  const isStale = wikiReads.start()
  const root = await io.root()
  const shown = await (async () => {
    const d = await readDraft(io, root, id)
    if (d.kind !== 'write') {
      const from = draftPages(d).from ?? d.target

      return io.readFile(pageAbs(root, from)).then(
        text => ({ isNew: false, ...cutAtLineEnd(text.trim()), diff: '', readError: '' }),
        (err: unknown) => ({ isNew: false, text: '', diff: '', isTruncated: false, readError: `Couldn't read ${wikiPath(from)}: ${errorText(err)}` }),
      )
    }
    const page = await io.readFile(pageAbs(root, d.target)).catch(() => undefined)
    if (page === undefined) return { isNew: true, ...cutAtLineEnd(d.body), diff: '', readError: '' }
    const diff = unifiedDiff(page, `${d.body}\n`)

    return { isNew: false, text: d.body, diff: diff.source, isTruncated: diff.isTruncated, readError: '' }
  })().catch((err: unknown) => ({ isNew: true, text: '', diff: '', isTruncated: false, readError: `Couldn't read draft ${id}: ${errorText(err)}` }))
  if (isStale()) return
  const prev = await io.getWiki()
  const { isNew, ...view } = shown
  const drafts = prev.drafts.map(x => (x.id === id && x.kind === 'write' ? { ...x, isNew } : x))
  // 回合結束重讀同一份草稿，看到第幾頁留著。
  await io.setWiki({ ...NO_WIKI_OPEN, draft: id, ...view, drafts, deleteError: '', diffPage: prev.draft === id ? prev.diffPage : 0 })
  if (prev.draft !== id) await io.scrollTop()
}

// 草稿的差異換頁，捲回最上面從頭看。
export async function showWikiDiffPage(io: WikiIo, page: number) {
  await io.setWiki({ diffPage: page })
  await io.scrollTop()
}

export async function closeWiki(io: WikiIo) {
  wikiReads.drop()
  await io.setWiki(NO_WIKI_OPEN)
  await loadWiki(io)
}

// Wiki 子分頁看得到的那個：清單，或打開的頁面、草稿（清單這時畫不到，不用重列）。
export async function reloadWiki(io: WikiIo) {
  const s = await io.getWiki()
  await (s.draft !== '' ? openWikiDraft(io, s.draft) : s.open !== '' ? openWikiPage(io, s.open) : loadWiki(io))
}

// 照一份草稿改 wiki，改完刪掉草稿：寫整頁（新頁面或取代）；搬移是先寫到新路徑再刪舊的，新路徑已經有頁面就不蓋掉；
// 要拿掉的頁面已經不在就略過。勾著的頁面跟著搬、跟著拿掉。
async function applyDraft(io: WikiIo, root: string, id: string) {
  const d = await readDraft(io, root, id)
  const { from, to } = draftPages(d)
  if (d.kind === 'write') await io.writeFile(pageAbs(root, d.target), `${d.body}\n`)
  if (d.kind === 'move') {
    const [isTaken, text] = await Promise.all([io.exists(pageAbs(root, d.target)), io.readFile(pageAbs(root, d.from))])
    if (isTaken) throw new Error(`${wikiPath(d.target)} already exists`)
    await io.writeFile(pageAbs(root, d.target), text)
  }
  if (from !== undefined && (await io.exists(pageAbs(root, from)))) await removePath(io, pageAbs(root, from))
  await removePath(io, draftAbs(root, id))
  if (from !== undefined) await moveChecked(io, root, from, to)
}

// 打開的草稿：Accept 照草稿改 wiki；Discard 只刪草稿。做完回清單。
export async function settleWikiDraft(io: WikiIo, isAccept: boolean) {
  const s = await io.getWiki()
  if (s.draft === '') return
  const root = await io.root()
  try {
    await (isAccept ? applyDraft(io, root, s.draft) : removePath(io, draftAbs(root, s.draft)))
  } catch (err) {
    await io.setWiki({ deleteError: `Couldn't ${isAccept ? 'accept' : 'discard'} draft ${s.draft}: ${errorText(err)}` })

    return
  }
  await io.setWiki({ deleteError: '' })
  await closeWiki(io)
}

const wikiArm: ArmSlot = {}

// 刪 .soap/wiki 底下的檔案要按兩次：垃圾桶按了換成打勾，DELETE_ARM_MS 內再按才刪；按別的垃圾桶，原本的就收回。
// 頁面刪了也從勾選拿掉；草稿（.drafts/<id>）只刪草稿，同 Discard。
export async function deleteWikiFile(io: WikiIo, path: string) {
  const arm = () => io.setWiki({ deleteArmed: path, deleteError: '' })
  if (!(await isConfirmed(io, wikiArm, (await io.getWiki()).deleteArmed === path, arm, () => io.setWiki({ deleteArmed: '' })))) return
  await io.setWiki({ deleteArmed: '' })
  const root = await io.root()
  const draftId = draftIdOf(path)
  try {
    if (draftId !== undefined) await removePath(io, draftAbs(root, draftId))
    else {
      if (!isPagePath(path)) throw new Error('not a wiki page')
      await removePath(io, pageAbs(root, path))
      await moveChecked(io, root, path)
    }
  } catch (err) {
    await io.setWiki({ deleteError: `Couldn't delete ${path}: ${errorText(err)}` })
    await loadWiki(io)

    return
  }
  await io.leaveRow()
  await io.setWiki({ deleteError: '' })
  await loadWiki(io)
}

// Distill 沒產生草稿的原因。還沒有回覆過（nothing-to-fork：新對話、剛 /clear）不算失敗，由呼叫的地方不說話。
function distillFailure(r: Exclude<ModelForkResult, { isAnswered: true } | { reason: 'nothing-to-fork' }>): string {
  switch (r.reason) {
    case 'api-error':
      return `Distill failed: the API answered ${r.error}${r.status === null ? '' : ` (${r.status})`}. Try again.`
    case 'empty-reply':
      return 'Distill got an empty reply. Try again.'
    case 'aborted':
      return 'Distill was cut off. Try again.'
  }
}

// 問選的模型這段對話值得留下什麼。跟對話同一種（或兩邊都不知道）就從快取接著問（模型就是對話的）；
// 其他的把對話轉成文字另外問，還沒有回覆過就跟接著問一樣回 nothing-to-fork。
async function askDistill(io: WikiIo, model: WikiModel | '', current: WikiModel | '', pages: { shown: readonly PageText[]; named: readonly string[] }): Promise<ModelForkResult> {
  if (model === '' || model === current) return io.fork({ prompt: distillPrompt(pages.shown, pages.named) })
  const messages = await io.messages()
  if (!messages.some(m => m.role === 'assistant')) return { isAnswered: false, reason: 'nothing-to-fork' }

  return io.complete({
    model,
    prompt: distillPrompt(pages.shown, pages.named, transcriptText(messages, WIKI_TRANSCRIPT_MAX_CHARS)),
    maxTokens: WIKI_DISTILL_MAX_TOKENS,
    timeoutMs: WIKI_DISTILL_TIMEOUT_MS,
  })
}

// 正在 Distill。跟 dbBusy 一樣放模組變數不放 atom，免得被熱重載中斷後一直停在「Summarizing…」。
let isDistilling = false

export const distilling = () => isDistilling

function setDistilling(io: WikiIo, isBusy: boolean) {
  isDistilling = isBusy
  io.invalidate()
}

// Distill：只有按了才跑。把這段對話和現有頁面給選的模型，請它寫出值得留下的草稿，
// 存進 .soap/wiki/.drafts 等人看；頁面一頁都不動。一次只跑一個。說明最後寫用了哪個模型。
export async function distillWiki(io: WikiIo) {
  if (isDistilling) return
  setDistilling(io, true)
  const current = await currentModel(io)
  const model = (await io.getWiki()).model || current
  await io.setWiki({ distillNote: '' })
  let note: string
  try {
    const root = await io.root()
    // 只讀放得下的頁面（照大小挑），其餘只給路徑。
    const picked = pickPages(await listPages(io, root).catch(() => []), WIKI_DISTILL_MAX_BYTES)
    const r = await askDistill(io, model, current, { shown: await readPages(io, root, picked.shown), named: picked.named })
    const drafts = r.isAnswered ? parseDistill(r.text) : []
    const now = await io.now()
    await Promise.all(drafts.map((d, i) => io.writeFile(draftAbs(root, `${now}-${i + 1}.md`), draftText(d.target, d.body))))
    // 有草稿就不寫說明：Drafts (N) 的標題已經寫了幾份，說明裡的數字會在 Accept／Discard 後過時。還沒有回覆過也不寫。
    if (!r.isAnswered) note = r.reason === 'nothing-to-fork' ? '' : distillFailure(r)
    else note = drafts.length === 0 ? 'Nothing new worth keeping in this conversation.' : ''
  } catch (err) {
    note = `Distill failed: ${errorText(err)}`
  }
  const name = wikiModelLabel(model)
  setDistilling(io, false)
  await io.setWiki({ distillNote: name === '' || note === '' ? note : `${note} (${name})` })
  await loadWiki(io)
}

// 對話目前用的模型種類（/model 選的）；讀不到是 ''。
export async function currentModel(io: WikiIo): Promise<WikiModel | ''> {
  return wikiModelOf(await io.sessionModel().catch(() => ''))
}

// Send：把勾了的頁面加進這段對話（使用者角色、不顯示成打的字），Claude 下一個回合就讀得到，不會為此多跑一個回合。
// 記下這段對話送過哪幾頁，清單上標 sent；/clear 之後是另一段對話，標記跟著不見。
export async function sendWikiPages(io: WikiIo) {
  const root = await io.root()
  const pages = await readPages(io, root, await readChecked(io, root))
  if (pages.length === 0) return void io.toast('Check the pages to send first.')
  const r = await io.append({ message: { type: 'user', content: [{ type: 'text', text: pagesContext(pages) }] } })
  if (r.deny !== undefined) return void io.toast(`Couldn't send the pages: ${r.deny}`)
  const conversation = await io.sessionId()
  const paths = pages.map(p => p.path)
  await io.updateWikiSent(s => ({ conversation, pages: [...new Set([...(s.conversation === conversation ? s.pages : []), ...paths])] }))
  io.toast(`Sent ${pages.length} page${pages.length === 1 ? '' : 's'} to Claude`)
}

// Claude 寫了 .soap/wiki/.drafts 底下的草稿（wiki skill 會寫）：第一行 Wiki 子分頁看不懂就告訴它怎麼改，也跳個 toast。
export async function checkDraftWrite(io: Io, path: string) {
  if (parseDraft(await io.readFile(path)) !== null) return undefined
  void io.toast('A wiki draft has no target:, move: or delete: first line; the Wiki tab skips it.')

  return draftFixNote(path)
}
