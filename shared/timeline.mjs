const HOUR = 3600000;
const hourlyLimit = 120;
const forecastLimit = 240;
export const playbackRates = Object.freeze([0.25, 0.5, 1, 1.5, 2, 4]);

export function availableLead(hour) {
  return Number.isInteger(hour) && hour >= 0 && hour <= forecastLimit &&
    (hour <= hourlyLimit || hour % 3 === 0);
}

export function forecastTimes(run) {
  const start = new Date(run).getTime();
  const frames = [];
  for (let hour = -24; hour <= forecastLimit; hour += hour < hourlyLimit ? 1 : 3)
    frames.push(start + hour * HOUR);
  return frames;
}

export function forecastFrame(run, time) {
  const latest = new Date(run).getTime();
  const cycle = time < latest ? Math.floor(time / (6 * HOUR)) * 6 * HOUR : latest;
  const lead = (time - cycle) / HOUR;
  return availableLead(lead) ? { run: new Date(cycle).toISOString(), lead } : null;
}

// Times and slider stops are strictly increasing. Prefer the earlier frame on a tie.
export function nearestFrame(frames, value) {
  let lo = 0, hi = frames.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (frames[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  if (!lo || lo === frames.length) return Math.min(lo, frames.length - 1);
  return value - frames[lo - 1] <= frames[lo] - value ? lo - 1 : lo;
}

// Use the common time increment as the native range unit. Gaps remain visible
// and pointer input can snap to an actual frame on either side of a gap.
export function frameStops(frames) {
  if (!frames.length) return [];
  let unit = 0;
  for (let i = 1; i < frames.length; i++) {
    let gap = frames[i] - frames[i - 1];
    while (gap) [unit, gap] = [gap, unit % gap];
  }
  return frames.map(time => (time - frames[0]) / (unit || 1));
}
