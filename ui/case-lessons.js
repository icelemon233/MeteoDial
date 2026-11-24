import { HOUR, validText } from './base.js';
const wet =
  '降水需要水汽、上升运动和足够的维持时间。先找湿空气从哪里来，再看同一区域是否连续多个时段出现降水。';
const processes = {
  暴雨洪涝: [wet, '河流洪峰和城市积水还取决于流域汇流、地表条件与排水能力。'],
  山洪地灾: [
    '短时间内，山坡和沟谷会把降水迅速汇入狭窄河道。前期连续降水还会使坡体更接近饱和。',
    '沟口流量和滑坡触发点需要雨量站、水文及现场调查。',
  ],
  强对流: [
    '潮湿空气受抬升后，如果比周围空气更暖，就会继续上升。风向、风速随高度变化会影响雷暴的组织和持续时间。',
    '四小时格点反映雷暴周围的环境，单体结构、冰雹与龙卷依赖雷达和现场观测。',
  ],
  台风: [
    '低压中心周围的气流旋转，海上水汽随风进入雨带。台风移动慢或湿气流遇山抬升时，一地可以长时间受雨。',
    '中心风速、阵风和眼墙位置应对照业务定位、站报及雷达。',
  ],
  低温冰雪: [
    '近地冷空气决定地面能否保持低温。湿空气在冷层上方抬升时会形成云和降水，雪能否融化、再冻结，取决于整层温度。',
    '具体相态和覆冰厚度由探空、地面天气现象及覆冰记录核实。',
  ],
  冰冻圈灾害: [
    '融雪、融冰或降雨能改变冰雪覆盖区的水量与稳定性，陡峭地形又会把物质和水集中送入沟谷。',
    '触发时刻、冰体失稳和物源构成需要遥感与现场调查。',
  ],
  高温: [
    '持续高压控制时，下沉增温、少云和日照可共同抬升地面温度。对比连续时次，可以区分一次午后升温和持续高温。',
    '最高气温纪录须用符合标准的地面站观测核实。',
  ],
  高温干旱: [
    '持续少雨削弱土壤水分补给，高温加快蒸散。土壤变干后，用于蒸发的能量减少，也可能加剧地表升温。',
    '土壤含水量、河湖水位和作物损失还需各自的观测。',
  ],
  干旱: [
    '多个少雨时段相连，蒸散继续消耗土壤水分，水分亏缺便会积累。一场局地阵雨未必足以缓解整个流域。',
    '不同类型干旱的等级需结合长期气候基准、水文或土壤观测。',
  ],
  连阴雨: [
    '当湿气流和抬升区长时间停留，连续多轮云雨可以让日照减少、累计雨量上升。',
    '日照时数与逐日降水日数以地面记录为准。',
  ],
  沙尘大风: [
    '地表干燥且有可起沙物质时，强风可吹起颗粒，随后由低层气流输向下游。气压梯度增大常伴随风速加强。',
    '沙源和地面能见度需用沙尘监测、卫星及站点记录核实。',
  ],
  森林火险: [
    '少雨和高温会让可燃物失水。近地风既能加快干燥，也会影响已发生火灾的蔓延方向。',
    '起火原因、燃料状态和过火面积由调查及火点监测确认。',
  ],
  大雾: [
    '近地空气冷却到接近饱和或得到水汽补给时，水滴可在近地层形成。风太强时，浅薄的湿层容易被混合打散。',
    '雾的范围与等级取决于实际能见度，需地面观测。',
  ],
  雾霾: [
    '风弱、垂直混合受限时，近地污染物较难扩散。湿度上升还可能让颗粒物吸湿增长。',
    '能见度、颗粒物实测和污染源资料用于区分雾与霾。',
  ],
  次生灾害: [
    '气象过程会改变下垫面的水分、温度或受力条件。灾害规模还与地形、暴露程度和既有环境有关。',
    '具体触发链条以事件调查为准。',
  ],
};
const specials = {
  'cold-2016': '强冷空气南下，冷平流先改变低层空气，广州的降温和雨雪还取决于近地冷层何时建立。',
  bohai: '冷空气经过较暖的渤海时，从海面获得热量与水汽。气流抵达山东半岛迎风岸时，浅对流雪带更容易发展。',
  doksuri: '杜苏芮向福建靠近时，旋转风场把海上水汽带向沿岸。中心路径和外围雨带影响的地理范围不同。',
  ridge: '副热带高压长时间影响长江流域，持续少云和下沉增温有利于高温维持。',
  trough: '青藏高原南侧的槽能引导西南气流。暖湿空气进入较冷一侧并被抬升时，云雨区容易维持。',
  coldpool: '冬季欧亚大陆内陆可积累深厚冷空气。气压场改变后，原本滞留的冷空气沿低层风向东、向南推进。',
  front: '密度较大的冷空气向前推进时，会挤入暖空气下方。过境前后的低层气温、风向和地面气压共同标出冷锋。',
};
const sourceIce = ['https://pubs.cstam.org.cn/article/id/qxxb_20080311', '低温雨雪冰冻过程的环流研究'];
const iceStructure = ['https://pubs.cstam.org.cn/article/id/qxxb_20080514', '南方冻雨的垂直层结研究'];
const henanSyn = ['https://html.rhhz.net/BYZH/html/2766.htm', '河南极端降水的观测分析'];
const henanCells = ['https://doi.org/10.1175/MWR-D-22-0337.1', '郑州对流单体合并的雷达研究'];
const henanCloud = [
  'https://rdqxxb.itmm.org.cn/cn/article/doi/10.16032/j.issn.1004-4965.2024.046',
  '葵花八号观测的云系演变',
];
const wide = [25, 13, 169, 74],
  henan = [110, 32, 116.8, 36.8];
const smallBox = ([x, y]) => [x - 9, y - 6, x + 9, y + 6];
function curveTime(b, kind) {
  const rows = b.series.values.flatMap((v, i) => (Number.isFinite(v) ? [[v, i]] : []));
  if (!rows.length) return Date.parse(b.focus);
  const low =
    b.series.layer === 'pressure' ||
    (b.series.layer === 'temp2' && ['低温冰雪', '冰冻圈灾害'].includes(kind));
  const [, i] = rows.reduce((a, b) => ((low ? b[0] < a[0] : b[0] > a[0]) ? b : a));
  return Date.parse(b.start) + i * b.cadence * HOUR;
}
export function caseLesson(c) {
  const e = c.event,
    b = c.atlas,
    kind = e.kind,
    [mechanism, limit] = processes[kind] || processes['次生灾害'];
  const focus = b
    ? Date.parse(b.focus)
    : Date.parse(c.run + 'T00:00Z') + c.leads[Math.floor(c.leads.length / 2)] * HOUR;
  const time = (t) => Date.parse(t + 'Z');
  if (e.chapters?.includes('ice-2008'))
    return {
      why: '四轮雨雪冰冻期间，乌拉尔附近的阻塞形势有利于冷空气不断补充南下。高原以南的南支槽引导暖湿气流进入南方，较轻的暖空气越过贴地冷层。上暖下冷的结构使飘落的雪有机会先融化，再以过冷水滴落到冰冷的地面和电线上。',
      special:
        '暖层能否融雪、下方冷层是否足以让水滴在空中重新冻结，共同影响冻雨与冰粒的区别。持续数周的灾害由多轮过程组成。',
      limit: '温度剖面提供相态条件。实际冻雨、覆冰厚度及发生地点，须由地面天气现象和覆冰记录确认。',
      sources: [sourceIce, iceStructure],
      steps: [
        {
          label: '看冷空气与南支槽',
          layers: ['heightWide500'],
          bbox: wide,
          time: time('2008-01-25T00:00'),
          text: '沿约 60°E 寻找向北凸出的脊，再看青藏高原以南向南弯曲的槽。向前后播放，可比较两处形势是否维持。',
        },
        {
          label: '比较 1 月 26 日冷暖层',
          section: 'ice-2008',
          layers: ['temp2', 'temp925', 'temp850', 'height500'],
          point: [112.5, 25.5],
          bbox: [103, 21, 121, 31],
          time: time('2008-01-26T00:00'),
          text: '08 时，湘南参考点的专题地图格点上，2 米为 −2.3℃、925 hPa 为 −6.2℃、850 hPa 为 3.4℃。液态水滴从暖层落入冷层，可过冷或重新冻结。',
        },
        {
          label: '查看同点温湿廓线',
          section: 'ice-2008',
          profile: true,
          point: [112.5, 25.5],
          time: time('2008-01-26T00:00'),
          text: '用较细的 ERA5 格点逐层查看零度交叉和湿球温度。图中标有取样位置与分辨率，不同格距的数值会略有差别。',
        },
      ],
    };
  if (e.chapters?.includes('henan-2021'))
    return {
      why: '大陆高压与西太平洋副热带高压共同影响环流，海上台风烟花外围与副高南侧的偏东气流为河南持续输送水汽。低层气流在太行山、伏牛山迎风一侧受抬升，并在低涡附近汇合，使河南中西部易于反复生成强对流。',
      special:
        '7 月 20 日 16—17 时，郑州国家站测得 201.9 毫米。雷达研究发现，对流单体在郑州附近发展、合并并缓慢移动，使强降水反复落在同一区域。',
      limit:
        '红外云图能追踪云顶冷却和冷云团的维持。低层单体合并、近地冷池及其与低涡的作用，依据雷达、地面观测和个例研究判断。站点一小时极值与格点四小时累计的时间、空间尺度不同。',
      sources: [
        henanSyn,
        henanCells,
        henanCloud,
        ['https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/besttrack.html', '烟花最佳路径定位'],
      ],
      steps: [
        {
          label: '看两处高压与烟花',
          layers: ['heightWide500'],
          bbox: wide,
          storm: true,
          point: [113.66, 34.72],
          time: time('2021-07-20T00:00'),
          text: '从大陆高压看到西北太平洋副高，沿两侧等高线追踪环流。海上圆点表示烟花在该时刻以前最近一次的机构定位。',
        },
        {
          label: '叠加河南地形与风场',
          section: 'overview',
          layers: ['wind850', 'flux850', 'div850', 'omega700'],
          point: [113.66, 34.72],
          bbox: henan,
          terrain: true,
          time: time('2021-07-20T08:00'),
          text: '风箭头显示来流，浅金线是海拔等高线。沿水汽输送方向找迎风坡，比较低层负散度（空气水平汇入）与 700 hPa 负 ω（空气上升）的位置。格点反映区域背景，郑州附近的中尺度低涡由雷达研究确认。',
        },
        {
          label: '播放当天红外云图',
          cloud: true,
          time: time('2021-07-20T08:00'),
          text: '从上午看到傍晚，比较郑州附近冷云顶的扩展、维持和减弱，再与 16—17 时的站点小时雨量对照。',
        },
      ],
    };
  const p = c.point,
    box = smallBox(p),
    layers = c.defaults.filter((k) => k !== 'satellite'),
    start = b ? Date.parse(b.start) : Date.parse(c.run + 'T00:00Z') + c.leads[0] * HOUR;
  const t = b ? curveTime(b, kind) : focus;
  const primary = b ? b.series.layer : layers[0];
  return {
    background: !specials[c.id],
    why: specials[c.id] || mechanism,
    special: b ? c.guides.at(-1) : c.forecast,
    limit,
    sources: [],
    steps: [
      {
        label: '看过程前期的环流',
        layers: ['heightWide500'],
        bbox: wide,
        time: start,
        point: p,
        text: '从等高线的槽、脊与疏密看参考地区的上游背景。向后播放，观察控制该区域的系统移动还是停留。',
      },
      {
        label: '对照影响时段的天气场',
        layers: layers.slice(0, 4),
        bbox: box,
        point: p,
        time: focus,
        text: '对照' + (c.pointName || c.tag || c.area) + '附近同一时刻的天气场，再沿时间轴比较前后变化。',
      },
      {
        label: '定位到' + (b ? '曲线特征时次' : '专题读数'),
        layers: [primary],
        bbox: box,
        point: p,
        time: t,
        text: b ? validText(t) + ' 是本事件参考格点曲线上的可核查时次。' + c.forecast : c.outcome,
      },
      ...(b?.regional
        ? [
            {
              label: '对照附近雨量最大处',
              layers: ['rain4h'],
              point: [b.regional.lon, b.regional.lat],
              bbox: box,
              time: Date.parse(b.regional.time),
              text: c.guides.at(-1),
            },
          ]
        : []),
    ],
  };
}
