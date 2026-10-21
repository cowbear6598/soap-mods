// Claude 的 Bash 不准碰這個 mod 存的機密：Keychain 裡 GitLab token、DB 密碼的項目，記著它們的 $.store key，
// 和拿 token 打 GitLab API 的 header。比對指令的字：擋的是順手去讀，不是刻意繞過（那要靠 Keychain 的允許視窗）。

import { CI_KEYCHAIN_SERVICE, CI_STORE_KEY, DB_KEYCHAIN_SERVICE, DB_STORE_KEY } from './config'

const GUARDED = [CI_KEYCHAIN_SERVICE, DB_KEYCHAIN_SERVICE, CI_STORE_KEY, DB_STORE_KEY, 'PRIVATE-TOKEN']

/** Why `command` may not run, '' when it may: it names a secret Soap Panel keeps. */
export function secretCommandReason(command: string): string {
  const text = command.toLowerCase()
  const hit = GUARDED.find(word => text.includes(word.toLowerCase()))

  return hit === undefined
    ? ''
    : `Blocked by soap-mods: this command touches "${hit}", a secret only Soap Panel may use (the GitLab token or a DB password). Use the panel instead; do not try another way.`
}
