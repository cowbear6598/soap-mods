// 搜尋框共用的比對：多個字、不分大小寫、每個字都要有。branch、log、Files 分頁都用。

/** The lowercased words of a search; none when it is blank. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(w => w !== '')
}

/** Whether a search box holds anything to search for. */
export const hasQuery = (query: string) => searchWords(query).length > 0

/** Whether lowercased `text` holds every one of `words`. */
export const hasWords = (text: string, words: readonly string[]) => words.every(w => text.includes(w))

/** Items whose `text` holds every word of `query`, ignoring case; all of them when it is blank. */
export function filterWords<T>(items: T[], query: string, text: (item: T) => string): T[] {
  const words = searchWords(query)
  if (words.length === 0) return items

  return items.filter(item => hasWords(text(item).toLowerCase(), words))
}
