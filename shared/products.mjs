export const phaseNames = ['无降水信号', '雨', '冻雨', '冰粒', '雪', '混合相态'];
export const phasesFromFlags = (mask) =>
  [0, 1, 2, 3].filter((i) => mask & (1 << i)).map((i) => phaseNames[i + 1]);
export function phaseCode(flags) {
  if (flags.length !== 4 || flags.some((v) => v !== 0 && v !== 1)) return { value: null, mask: null };
  const mask = flags.reduce((s, v, i) => s | (v << i), 0);
  return { mask, value: mask === 0 ? 0 : mask & (mask - 1) ? 5 : 1 + Math.log2(mask) };
}
// Horizontal water-vapour transport per hPa, in kg/(m·s·hPa).
export const waterFlux = (q, component) =>
  Number.isFinite(q) && q >= 0 && Number.isFinite(component) ? (100 * q * component) / 9.80665 : null;
