import { roleLevels, levelChoices, validPressure } from '../shared/levels.mjs';
export function selectionNote(role, ps, layer) {
  if (!validPressure(ps)) return '';
  const preferred = levelChoices(role, ps)[0];
  const p = Number(/\d+$/.exec(layer)?.[0]);
  if (!preferred || !p) return '';
  const actual = layer === 'wind10' ? '离地 10 米' : p + ' hPa';
  if (preferred !== layer)
    return (
      '首选的 ' + Number(/\d+$/.exec(preferred)[0]) + ' hPa 在该点缺少合适资料，本帧采用' + actual + '。'
    );
  const levels = roleLevels[role],
    i = levels?.indexOf(p);
  const previous = role === 'autoNear' && layer === 'wind10' ? 925 : i > 0 ? levels[i - 1] : null;
  if (!previous) return '';
  const reason =
    previous >= ps
      ? '已到模式地面或地下'
      : '与模式地面气压相差约 ' + Math.round(ps - previous) + ' hPa，离地间隔偏小';
  return (
    previous +
    ' hPa ' +
    reason +
    '，' +
    { autoTransport: '输送层风', autoMoisture: '湿度场', autoUpper: '环流形势', autoNear: '近地风' }[role] +
    '取' +
    actual +
    '。'
  );
}
const originalGuides = {
  'chart-000':
    '顺着等压线找地面高低压，再看锋线两侧站点的气温、风向和已观测到的天气。图头给出分析的有效时刻。',
  'chart-925':
    '在平原和沿海，先看风羽与等温线的交角，再比较冷空气前后近地风向的变化。山地要先查地面气压。低于或等于 925 hPa 的地点改读地面站或离地 10 米风。',
  'chart-850':
    '把同层风羽与等温线放在一起，判断空气从较冷一侧还是较暖一侧流入。湿度图可用来追踪上游湿区。高地的 850 hPa 若受地形遮挡，可读上游有效区域，再向上选当地可用的输送层。',
  'chart-700':
    '沿相邻站的风羽寻找风向或风速突变带，再沿等高线的气旋性弯曲找槽。切变线与湿区重叠时，可对照同一时次的垂直速度和降水回波，核实是否有抬升及降水发展。',
  'chart-500':
    '沿等高线找槽脊、短波扰动和副高边缘，比较前后时次的槽轴移动。识别冷涡还要看高度低中心是否与温度冷中心配合。',
  'chart-200':
    '沿强风带追踪高空急流轴，再比较风向和风速的空间变化。急流轴上的风很强，辐散区的位置还取决于周围的水平风场，可与同层散度图对照。',
  'chart-100':
    '位势高度和风羽反映对流层顶附近至下平流层的环流。夏季可观察南亚高压及其边缘气流，再向下对照 200 和 500 hPa，看各层系统怎样配置。',
};
export function chartGuide(id) {
  return originalGuides[id];
}
export function pressureGuide(layer) {
  if (layer === 'omega700')
    return '负值表示空气向更低气压处上升，正值表示下沉。对照同层湿度及降水区，判断抬升与水汽是否相遇。';
  if (layer === 'div200')
    return '正值表示 200 hPa 水平辐散，负值表示辐合。比较急流两侧与前后时次，再看下方有没有相应的抬升。';
  const m = /^(wind|temp|moisture|height)(\d+)$/.exec(layer);
  if (!m) return '';
  const [, variable, level] = m;
  if (variable === 'wind') {
    if (level === '10')
      return '离地 10 米风反映地表附近气流。山谷、迎风坡与背风坡的局地风还受模式地形分辨率影响。';
    if (level === '925')
      return '在低海拔区域追踪边界层内的冷空气和偏东风，遇到地形遮挡可与离地 10 米风对照。';
    if (level === '850')
      return '沿风向追踪低层空气来路，对照同层温度与湿度。水汽输送的强弱还取决于空气中的实际水汽含量。';
    if (level === '700')
      return '比较相邻格点的风向和风速，寻找切变带。再对照 700 hPa 高度、湿度和垂直速度，判断湿空气是否处在抬升区。';
    if (level === '200' || level === '300')
      return '沿强风带找急流轴。比较同层相邻格点的风向和风速，辨认急流进出口附近的流场变化。';
    return '在地面以上的 ' + level + ' hPa 追踪来流，比较上游和选点的风向，再对照同层温湿分布。';
  }
  if (variable === 'height')
    return level === '700'
      ? '沿 700 hPa 等高线寻找槽和低涡，再对照同层风场查找切变线。'
      : originalGuides['chart-' + level] || '沿等高线找槽脊，再比较前后时次的位移。';
  if (variable === 'moisture')
    return level + ' hPa 相对湿度表示该层接近饱和的程度。沿上游风向追踪湿区，并检查湿层厚度和抬升条件。';
  if (level === '2') return '离地 2 米气温可与站点实况对照。判断雨雪转换还要看近地湿球温度和上方暖层厚度。';
  return '比较 ' + level + ' hPa 同层风与等温线，判断冷暖空气怎样移动。读雨雪相态时再检查上下各层。';
}
