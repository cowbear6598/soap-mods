// Previous／Next 共用：清單裡目前那項的上一個／下一個。

/** The item `step` places from the current one in `list`; undefined past either end, or when none is current. */
export function neighbour<T>(list: T[], isCurrent: (item: T) => boolean, step: 1 | -1): T | undefined {
  const i = list.findIndex(isCurrent)

  return i === -1 ? undefined : list[i + step]
}
