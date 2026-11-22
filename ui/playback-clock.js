import { playbackRates } from '../shared/timeline.mjs';

// A frame lasts 750 ms of playback time. Changing the rate preserves the
// fraction of the current frame that has already elapsed.
export function playbackClock() {
  let rate = 1, timer, waiting = null, remaining, since;
  function cancel() {
    clearTimeout(timer);
    const resolve = waiting;
    waiting = null;
    resolve?.();
  }
  function schedule() {
    since = performance.now();
    timer = setTimeout(cancel, remaining / rate);
  }
  return {
    get rate() { return rate; },
    setRate(next) {
      if (!playbackRates.includes(next) || rate === next) return;
      if (waiting) {
        remaining = Math.max(0, remaining - (performance.now() - since) * rate);
        clearTimeout(timer);
      }
      rate = next;
      if (waiting) schedule();
    },
    wait() {
      cancel();
      remaining = 750;
      return new Promise(resolve => { waiting = resolve; schedule(); });
    },
    cancel,
  };
}
