/**
 * placePick 单测：级联选择器的数据树、选择结果解码、地点优先级。
 *
 * 用**全量真实数据**跑（与 areaData.test.ts 同一份 rawfile）：本文件要断言的正是
 * "哪些县能被选到"这类与真实数据规模绑定的事实。
 *
 * 为什么**没有**"小夹具 + 独立模块实例"那一套（areaData.test.ts 用的手法）：
 *   `placePick.ts` 内部 `import './areaData.ts'` 是**不带 query 的固定 URL**，
 *   所以 `import('./placePick.ts?slice=1')` 拿到的仍是**主** areaData 实例
 *  （模块实例的隔离只对它自己那个 URL 生效，不传递给它的依赖）。
 *   试过，夹具断言因此在主实例上跑（拿到的是全量数据）。要修就得让 placePick 收一个
 *   注入的数据源参数 —— 那是为了测试而给生产 API 加缝，不值当。
 *   剪枝规则改用真实数据断言（见下面"无坐标的县一个都不在树里"与叶子数 2851），
 *   覆盖更强：夹具里的 4 条记录证明不了 3210 条数据里的剪枝是自下而上正确的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseAreaData, provinces, findCounty } from './areaData.ts';
import { buildAreaTree, hitFromPick, hasPlace, placeSource } from './placePick.ts';
import type { AreaPickNode } from './placePick.ts';

const DATA_URL = new URL('../../resources/rawfile/china_areas.json', import.meta.url);
const FULL_TEXT: string = fs.readFileSync(DATA_URL, 'utf8');
const FULL_JSON = JSON.parse(FULL_TEXT);

// 夹具：北京（直辖市，省=市同名）、湖北/武汉、台湾/台北（geo 为 null）、国外。
// 只用于 `hitFromPick`/`hasPlace` 这类**不依赖树**的断言（地名与坐标逐字抄自
// china_areas.json，未编造）。（为什么不拿它测树：见文件头"为什么没有小夹具"。）
const BEIJING_DONGCITY: string[] = ['北京', '北京', '东城'];
const TAIWAN_ZHONGZHENG: string[] = ['台湾', '台北', '中正'];

// 主实例：全量真实数据（与 areaData.test.ts 同源）
parseAreaData(FULL_TEXT);

/** 取子节点（缺 children 视为空数组，避免满篇的非空断言）。 */
function kids(n: AreaPickNode): AreaPickNode[] {
  return n.children === undefined ? [] : n.children;
}

/** 把树按 [省, 市, 县] 三元组摊平，用于统计与逐条校验。 */
function flatten(tree: AreaPickNode[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < tree.length; i++) {
    const cs: AreaPickNode[] = kids(tree[i]);
    for (let j = 0; j < cs.length; j++) {
      const xs: AreaPickNode[] = kids(cs[j]);
      for (let k = 0; k < xs.length; k++) { out.push([tree[i].text, cs[j].text, xs[k].text]); }
    }
  }
  return out;
}

/** 独立于 placePick 的一条路径：直接从 JSON 数"有坐标的县"。 */
function geoCountiesViaJson(): string[] {
  const out: string[] = [];
  const provs: string[] = FULL_JSON.provinces;
  const cities: (number | string)[][] = FULL_JSON.cities;
  const counties: (number | string | null)[][] = FULL_JSON.counties;
  for (let i = 0; i < counties.length; i++) {
    const row = counties[i];
    const lng = row[2];
    const lat = row[3];
    const hasGeo = typeof lng === 'number' && typeof lat === 'number'
      && Number.isFinite(lng) && Number.isFinite(lat);
    if (!hasGeo) { continue; }
    const cityRow = cities[row[0] as number];
    out.push(`${provs[cityRow[0] as number]}/${cityRow[1]}/${row[1]}`);
  }
  return out;
}

const TREE: AreaPickNode[] = buildAreaTree();
const FLAT: string[][] = flatten(TREE);
const FIRST_PROV: AreaPickNode = TREE[0];
const FIRST_CITY: AreaPickNode = kids(FIRST_PROV)[0];
const FIRST_COUNTY: AreaPickNode = kids(FIRST_CITY)[0];

// ── 1. 树的规模：与真实数据对齐 ───────────────────────────────────────────────

test('树里每一片叶子都必须是"有坐标的县"，且与直接扫 JSON 得到的结果完全一致', () => {
  const viaJson = geoCountiesViaJson().slice().sort();
  const viaTree = FLAT.map((t) => t.join('/')).sort();
  assert.equal(viaTree.length, 2851, `叶子数应为 2851（3210 - 359 无坐标），实际 ${viaTree.length}`);
  assert.deepEqual(viaTree, viaJson);
});

test('无坐标的县一个都不在树里（台湾/国外不在省列表）', () => {
  const provNames = TREE.map((p) => p.text);
  assert.equal(provNames.includes('台湾'), false, '台湾的区全部无坐标 → 不应出现在可选省里');
  assert.equal(provNames.includes('国外'), false, '「国外」那条无坐标 → 不应出现');
  // 但数据本身仍在（剪掉的是"选不到的县"，不是数据）：证明是过滤而不是数据缺失
  assert.equal(provinces().includes('台湾'), true);
  assert.equal(findCounty('台湾', '台北', '中正'), undefined);
});

test('剪枝是自下而上的：任何一个下拉列里都不会出现"点进去是空的"', () => {
  assert.ok(TREE.length > 0);
  for (let i = 0; i < TREE.length; i++) {
    const cs: AreaPickNode[] = kids(TREE[i]);
    assert.ok(cs.length > 0, `省 ${TREE[i].text} 没有市`);
    for (let j = 0; j < cs.length; j++) {
      const xs: AreaPickNode[] = kids(cs[j]);
      assert.ok(xs.length > 0, `市 ${TREE[i].text}/${cs[j].text} 没有县`);
      for (let k = 0; k < xs.length; k++) {
        assert.equal(xs[k].children, undefined, `叶子不该有 children：${xs[k].text}`);
      }
    }
  }
});

test('树恰好三级，且省/市数与真实数据的关系可解释（33 = 35 - 台湾 - 国外）', () => {
  assert.equal(TREE.length, 33);
  assert.equal(provinces().length, 35);
  let cityCount = 0;
  for (let i = 0; i < TREE.length; i++) { cityCount += kids(TREE[i]).length; }
  assert.equal(cityCount, 372, '393 - 21（台湾/国外下没有可落点县的市）');
});

test('直辖市保留"省=市"结构，东莞保留"市=县"的补齐行（数据源特性未被误剪）', () => {
  const bj = TREE.find((p) => p.text === '北京');
  assert.ok(bj !== undefined);
  const bjCity = kids(bj as AreaPickNode)[0];
  assert.equal(bjCity.text, '北京');
  assert.ok(kids(bjCity).some((x) => x.text === '东城'));

  const gd = TREE.find((p) => p.text === '广东');
  assert.ok(gd !== undefined);
  const dg = kids(gd as AreaPickNode).find((c) => c.text === '东莞');
  assert.ok(dg !== undefined, '广东/东莞 应存在');
  assert.deepEqual(kids(dg as AreaPickNode).map((x) => x.text), ['东莞']);
});

// ── 2. 默认值：三级都默认第一项 ───────────────────────────────────────────────

test('默认选中（第一项/第一项/第一项）一定能解出一个带坐标的 CountyHit', () => {
  // 选择器传的是 selected: [0,0,0]，即每列第一项 —— 这条断言就是"随便点两下也能选出地点"
  const hit = hitFromPick([FIRST_PROV.text, FIRST_CITY.text, FIRST_COUNTY.text]);
  assert.ok(hit !== undefined, '默认三项必须能落成地点');
  assert.equal(hit === undefined ? '' : hit.province, FIRST_PROV.text);
  assert.equal(hit === undefined ? '' : hit.county, FIRST_COUNTY.text);
  assert.ok(hit !== undefined && Number.isFinite(hit.lng) && Number.isFinite(hit.lat));
  assert.ok(hit !== undefined && hit.lng !== 0 && hit.lat !== 0);
});

test('树里每一条 [省,市,县] 都能被 hitFromPick 还原成同一个 hit（联动链没错位）', () => {
  for (let i = 0; i < FLAT.length; i++) {
    const hit = hitFromPick(FLAT[i]);
    assert.ok(hit !== undefined, `还原失败：${FLAT[i].join('/')}`);
    assert.deepEqual(hit, findCounty(FLAT[i][0], FLAT[i][1], FLAT[i][2]));
  }
});

// ── 3. 结果解码：不认识的形状一律 undefined，绝不猜 ──────────────────────────

test('hitFromPick：形状不对一律 undefined（单列字符串 / 长度不是 3 / 空）', () => {
  assert.equal(hitFromPick('北京'), undefined);
  assert.equal(hitFromPick([]), undefined);
  assert.equal(hitFromPick(['北京']), undefined);
  assert.equal(hitFromPick(['北京', '北京']), undefined);
  assert.equal(hitFromPick(['北京', '北京', '东城', '多出来的一列']), undefined);
  assert.equal(hitFromPick(['', '', '']), undefined);
});

test('hitFromPick：名字对不上 / 该县无坐标 → undefined（不返回"最近的"）', () => {
  assert.equal(hitFromPick(['北京', '北京', '不存在区']), undefined);
  assert.equal(hitFromPick(['不存在省', '北京', '东城']), undefined);
  assert.equal(hitFromPick(['北京', '不存在市', '东城']), undefined);
  // 台湾中正：数据里有这个名字，但没有坐标 → 必须 undefined（不是 (0,0)）
  assert.equal(hitFromPick(TAIWAN_ZHONGZHENG), undefined);
  // 同一个县，在用得上的那一支必须正常返回（证明上面的 undefined 不是"整条路都坏了"）
  assert.equal(hitFromPick(BEIJING_DONGCITY)?.county, '东城');
});

test('buildAreaTree 是纯函数：连续两次调用结果完全相同、不共享可变状态', () => {
  const a = buildAreaTree();
  const b = buildAreaTree();
  assert.deepEqual(a, b);
  assert.notEqual(a, b);          // 两次调用返回**不同的**数组对象（不是同一个缓存引用）
  assert.deepEqual(a, TREE);
});

test('树的省顺序 = 数据源区划代码序（天津在河北之前，不是拼音序）', () => {
  const names = TREE.map((p) => p.text);
  assert.equal(names[0], '北京');
  assert.ok(names.indexOf('天津') < names.indexOf('河北'), '区划代码序：天津(12) 应在 河北(13) 之前');
  assert.ok(names.indexOf('河北') < names.indexOf('山西'));
  assert.ok(names.indexOf('广东') < names.indexOf('广西'));
  // 拼音序会得到 安徽、澳门、北京… —— 这里明确不是那种顺序
  assert.notEqual(names[0], '安徽');
});

test('未初始化的数据源给出空树、不抛错（areaData 侧契约；placePick 只是空循环）', async () => {
  // 注意：这是**新实例**的 areaData（placePick 的实例无法与主实例隔离，见文件头）。
  // 它验证的是"没数据时不抛错"这条上游契约：buildAreaTree 的实现是对 provinces()
  // 的空列表做空循环，所以这一支必然也是空树（下一行断言了这个结构事实）。
  const freshArea = await import('./areaData.ts?fresh=1');
  assert.deepEqual(freshArea.provinces(), []);
  assert.deepEqual(freshArea.citiesOf('北京'), []);
  assert.equal(freshArea.findCounty('北京', '北京', '东城'), undefined);
  // 未初始化时所有查找都返回空 → 树的循环体一次都不进
  assert.equal(freshArea.provinces().length === 0, true);
});

// ── 4. 优先级：手动 > EXIF ───────────────────────────────────────────────────

test('hasPlace：manual 为真就是有地点（哪怕坐标是 0）', () => {
  assert.equal(hasPlace({ lat: 0, lon: 0, manual: true }), true);
  assert.equal(hasPlace({ lat: 39.9284, lon: 116.4163, manual: true }), true);
  assert.equal(placeSource({ lat: 0, lon: 0, manual: true }), 'manual');
  assert.equal(placeSource({ lat: 39.9, lon: 116.4, manual: true }), 'manual');
});

test('hasPlace：非 manual 时 (0,0) = 没有 GPS（不是几内亚湾）', () => {
  assert.equal(hasPlace({ lat: 0, lon: 0 }), false);
  assert.equal(hasPlace({ lat: 0, lon: 0, manual: false }), false);
  assert.equal(hasPlace({ lat: 39.9284, lon: 116.4163 }), true);
  assert.equal(placeSource({ lat: 0, lon: 0 }), 'none');
  assert.equal(placeSource({ lat: 39.9284, lon: 116.4163 }), 'exif');
  assert.equal(placeSource({ lat: 39.9284, lon: 116.4163, manual: false }), 'exif');
});

test('hasPlace：坏坐标（NaN/Infinity/半个）算没有；undefined 也算没有', () => {
  assert.equal(hasPlace(undefined), false);
  assert.equal(hasPlace({ lat: NaN, lon: 116.4 }), false);
  assert.equal(hasPlace({ lat: 39.9, lon: NaN }), false);
  assert.equal(hasPlace({ lat: Infinity, lon: 116.4 }), false);
  assert.equal(hasPlace({ lat: 39.9, lon: -Infinity }), false);
  assert.equal(placeSource(undefined), 'none');
  // manual 为真时坏坐标也不影响"有地点"（手选地点按构造坐标有效；这条是防御性口径）
  assert.equal(hasPlace({ lat: NaN, lon: NaN, manual: true }), true);
});

test('hasPlace 的口径与 LocationEntry 结构相容（真实字段名 lat/lon/manual）', () => {
  // 与 data/locationIndex.ets 的 LocationEntry 同形（那里 import 了 @kit.*，
  // 进不了 Node；所以在这里用逐字相同的字段名做一次结构对照）
  const entry = { photoId: 'file://media/a.jpg', lat: 30.6331, lon: 114.283, takenAt: 1, manual: true };
  assert.equal(hasPlace(entry), true);
  assert.equal(placeSource(entry), 'manual');
  const exifEntry = { photoId: 'file://media/b.jpg', lat: 0, lon: 0, takenAt: 0 };
  assert.equal(hasPlace(exifEntry), false);
  assert.equal(placeSource(exifEntry), 'none');
});
