// Claude 的 Bash 不准碰這個 mod 存的機密：Keychain 裡 GitLab token、DB 密碼的項目，記著它們的 $.store key，
// 和拿 token 打 GitLab API 的 header。比對指令的字：擋的是順手去讀，不是刻意繞過（那要靠 Keychain 的允許視窗）。

import { CI_KEYCHAIN_SERVICE, CI_STORE_KEY, DB_KEYCHAIN_SERVICE, DB_STORE_KEY } from './config'

const GUARDED = [CI_KEYCHAIN_SERVICE, DB_KEYCHAIN_SERVICE, CI_STORE_KEY, DB_STORE_KEY, 'PRIVATE-TOKEN']

// 讀 Keychain（security）、解 DPAPI（PowerShell）、拿 token 打 API（curl 這類）、讀 $.store 的 JSON（jq）。
// 指令裡沒有這些程式就不擋：grep 原始碼、改檔時提到機密的名稱不算。前後不是字母、數字、-：security-review 這種名稱不算。
const READERS = /(?:^|[^\w-])(?:security|powershell|pwsh|curl|wget|jq|invoke-restmethod|invoke-webrequest)(?:[^\w-]|$)/i

/** Why `command` may not run, '' when it may: it runs a program that could read or use a secret Soap Panel keeps, and names that secret. */
export function secretCommandReason(command: string): string {
  if (!READERS.test(command)) return ''
  const text = command.toLowerCase()
  const hit = GUARDED.find(word => text.includes(word.toLowerCase()))

  return hit === undefined
    ? ''
    : `Blocked by soap-mods: this command touches "${hit}", a secret only Soap Panel may use (the GitLab token or a DB password). Use the panel instead; do not try another way.`
}
