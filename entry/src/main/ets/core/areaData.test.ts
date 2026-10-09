/**
 * areaData 单测。
 *
 * 本文件可以用 node 内建模块（它不进 ArkTS 编译图），所以直接读真实数据文件：
 *   entry/src/main/resources/rawfile/china_areas.json
 *
 * 两套实例，互不干扰 —— 模块内缓存是单例，"解析一次就不再改"，
 * 所以用小夹具做的断言必须跑在**另一个模块实例**上：
 *   · 主实例        → parseAreaData(全量真实数据)，跑规模/查找/最近县等断言
 *   · slice 实例    → parseAreaData(真实数据的一小段)，跑小夹具断言
 *     （ESM 的 query 参数 `./areaData.ts?slice=1` 会拿到新的模块记录）
 *   · fresh 实例    → 从不初始化，验证"未初始化返回空、不抛错"
 *
 * 夹具里的地名与坐标**全部摘自真实数据**，未编造。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseAreaData, provinces, citiesOf, countiesOf, findCounty, nearestCounty, NEAREST_MAX_KM
} from './areaData.ts';

const DATA_URL = new URL('../../resources/rawfile/china_areas.json', import.meta.url);
const FULL_TEXT: string = fs.readFileSync(DATA_URL, 'utf8');
const FULL_JSON = JSON.parse(FULL_TEXT);

/**
 * 真实数据的一小段：北京（直辖市，省=市同名）、湖北/武汉、台湾/台北。
 * 坐标逐字抄自 china_areas.json。
 * 台湾/台北/中正 在源数据里 geo 为 EMPTY —— 所以坐标是 null，不是 0。
 */
const FIXTURE_SLICE: string = JSON.stringify({
  v: '2025.251231.260403',
  src: 'xiangyuecn/AreaCity-JsSpider-StatsGov (MIT)',
  provinces: ['北京', '湖北', '台湾'],
  cities: [[0, '北京'], [1, '武汉'], [2, '台北']],
  counties: [
    [0, '东城', 116.4163, 39.9284],
    [0, '西城', 116.3659, 39.9126],
    [1, '江岸', 114.283, 30.6331],
    [1, '江汉', 114.2708, 30.6011],
    [2, '中正', null, null],
    [2, '大同', null, null]
  ]
});

const sliceMod = await import('./areaData.ts?slice=1');
sliceMod.parseAreaData(FIXTURE_SLICE);

const freshMod = await import('./areaData.ts?fresh=1');   // 故意不初始化

// 主实例：全量真实数据
parseAreaData(FULL_TEXT);

/** 用模块自己的 API 把三级全枚举一遍（用来数规模，顺带验证父子链没错位）。 */
function allCountiesViaModule(): string[] {
  const out: string[] = [];
  const ps: string[] = provinces();
  for (let i = 0; i < ps.length; i++) {
    const cs: string[] = citiesOf(ps[i]);
    for (let j = 0; j < cs.length; j++) {
      const xs: string[] = countiesOf(ps[i], cs[j]);
      for (let k = 0; k < xs.length; k++) { out.push(ps[i] + '/' + cs[j] + '/' + xs[k]); }
    }
  }
  return out;
}

function inChina(lng: number, lat: number): boolean {
  return lng >= 73 && lng <= 135 && lat >= 18 && lat <= 54;
}

// ══ 1. 解析与省列表 ═══════════════════════════════════════════════════════

test('parseAreaData 后 provinces() 长度合理（>30），且含北京/湖北/台湾/香港/澳门', () => {
  const ps = provinces();
  assert.ok(ps.length > 30, `省数 ${ps.length} 应 > 30`);
  for (const nm of ['北京', '湖北', '台湾', '香港', '澳门']) {
    assert.ok(ps.includes(nm), `缺少省 ${nm}`);
  }
});

test('provinces() 总数与源数据一致（35 个，含数据源自带的「国外」伪省）', () => {
  assert.equal(provinces().length, 35);
  assert.equal(provinces().length, FULL_JSON.provinces.length);
  assert.ok(provinces().includes('国外'));
});

// ══ 2. 直辖市的下一级 ═════════════════════════════════════════════════════

test('citiesOf(北京) 非空 —— 直辖市也能选到下级', () => {
  const cs = citiesOf('北京');
  assert.deepEqual(cs, ['北京']);
});

test('countiesOf(北京, 北京) 取到 16 个区，含东城/西城/朝阳', () => {
  const xs = countiesOf('北京', '北京');
  assert.equal(xs.length, 16);
  for (const nm of ['东城', '西城', '朝阳']) { assert.ok(xs.includes(nm), `缺少 ${nm}`); }
});

// ══ 3. 湖北 / 武汉 ════════════════════════════════════════════════════════

test('countiesOf(湖北, 武汉) 非空（13 个区）', () => {
  const xs = countiesOf('湖北', '武汉');
  assert.equal(xs.length, 13);
  assert.ok(xs.includes('江岸'));
});

test('countiesOf 对不存在的市返回 []', () => {
  assert.deepEqual(countiesOf('湖北', '不存在'), []);
});

test('citiesOf 对不存在的省返回 []', () => {
  assert.deepEqual(citiesOf('不存在省'), []);
});

// ══ 4~6. findCounty ═══════════════════════════════════════════════════════

test('findCounty 命中：湖北/武汉/江岸 坐标非 null 且落在中国范围内', () => {
  const hit = findCounty('湖北', '武汉', '江岸');
  assert.ok(hit !== undefined, '应命中 江岸');
  assert.equal(hit.province, '湖北');
  assert.equal(hit.city, '武汉');
  assert.equal(hit.county, '江岸');
  assert.ok(inChina(hit.lng, hit.lat), `坐标越界 ${hit.lng},${hit.lat}`);
});

test('findCounty 坐标逐字来自数据源（北京/北京/东城 = 116.4163, 39.9284）', () => {
  const hit = findCounty('北京', '北京', '东城');
  assert.ok(hit !== undefined);
  assert.equal(hit.lng, 116.4163);
  assert.equal(hit.lat, 39.9284);
});

test('findCounty 未命中（省/市/县三级各错一个）→ undefined', () => {
  assert.equal(findCounty('不存在省', '武汉', '江岸'), undefined);
  assert.equal(findCounty('湖北', '不存在市', '江岸'), undefined);
  assert.equal(findCounty('湖北', '武汉', '不存在县'), undefined);
});

/**
 * 无坐标的县：源数据 geo 为 EMPTY 时，合并脚本写入 null 而不是 0。
 * 本模块的选择是 —— **findCounty 返回 undefined**，理由：
 *   1. CountyHit 的 lng/lat 是 number（非可空），硬返回就必须编一个数；
 *      填入 (0,0) 会得到一个"合法但错误"的几内亚湾坐标，上墙后照片会飞到非洲。
 *   2. 调用方拿到 undefined 可以明确退化到"请用户手动选地点"，与产品需求一致。
 * 但**地名本身要保留**：countiesOf 仍然列出它，用户照样能在下拉框里选到台湾的区
 * —— 只是选完没有坐标可用（UI 需自行处理这一档）。
 */
test('无坐标的县：countiesOf 仍列出，但 findCounty 返回 undefined（不用 0 顶替）', () => {
  const xs = countiesOf('台湾', '台北');
  assert.ok(xs.includes('中正'), '无坐标的县仍应出现在下拉列表里');
  assert.equal(findCounty('台湾', '台北', '中正'), undefined);
});

// ══ 7~8. nearestCounty ════════════════════════════════════════════════════

test('nearestCounty(116.407, 39.904)（北京）命中北京某区', () => {
  const hit = nearestCounty(116.407, 39.904);
  assert.ok(hit !== undefined, '应命中');
  assert.equal(hit.province, '北京');
  assert.equal(hit.county, '东城');
});

test('nearestCounty(114.305, 30.593)（武汉）命中湖北/武汉某区', () => {
  const hit = nearestCounty(114.305, 30.593);
  assert.ok(hit !== undefined);
  assert.equal(hit.province, '湖北');
  assert.equal(hit.city, '武汉');
  assert.equal(hit.county, '江汉');
});

test('nearestCounty 在国土内即使离中心点很远也能命中（额济纳旗 292km / 三沙 416km）', () => {
  const ejn = nearestCounty(104.4, 42.9);
  assert.ok(ejn !== undefined, '国土内的点不该被距离上限误杀');
  assert.equal(ejn.province, '内蒙古');
  assert.equal(ejn.county, '额济纳旗');

  const nh = nearestCounty(110, 12);   // 南沙群岛海域 —— 中国领土
  assert.ok(nh !== undefined, '南海点不该被距离上限误杀');
  assert.equal(nh.province, '海南');
  assert.equal(nh.city, '三沙');
});

/**
 * 距离上限的语义选择：**超过 NEAREST_MAX_KM(800km) 返回 undefined**。
 * 见 areaData.ts 里该常量的注释；核心是"境外照片不该被打上某个中国县的名字"。
 * （任务书允许两种语义，这里选了带上限的一种并给出实测依据。）
 */
test('nearestCounty 对太平洋中间的坐标 → undefined（超 800km 上限）', () => {
  assert.equal(nearestCounty(-150, 30), undefined);
  assert.equal(nearestCounty(0, 0), undefined);          // 几内亚湾
});

test('nearestCounty 对境外城市 → undefined（东京最近的县在珲春，1158km）', () => {
  const far = nearestCounty(139.69, 35.68);
  assert.equal(far, undefined);
  assert.ok(NEAREST_MAX_KM > 679, '上限必须大于国土内实测最坏值 ~679km，否则会误杀');
});

test('nearestCounty 对非法坐标返回 undefined，不抛错', () => {
  assert.equal(nearestCounty(Number.NaN, 39.9), undefined);
  assert.equal(nearestCounty(116.4, Number.NaN), undefined);
  assert.equal(nearestCounty(Number.POSITIVE_INFINITY, 39.9), undefined);
});

// ══ 9~10. 幂等与顺序稳定 ══════════════════════════════════════════════════

test('重复 parseAreaData 不会破坏状态（幂等）—— 含坏数据/空串', () => {
  const before = provinces();
  const beforeCount = allCountiesViaModule().length;

  parseAreaData(FULL_TEXT);              // 同一份数据再来一次
  parseAreaData(FIXTURE_SLICE);          // 拿一小段来"重放"，也不该生效
  parseAreaData('');                     // 空串
  parseAreaData('{ 这不是 JSON');         // 非法 JSON
  parseAreaData('{"provinces":42}');     // 结构不符
  parseAreaData('null');                 // 字面量 null

  assert.deepEqual(provinces(), before);
  assert.equal(allCountiesViaModule().length, beforeCount);
  assert.equal(findCounty('湖北', '武汉', '江岸') !== undefined, true);
});

test('provinces() 顺序稳定：两次调用结果完全相同', () => {
  assert.deepEqual(provinces(), provinces());
  assert.equal(provinces()[0], '北京');
});

test('provinces() 返回的是副本，改它不影响内部状态', () => {
  const a = provinces();
  assert.ok(a.length > 0);
  const first = a[0];
  a[0] = '被改坏了';
  a.push('多余项');
  assert.equal(provinces()[0], first);
  assert.equal(provinces().length, a.length - 1);
});

// ══ 11. 数据规模 ══════════════════════════════════════════════════════════

test('数据规模在合理区间（县 2000~3500 / 市 300~500），且与 JSON 文件逐项一致', () => {
  const viaModule = allCountiesViaModule();
  assert.ok(viaModule.length >= 2000 && viaModule.length <= 3500,
    `县级条目 ${viaModule.length} 越界，数据可能被截断或合并出错`);
  assert.equal(viaModule.length, FULL_JSON.counties.length);

  let cityTotal = 0;
  const ps = provinces();
  for (let i = 0; i < ps.length; i++) { cityTotal += citiesOf(ps[i]).length; }
  assert.ok(cityTotal >= 300 && cityTotal <= 500, `市级条目 ${cityTotal} 越界`);
  assert.equal(cityTotal, FULL_JSON.cities.length);

  // 父子链没错位：枚举出来的三级路径没有空段
  for (const p of viaModule) {
    const seg = p.split('/');
    assert.equal(seg.length, 3);
    assert.ok(seg[0].length > 0 && seg[1].length > 0 && seg[2].length > 0, `空段：${p}`);
  }
});

// ══ 小夹具实例（真实数据的一小段） ════════════════════════════════════════

test('夹具：解析一小段真实数据后，省/市/县三级都能查到', () => {
  assert.deepEqual(sliceMod.provinces(), ['北京', '湖北', '台湾']);
  assert.deepEqual(sliceMod.citiesOf('湖北'), ['武汉']);
  assert.deepEqual(sliceMod.countiesOf('湖北', '武汉'), ['江岸', '江汉']);
});

test('夹具：直辖市北京也能选到下级，且坐标来自夹具', () => {
  assert.deepEqual(sliceMod.citiesOf('北京'), ['北京']);
  assert.deepEqual(sliceMod.countiesOf('北京', '北京'), ['东城', '西城']);
  const hit = sliceMod.findCounty('北京', '北京', '东城');
  assert.ok(hit !== undefined);
  assert.equal(hit.lng, 116.4163);
  assert.equal(hit.lat, 39.9284);
});

test('夹具：无坐标（null）的县 findCounty → undefined，但地名仍在列表里', () => {
  assert.deepEqual(sliceMod.countiesOf('台湾', '台北'), ['中正', '大同']);
  assert.equal(sliceMod.findCounty('台湾', '台北', '中正'), undefined);
});

test('夹具：nearestCounty 命中夹具里的最近县', () => {
  const hit = sliceMod.nearestCounty(114.28, 30.63);
  assert.ok(hit !== undefined);
  assert.equal(hit.city, '武汉');
  assert.equal(hit.county, '江岸');
});

// ══ 未初始化 ══════════════════════════════════════════════════════════════

test('未初始化时所有函数返回空数组/undefined，不抛错', () => {
  assert.deepEqual(freshMod.provinces(), []);
  assert.deepEqual(freshMod.citiesOf('北京'), []);
  assert.deepEqual(freshMod.countiesOf('北京', '北京'), []);
  assert.equal(freshMod.findCounty('北京', '北京', '东城'), undefined);
  assert.equal(freshMod.nearestCounty(116.407, 39.904), undefined);
});

test('空字符串 / 非法 JSON 不会让实例进入已加载状态', async () => {
  const m = await import('./areaData.ts?bad=1');
  m.parseAreaData('');
  m.parseAreaData('不是 JSON');
  m.parseAreaData('[]');
  assert.deepEqual(m.provinces(), []);
  assert.equal(m.nearestCounty(116.4, 39.9), undefined);
});
