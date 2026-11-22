import { clockTime, md, validText } from './base.js';
import { nearestFrame } from '../shared/timeline.mjs';

const minute = 60000;
const day = 1440 * minute;
const beijingOffset = 480 * minute;
const labelIntervals = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080, 20160, 43200];

function candidates(frames, width, seasonal) {
  const first = frames[0], last = frames.at(-1);
  const gap = last - first > 3 * day ? 48 : 54;
  if (seasonal || frames.length * gap <= width) return frames.map((_, i) => i);
  const desired = (last - first) / minute / Math.max(1, width / gap);
  const step = (labelIntervals.find(value => value >= desired) || labelIntervals.at(-1)) * minute;
  const indexes = new Set([0]);
  const start = Math.ceil((first + beijingOffset) / step) * step - beijingOffset;
  for (let time = start; time < last; time += step) {
    let i = nearestFrame(frames, time);
    // A three-hourly forecast can bracket local midnight with 23:00 and 02:00.
    if (step >= day && frames[i] < time && frames[i + 1] < time + day) i++;
    indexes.add(i);
  }
  indexes.add(frames.length - 1);
  return [...indexes];
}

export function drawTimeRuler(element, frames, stops, seasonNames, width = element.clientWidth) {
  if (!frames.length || !width) return;
  const end = frames.length - 1, span = frames[end] - frames[0];
  const position = (i) => stops[end] ? stops[i] / stops[end] : 0;
  const textFor = (i) => {
    if (seasonNames) return seasonNames[frames[i] / 3];
    const time = frames[i];
    if (i === 0 || i === end) return validText(time);
    if (span > 3 * day) return md(time);
    return (time + beijingOffset) % day === 0 ? validText(time) : clockTime(time);
  };
  const majorIndexes = new Set(candidates(frames, width, seasonNames));
  const labels = [];
  const fragment = document.createDocumentFragment();
  let previousMark = -Infinity;
  for (let i = 0; i < frames.length; i++) {
    const at = position(i), major = majorIndexes.has(i), center = at * width;
    if (!major && i !== end && center - previousMark < 4) continue;
    const mark = document.createElement('i');
    mark.className = major ? 'time-mark major' : 'time-mark';
    mark.style.left = (at * 100) + '%';
    fragment.append(mark);
    previousMark = center;
    if (major) {
      const label = document.createElement('span');
      label.className = 'time-label' + (i === 0 ? ' first' : i === end ? ' last' : '');
      label.style.left = mark.style.left;
      label.textContent = textFor(i);
      fragment.append(label);
      labels.push({ label, mark });
    }
  }
  element.replaceChildren(fragment);
  if (labels.length < 2) return;
  const first = labels[0].label, last = labels.at(-1).label;
  if (first.getBoundingClientRect().right + 8 > last.getBoundingClientRect().left) {
    first.textContent = seasonNames ? first.textContent.slice(0, 2) : clockTime(frames[0]);
    last.textContent = seasonNames ? last.textContent.slice(0, 2) : clockTime(frames[end]);
  }
  // Measure the displayed glyphs, including tabular digits and Windows font fallback.
  const rects = labels.map(({label}) => label.getBoundingClientRect());
  let occupied = rects[0].right;
  for (let i = 1; i < labels.length; i++) {
    const { left, right } = rects[i];
    if (left < occupied + 8 || (i < labels.length - 1 && right + 8 > rects.at(-1).left)) {
      labels[i].label.remove();
      labels[i].mark.classList.remove('major');
    } else {
      occupied = right;
    }
  }
}
