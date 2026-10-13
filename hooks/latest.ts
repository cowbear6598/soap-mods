// 非同步工作的排隊：只寫最新的那次（latestOnly）、同一時間只跑一次（coalesce）。

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

/**
 * Runs one `fn` at a time: a `run()` while one is going asks for one more pass once it ends, and gets the same
 * promise, settled after that pass. `isWanted()` is true while a pass is queued, so the running one can skip writing.
 */
export function coalesce() {
  let running: Promise<void> | undefined
  let isQueued = false

  return {
    run(fn: () => Promise<void>): Promise<void> {
      if (running !== undefined) {
        isQueued = true

        return running
      }
      running = (async () => {
        try {
          do {
            isQueued = false
            await fn()
          } while (isQueued)
        } finally {
          running = undefined
        }
      })()

      return running
    },
    isWanted: () => isQueued,
  }
}
