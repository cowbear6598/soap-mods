// 交給系統預設 app 開的暫存檔：終端機裡選不好、捲不動的長內容，到外面的 app 選取、複製。
// 放在 session 資料夾的 TMP_DIR，檔名帶到毫秒的時間（UTC），每次開都是新檔，外部 app 開著的舊檔不會被蓋掉。

import { TMP_DIR, TMP_MAX_AGE_MS } from './config'
import type { Io } from './io'
import { openFile, removePath } from './shell'

// 資料夾裡的 .gitignore 是 *：暫存檔不出現在 Git › Diff、不會被 commit，也不用動 repo 自己的 .gitignore。
const IGNORE = '.gitignore'

const tmpDir = async (io: Io) => `${await io.root()}/${TMP_DIR}`

// 20261029-031530-123
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace(/[-:]/g, '').replace(/[T.]/g, '-')

/** Writes `text` to a new file `<name>-<time>.<ext>` under TMP_DIR and opens it in the default app; returns its path. */
export async function openTemp(io: Io, name: string, ext: string, text: string) {
  const dir = await tmpDir(io)
  await io.writeFile(`${dir}/${IGNORE}`, '*\n')
  const path = `${dir}/${name}-${stamp(await io.now())}.${ext}`
  await io.writeFile(path, text)
  await openFile(io, path)

  return path
}

/** Deletes the temp files older than TMP_MAX_AGE_MS (session start); another session's from today stay. */
export async function cleanTemp(io: Io) {
  const dir = await tmpDir(io)
  const [entries, now] = await Promise.all([io.list(dir).catch(() => []), io.now()])
  const old = entries.filter(e => e.kind === 'file' && e.name !== IGNORE && now - e.mtimeMs > TMP_MAX_AGE_MS)
  for (const e of old) await removePath(io, `${dir}/${e.name}`).catch(() => undefined)
}
