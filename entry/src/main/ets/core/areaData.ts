/**
 * 中国三级行政区划（省 / 市 / 县·县级市）内嵌数据 + 查找逻辑。
 *
 * ── 数据来源 ────────────────────────────────────────────────────────────────
 *   xiangyuecn/AreaCity-JsSpider-StatsGov —— MIT 许可，版本 2025.251231.260403
 *   上游数据取自 国家地名信息库 / 高德 / 腾讯地图。
 *   版权行（Copyright (c) 2019 xiangyuecn）与许可全文见仓库根 THIRD_PARTY_NOTICES.md。
 *   内嵌文件：entry/src/main/resources/rawfile/china_areas.json（105723 字节 ≈ 103 KB）
 *
 * ── 为什么是"纯逻辑" ────────────────────────────────────────────────────────
 *   本模块不 import 任何 @kit.*，也不碰文件系统：Node 单测直接把 JSON 文本传给
 *   parseAreaData()；设备侧由调用方读 rawfile 后再把文本传进来。
 *
 * ── JSON 结构（字段名刻意取短以省体积） ──────────────────────────────────────
 *   v         : 数据版本号
 *   src       : 数据来源署名
 *   provinces : string[]                       —— 省名
 *   cities    : [provinceIndex, name][]        —— provinceIndex = 父省在 provinces 里的下标
 *   counties  : [cityIndex, name, lng, lat][]  —— cityIndex = 父市在 cities 里的下标，
 *                                                 lng/lat 来自数据源 geo 字段
 *
 * ── 坐标语义与两个已知偏差（重要） ──────────────────────────────────────────
 *   1. lng/lat 是 **GCJ-02（高德火星坐标）**，不是 WGS-84。
 *      本模块**不做任何坐标系转换**：GCJ-02 与 WGS-84 在中国境内的偏差约 300~500 米
 *      （百米级），而"选到县/区"的粒度是县域尺度（通常 10~100 公里），百米偏差
 *      完全不影响结论；引入转换反而多一处可能出错的代码。若将来要在地图上把
 *      用户照片的 WGS-84 坐标精确落点，需要在这里补 GCJ-02 → WGS-84 转换。
 *   2. 没有坐标的县用 **null** 表示，**不是 0**。
 *      (0, 0) 是几内亚湾里的一个合法坐标 —— 用 0 填充会把"没有数据"伪装成
 *      "这座县城在非洲西海岸"，是典型的"合法但错误"。当前 359 个县无坐标
 *      （台湾 358 个区 + 国外 1 个），见 findCounty / nearestCounty 的处理。
 *
 * ── provinces 的顺序 ───────────────────────────────────────────────────────
 *   保持**数据源原始顺序**，即国家行政区划代码顺序：
 *   北京、天津、河北、山西、内蒙古、辽宁 … 台湾、香港、澳门、国外。
 *   注意这**不是拼音序** —— 数据源虽然带 pinyin 列，但它的行序是按区划代码排的
 *   （天津(12) 在 河北(13) 之前，拼音序则会得到 安徽、澳门、北京…）。
 *   这里选择随数据源，因为区划代码序正是中文用户最熟悉的省列表顺序。
 *
 * ── 数据源的"补齐填充"行：保留，未过滤 ──────────────────────────────────────
 *   数据源为了让**每一层都能选到东西**，给"直筒子市"补了一行与自己同名的县级条目
 *   （id = 上级 id + "00"）。实测 7 条：
 *     广东/东莞/东莞、广东/中山/中山、海南/儋州/儋州、甘肃/嘉峪关/嘉峪关、
 *     香港/香港/香港、澳门/澳门/澳门、国外/国外/国外
 *   它们被原样保留：若过滤掉，用户选了"东莞"市后第三级下拉框会是空的 ——
 *   而东莞下面确实没有区县，那一行正是"市即县"的表达。
 *   同理，直辖市在数据里本来就是"省=市"同名结构（北京/北京、天津/天津、
 *   上海/上海），这才让"直辖市也能选到下级"成立。
 *   另有两处上游怪癖，原样保留、不修正：重庆被拆成合成市"重庆城区"/"重庆郊县"
 *   （不是真实市名）；新疆"沙依巴克区"的短名带了"区"后缀（其余县区都是短名）。
 *
 * ── 契约 ──────────────────────────────────────────────────────────────────
 *   parseAreaData() 幂等：解析成功后重复调用直接返回。
 *   未初始化 / 输入为空 / JSON 损坏时，所有查找函数返回空数组或 undefined，**不抛错**。
 */

/** 一个县/区级命中结果。 */
export interface CountyHit {
  province: string;
  city: string;
  county: string;
  lng: number;
  lat: number;
}

/** JSON 里的一个单元格：数字、字符串，或缺失坐标时的 null。 */
type RawCell = number | string | null;

/** 内嵌 JSON 的形状（仅本模块内部使用）。 */
interface RawAreaData {
  v: string;
  src: string;
  provinces: string[];
  cities: RawCell[][];
  counties: RawCell[][];
}

/**
 * nearestCounty 的距离上限（公里）。超过它就返回 undefined，而不是硬凑一个地名。
 *
 * 取值 800 来自实测，不是拍脑袋：把中国及周边按 0.1° 网格扫一遍，
 * 国土范围内"离最近县级中心点"的最坏情况约 679 公里（内蒙古/呼伦贝尔一带，
 * 那还是国境线外侧的点）；完全落在国境线内的采样点全都 < 800 公里
 * （>600 公里的仅 12/6173 个采样点，>800 公里的 0 个）。
 * 所以 800 公里既不会误杀任何一块国土，又能挡住境外坐标：
 * 东京 → 1158 公里（判为境外），太平洋 → 2 万公里。
 * 呼伦贝尔、阿里、三沙这些地广人稀的地方仍能正常命中。
 */
export const NEAREST_MAX_KM = 800;

const DEG = Math.PI / 180;
/** 1 度纬度 ≈ 110.57 公里 */
const KM_PER_LAT = 110.57;
/** 1 度经度 ≈ 111.32 公里（再乘 cos(纬度) 收缩） */
const KM_PER_LNG = 111.32;
/** 组合键分隔符：用不可能出现在地名里的控制字符 */
const SEP = '\u0001';

// ── 模块内缓存（解析一次，之后只读） ────────────────────────────────────────
let ready: boolean = false;
let provArr: string[] = [];
let cityParent: number[] = [];
let cityName: string[] = [];
let ctyParent: number[] = [];
let ctyName: string[] = [];
let ctyLng: number[] = [];
let ctyLat: number[] = [];
let ctyHasGeo: boolean[] = [];
const provIdx: Map<string, number> = new Map<string, number>();
const cityIdx: Map<string, number> = new Map<string, number>();
const ctyIdx: Map<string, number> = new Map<string, number>();

function cityKey(provI: number, name: string): string {
  return provI + SEP + name;
}

function ctyKey(cityI: number, name: string): string {
  return cityI + SEP + name;
}

function isBlank(s: string): boolean {
  return s === undefined || s === null || s.length === 0;
}

/**
 * 解析内嵌的 JSON 文本（Node 测试传字符串；设备侧传 rawfile 读出的文本）。
 *
 * 幂等：成功解析过一次后，后续调用（含传入坏数据）直接返回，不会破坏已有状态。
 * 解析失败（空串 / 非法 JSON / 结构不符）时静默保持"未加载"，不抛错 ——
 * 调用方随后拿到的是空列表，UI 退化为"只能手选"，而不是崩溃。
 */
export function parseAreaData(text: string): void {
  if (ready) { return; }
  if (isBlank(text)) { return; }

  let raw: RawAreaData;
  try {
    raw = JSON.parse(text) as RawAreaData;
  } catch (e) {
    return;
  }
  if (raw === undefined || raw === null) { return; }

  const provs: string[] = raw.provinces;
  const cities: RawCell[][] = raw.cities;
  const counties: RawCell[][] = raw.counties;
  if (!Array.isArray(provs) || !Array.isArray(cities) || !Array.isArray(counties)) { return; }

  // 先全部构建到局部变量，成功后再一次性发布，避免留下半成品状态。
  const pArr: string[] = [];
  const pIdx: Map<string, number> = new Map<string, number>();
  for (let i = 0; i < provs.length; i++) {
    const nm: string = provs[i];
    if (typeof nm !== 'string' || nm.length === 0) { continue; }
    if (pIdx.has(nm)) { continue; }   // 同名省只认第一个
    pIdx.set(nm, pArr.length);
    pArr.push(nm);
  }

  const cPar: number[] = [];
  const cName: string[] = [];
  const cIdx: Map<string, number> = new Map<string, number>();
  for (let i = 0; i < cities.length; i++) {
    const row: RawCell[] = cities[i];
    if (!Array.isArray(row) || row.length < 2) { continue; }
    const pi: number = row[0] as number;
    const nm: string = row[1] as string;
    if (typeof pi !== 'number' || typeof nm !== 'string' || nm.length === 0) { continue; }
    if (pi < 0 || pi >= pArr.length) { continue; }   // 父省下标越界：宁缺勿错
    const key: string = cityKey(pi, nm);
    if (cIdx.has(key)) { continue; }
    cIdx.set(key, cPar.length);
    cPar.push(pi);
    cName.push(nm);
  }

  const xPar: number[] = [];
  const xName: string[] = [];
  const xLng: number[] = [];
  const xLat: number[] = [];
  const xHas: boolean[] = [];
  const xIdx: Map<string, number> = new Map<string, number>();
  for (let i = 0; i < counties.length; i++) {
    const row: RawCell[] = counties[i];
    if (!Array.isArray(row) || row.length < 4) { continue; }
    const ci: number = row[0] as number;
    const nm: string = row[1] as string;
    const lng: RawCell = row[2];
    const lat: RawCell = row[3];
    if (typeof ci !== 'number' || typeof nm !== 'string' || nm.length === 0) { continue; }
    if (ci < 0 || ci >= cPar.length) { continue; }   // 父市下标越界：宁缺勿错
    // 坐标必须成对且有限；null / 缺失 / NaN / Infinity 一律记为"无坐标"。
    const hasGeo: boolean = typeof lng === 'number' && typeof lat === 'number'
      && Number.isFinite(lng) && Number.isFinite(lat);
    const key: string = ctyKey(ci, nm);
    if (xIdx.has(key)) { continue; }
    xIdx.set(key, xPar.length);
    xPar.push(ci);
    xName.push(nm);
    xLng.push(hasGeo ? lng as number : 0);
    xLat.push(hasGeo ? lat as number : 0);
    xHas.push(hasGeo);
  }

  provArr = pArr;
  cityParent = cPar;
  cityName = cName;
  ctyParent = xPar;
  ctyName = xName;
  ctyLng = xLng;
  ctyLat = xLat;
  ctyHasGeo = xHas;
  provIdx.clear();
  cityIdx.clear();
  ctyIdx.clear();
  pIdx.forEach((v: number, k: string) => { provIdx.set(k, v); });
  cIdx.forEach((v: number, k: string) => { cityIdx.set(k, v); });
  xIdx.forEach((v: number, k: string) => { ctyIdx.set(k, v); });
  ready = true;
}

/** 省名列表（顺序 = 数据源原始顺序，见文件头说明）。返回副本，调用方改不动内部状态。 */
export function provinces(): string[] {
  if (!ready) { return []; }
  return provArr.slice();
}

/** 某省下的市名列表；省名不存在时返回空数组。 */
export function citiesOf(province: string): string[] {
  const out: string[] = [];
  if (!ready || isBlank(province)) { return out; }
  const pi: number | undefined = provIdx.get(province);
  if (pi === undefined) { return out; }
  for (let i = 0; i < cityName.length; i++) {
    if (cityParent[i] === pi) { out.push(cityName[i]); }
  }
  return out;
}

/** 某市下的县/区名列表；市名不存在时返回空数组。 */
export function countiesOf(province: string, city: string): string[] {
  const out: string[] = [];
  if (!ready || isBlank(city)) { return out; }
  const ci: number = cityIndexOf(province, city);
  if (ci < 0) { return out; }
  for (let i = 0; i < ctyName.length; i++) {
    if (ctyParent[i] === ci) { out.push(ctyName[i]); }
  }
  return out;
}

/** 取某个县的坐标；县不存在**或该县没有坐标**时返回 undefined（绝不返回 (0,0)）。 */
export function findCounty(province: string, city: string, county: string): CountyHit | undefined {
  if (!ready || isBlank(county)) { return undefined; }
  const ci: number = cityIndexOf(province, city);
  if (ci < 0) { return undefined; }
  const xi: number | undefined = ctyIdx.get(ctyKey(ci, county));
  if (xi === undefined) { return undefined; }
  if (!ctyHasGeo[xi]) { return undefined; }   // 无坐标 ≠ (0,0)，见文件头"坐标语义"
  return hitAt(xi);
}

/**
 * 坐标 → 最近的县级地名（**不要求精确边界，用最近中心点近似**）。
 * 用于"上墙时已有 GPS，顺手显示一个可读的地名"。
 *
 * 坐标系：传入的是 **WGS-84**（照片 EXIF 里的 GPS），数据里的是 **GCJ-02**。
 * 本函数**不做坐标系转换** —— 两者在中国境内偏差约 300~500 米，而这里要判的是
 * "落在哪个县"（县域 10~100 公里量级），百米偏差不会改变结论。已知偏差，够用。
 *
 * 距离度量：等距近似（equirectangular）—— 纬度差乘 110.57 km，
 * 经度差乘 111.32·cos(查询纬度) km。之所以不必上 haversine：这里只用来**比大小**
 * 挑最近的县，几千公里尺度上两者排序一致；而省掉三角函数后单次查询只是
 * 3210 次乘加，在手机上可以随手指移动实时调用。
 *
 * 距离上限：最近县仍超过 NEAREST_MAX_KM（800 km）时返回 undefined。
 * 理由见该常量的注释 —— 简言之，境外照片（如东京 1158 km）不该被打上某个
 * 中国县的名字，否则"东京的樱花"会显示成"吉林·延边·珲春"，属于误导；
 * 返回 undefined 让 UI 退化到"请用户手动选地点"，与产品的三级下拉正好衔接。
 *
 * 未初始化 / 坐标非法（NaN、Infinity）时返回 undefined，不抛错。
 */
export function nearestCounty(lng: number, lat: number): CountyHit | undefined {
  if (!ready) { return undefined; }
  if (typeof lng !== 'number' || typeof lat !== 'number') { return undefined; }
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) { return undefined; }
  if (ctyName.length === 0) { return undefined; }

  const cosLat: number = Math.cos(lat * DEG);
  let best: number = -1;
  let bestD2: number = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ctyName.length; i++) {
    if (!ctyHasGeo[i]) { continue; }
    const dx: number = (ctyLng[i] - lng) * KM_PER_LNG * cosLat;
    const dy: number = (ctyLat[i] - lat) * KM_PER_LAT;
    const d2: number = dx * dx + dy * dy;
    // 用 < 而不是 <=：等距时保留先出现的那个，结果稳定可复现。
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  if (best < 0) { return undefined; }
  if (Math.sqrt(bestD2) > NEAREST_MAX_KM) { return undefined; }
  return hitAt(best);
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

/** 省名 + 市名 → 市级下标；找不到返回 -1。 */
function cityIndexOf(province: string, city: string): number {
  if (!ready || isBlank(province) || isBlank(city)) { return -1; }
  const pi: number | undefined = provIdx.get(province);
  if (pi === undefined) { return -1; }
  const ci: number | undefined = cityIdx.get(cityKey(pi, city));
  if (ci === undefined) { return -1; }
  return ci;
}

/** 县级下标 → 命中结果。只在本模块确认过 hasGeo 之后调用。 */
function hitAt(xi: number): CountyHit {
  const cityI: number = ctyParent[xi];
  const provI: number = cityParent[cityI];
  const hit: CountyHit = {
    province: provArr[provI],
    city: cityName[cityI],
    county: ctyName[xi],
    lng: ctyLng[xi],
    lat: ctyLat[xi]
  };
  return hit;
}
