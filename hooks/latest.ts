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

/**
 * Remembers the last read: `read(base, isFresh, fn)` gives the same promise again while `base` stays and `isFresh` is
 * false, else runs `fn`. A failed read is forgotten so the next one asks again.
 */
export function lastRead<T>() {
  let last: { base: string; load: Promise<T> } | undefined

  return {
    read(base: string, isFresh: boolean, fn: () => Promise<T>): Promise<T> {
      if (!isFresh && last?.base === base) return last.load
      const load = fn()
      last = { base, load }
      load.catch(() => {
        if (last?.load === load) last = undefined
      })

      return load
    },
    drop() {
      last = undefined
    },
  }
}
