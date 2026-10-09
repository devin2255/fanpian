/**
 * 「上墙时手选地点」的**纯逻辑**：级联选择器的数据树、选择结果解码、地点优先级判定。
 *
 * ── 为什么单独一个 core 模块（而不是塞进 areaData.ts） ──────────────────────
 *   `areaData.ts` 是**数据层**（内嵌区划 + 三级查找），本文件是**产品层**
 *   （「用户手选一个地点」这件事的规则：哪些能选、选中了什么、算不算数）。
 *   两者的变更理由完全不同：换数据源只动前者，改交互/优先级只动后者。
 *   另外 areaData.ts 已被 27 个用例锁定，本批工单**不允许改动它**；
 *   把新规则写在这里，既不动那 27 个用例的断言对象，也让新规则有自己的单测。
 *
 * ── 不 import 任何 @kit.* ──────────────────────────────────────────────────
 *   本文件只依赖 `./areaData`（纯逻辑），所以 Node 单测可以直接跑它
 *   （`node --experimental-strip-types --test core/placePick.test.ts`）。
 */
// 两个 import 而不是一个：`CountyHit` 是**类型**（接口），带值一起 import 的话
// Node 的 `--experimental-strip-types` 不认（它不做跨模块分析，不会把类型导入擦掉），
// 会报 "does not provide an export named 'CountyHit'"。生产侧（ArkTS）同样接受 `import type`。
import type { CountyHit } from './areaData.ts';
import { provinces, citiesOf, countiesOf, findCounty } from './areaData.ts';

/**
 * 三级级联选择器的一个节点（省/市/县）。
 *
 * 字段名与结构与 SDK 的 **TextCascadePickerRangeContent**
 * （`sdk/default/openharmony/ets/component/text_picker.d.ts:64`）**刻意保持一致**：
 *   - `text: string | Resource` —— 这里是 `string`，是它的子类型；
 *   - `children?: TextCascadePickerRangeContent[]` —— 这里是 `AreaPickNode[]`，结构递归相容。
 * 于是 `buildAreaTree()` 的返回值可以直接当 `TextPickerDialog` 的 `range` 用，
 * **不需要再转换一层**：少一次 3210 个对象的复制，更要紧的是「UI 看到的数据」与
 * 「单测断言的数据」是同一份，不会出现"两边各转一次、转法不一致"的偏差。
 */
export interface AreaPickNode { text: string; children?: AreaPickNode[] }

/**
 * 一棵地点树最多几级（省 → 市 → 县）。写出来是为了让下面"叶子必须是第三级"这类判断
 * 有个有名字的依据，而不是散落的魔数 3。
 */
export const AREA_TREE_DEPTH = 3;

/**
 * 构建三级级联选择器的数据树：省 → 市 → 县。
 *
 * **只保留「能被放到地图上」的县**（即 `findCounty` 能给出一条坐标的县）。
 * 理由：本功能的唯一用途是把照片挂到**地图墙**上，而内嵌数据里有 359 个县没有坐标
 *（台湾 358 个区 + 「国外」1 条，见 areaData.ts 文件头「没有坐标的县用 null 表示」）。
 * 若把这些县也列出来，用户辛苦选完三级之后 `findCounty` 拿不到坐标 → 存不进去 →
 * 照片照样上不了墙、下次再问一遍：**用户做了一次注定无效的操作**。
 * 宁可不给选，也不给一个"选了没用"的选项。
 *
 * 同一条规则顺带给出了一个类型级保证：树上**任何**叶子都能 `findCounty` 出坐标，
 * 所以调用点处理「选中」时不需要再考虑「选中了但没坐标」这一支
 *（`hitFromPick` 里那次 undefined 检查是形状防御，不是常态路径）。
 *
 * 已知代价（写进报告，不藏）：台湾各县区的照片在本选择器里**选不到**地点
 *（数据源没有这些区的坐标）。它们仍会被上墙流程判为"没有地点"，只是用户选了之后
 * 无法落点 —— 两害相权取"不要给无效选项"。
 *
 * 剪枝方向是自下而上的：县空了就剪掉市，市空了就剪掉省（保证任何一个下拉列里
 * 都不会出现"点进去是空的"的选项，那正是"随便点两下也能选出地点"的反面）。
 *
 * 未 `parseAreaData` / 数据损坏时返回 `[]`，不抛错（与 areaData 的契约一致）。
 */
export function buildAreaTree(): AreaPickNode[] {
  const out: AreaPickNode[] = [];
  const ps: string[] = provinces();
  for (let i = 0; i < ps.length; i++) {
    const p: string = ps[i];
    const cityNodes: AreaPickNode[] = [];
    const cs: string[] = citiesOf(p);
    for (let j = 0; j < cs.length; j++) {
      const c: string = cs[j];
      const countyNodes: AreaPickNode[] = [];
      const xs: string[] = countiesOf(p, c);
      for (let k = 0; k < xs.length; k++) {
        const x: string = xs[k];
        if (findCounty(p, c, x) === undefined) { continue; }   // 无坐标：给不出地点，见上
        const leaf: AreaPickNode = { text: x };
        countyNodes.push(leaf);
      }
      if (countyNodes.length === 0) { continue; }   // 整个市都没有可落点的县：市也不列
      const cityNode: AreaPickNode = { text: c, children: countyNodes };
      cityNodes.push(cityNode);
    }
    if (cityNodes.length === 0) { continue; }
    const provNode: AreaPickNode = { text: p, children: cityNodes };
    out.push(provNode);
  }
  return out;
}

/**
 * 选择器回传的「每一列选中的文本」→ `CountyHit`。
 *
 * 形状来源：`TextPickerResult.value` 是 `string | string[]`
 *（SDK `text_picker.d.ts:998`）。多列（含级联）选择器给的是**每列选中项的文本数组**，
 * 数组顺序 = 列顺序 = [省, 市, 县]。
 *
 * 任何不认识的情况一律返回 `undefined`：单列字符串（拿不到三级）、长度不是 3、
 * 名字对不上、该县没有坐标。**不猜**：猜错会把照片挂到一个用户没选过的地方，
 * 而且它以 `manual` 的身份永久压住 EXIF（见 `hasPlace` 的优先级说明），
 * 属于"合法但错误"，比直接失败严重得多。
 *
 * @param value 选择器原样回传的 value（**不做任何预处理**，形状判断全在这里，
 *              这样"什么算合法输入"只有一处定义、也只有一处被测）。
 */
export function hitFromPick(value: string | string[]): CountyHit | undefined {
  if (typeof value === 'string') { return undefined; }
  if (!Array.isArray(value)) { return undefined; }
  if (value.length !== AREA_TREE_DEPTH) { return undefined; }
  return findCounty(value[0], value[1], value[2]);
}

/**
 * 一条地点记录里与「有没有地点」有关的字段。
 *
 * 刻意用**结构类型**而不是 `data/locationIndex.ets` 的 `LocationEntry`：
 * core 不得 import `data/`（那条路径会牵进 `@kit.*`，Node 单测就跑不起来了）。
 * 结构相容是这里的**契约**：`LocationEntry` 加字段不会破坏它，删字段会编译报错。
 */
export interface PlaceFields {
  lat: number;
  lon: number;
  /**
   * true = 这个地点是**用户在自己动手选的**（省→市→县三级下拉），
   * 坐标是内嵌区划数据里的**县级中心点**（GCJ-02）。
   * 缺省/undefined = 来自照片 EXIF 的 GPS（WGS-84）。
   */
  manual?: boolean;
}

/**
 * 这张照片「有没有可用地点」。**优先级：手动 > EXIF**，规则只在这里定义一次。
 *
 * 为什么手动优先（控制器的裁决，照录并补充理由）：
 *   EXIF 的 GPS 可能飘（室内、城市峡谷、借来的相机、修图后丢失），而**用户亲手选的
 *   地点是他对这个记忆的定性** ——「这张是在**老家**拍的」是产品要的东西，
 *   不是坐标精度问题。所以只要用户选过，就永远以他选的为准：
 *   判"有没有地点"时以它为准，重建索引时也**不覆盖**它
 *  （见 `data/locationIndex.ets` 的 doBuild，那里有两道防线）。
 *
 * `manual` 为真时**不看坐标是否非零**：手选地点按构造一定带有效坐标
 *（见 `buildAreaTree` 的过滤），而"用户说过这里有地点"这件事本身就够了。
 *
 * 非 manual 的记录沿用既有约定：`(0, 0)` = 没有 GPS，**不是**几内亚湾的合法坐标
 *（见 `locationIndex.ets` 的字段注释与 `areaData.ts` 文件头第 2 条）。
 * `NaN` / `Infinity` 一律算没有 —— 它们是坏数据，不能当坐标用。
 */
export function hasPlace(f: PlaceFields | undefined): boolean {
  if (f === undefined || f === null) { return false; }
  if (f.manual === true) { return true; }
  if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) { return false; }
  return f.lat !== 0 || f.lon !== 0;
}

/** 地点来源。只用于日志与真机核验（"这条到底是用户选的还是 EXIF 读出来的"）。 */
export type PlaceSource = 'manual' | 'exif' | 'none';

/**
 * 这条地点记录**实际起作用**的来源。与 `hasPlace` 共用同一套优先级判断
 * （两条独立实现迟早会漂移，所以这里是"先问 hasPlace，再分来源"）。
 *
 * 典型用途：上墙时打一行日志说明"用了哪个来源"，真机上一眼能看出
 * 「用户手选的地点有没有真的压住 EXIF」——这是本批最需要被看见的一件事。
 */
export function placeSource(f: PlaceFields | undefined): PlaceSource {
  if (!hasPlace(f)) { return 'none'; }
  if (f !== undefined && f.manual === true) { return 'manual'; }
  return 'exif';
}
