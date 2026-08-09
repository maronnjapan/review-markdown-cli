const DEFAULT_DELAY_MS = 800;

/**
 * Debounced save with at-most-one request in flight.
 *
 * Calls that arrive while a save is running collapse into it and trigger one
 * more round afterwards, so the file always ends up matching the screen.
 *
 * @param {object} options
 * @param {() => Promise<boolean>} options.save performs one save; resolves false on failure.
 * @param {() => boolean} [options.hasPendingWork] true while unsaved changes remain.
 */
export function createAutosave({ save, hasPendingWork = () => false, delay = DEFAULT_DELAY_MS }) {
  let timer = null;
  let inFlight = null;
  let queued = false;

  function cancel() {
    clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delay);
  }

  function run() {
    cancel();
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        let saved = true;
        do {
          queued = false;
          saved = await save();
        } while (saved && queued);
        return saved;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** Runs until nothing is left to save. Resolves false as soon as a save fails. */
  async function flush() {
    cancel();
    while (inFlight || hasPendingWork()) {
      const saved = inFlight ? await inFlight : await run();
      if (!saved) return false;
    }
    return true;
  }

  return {
    schedule,
    cancel,
    run,
    flush,
    isBusy: () => Boolean(timer || inFlight)
  };
}
