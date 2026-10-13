// 非同步讀取的「只寫最新的」：讀完時已經有更新的讀取開始了（或被 drop 掉），這次讀到的就不寫，免得蓋掉新的。

/** A ticket counter: `start()` returns `isStale`, true once a later `start()` or a `drop()` came. */
export function latestOnly() {
  let latest = 0

  return {
    start() {
      const ticket = (latest += 1)

      return () => ticket !== latest
    },
    drop() {
      latest += 1
    },
  }
}
