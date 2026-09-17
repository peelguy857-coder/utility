'use strict';
/** Small helpers shared by the dmg-maker modules. */

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  if (reason !== undefined) err.cause = reason;
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal);
}

/**
 * Wrap a progress callback so it fires at most ~10 times a second per phase,
 * but always for the first and the final event of a phase.
 */
function throttledProgress(onProgress, intervalMs = 100) {
  if (typeof onProgress !== 'function') return () => {};
  let lastTime = 0;
  let lastPhase = null;
  return (event) => {
    const now = Date.now();
    const final = event.total > 0 && event.done >= event.total;
    if (event.phase === lastPhase && !final && now - lastTime < intervalMs) return;
    lastTime = now;
    lastPhase = event.phase;
    try { onProgress(event); } catch (_) { /* a broken listener must not break the build */ }
  };
}

module.exports = { abortError, throwIfAborted, throttledProgress };
