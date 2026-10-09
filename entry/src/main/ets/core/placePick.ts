/**
 * 「上墙时手选地点」的**纯逻辑**：级联选择器的数据树、选择结果解码、地点优先级判定，
 * 以及地点的**显示名**格式化（`formatPlace` —— 名字要落盘给地图墙的钉子用，见那里的说明）。
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

/** 显示名的层级分隔符：中文间隔号（U+00B7）。**只在这里定义一处**，别处不要写字面量。 */
const PLACE_SEP = '·';

/** 空名字（空串 / 纯空白；运行期拿到非字符串时也算空）不占一级。 */
function isBlankName(s: string): boolean {
  return typeof s !== 'string' || s.trim() === '';
}

/**
 * 往显示名里追加一级，但**与上一级同名时不追加**（见 formatPlace 规则 2）。
 * 比对是**字符串全等**：`吉林` 与 `吉林市` 不相等，两级都保留。
 */
function pushIfDistinct(parts: string[], name: string): void {
  if (isBlankName(name)) { return; }
  if (parts.length > 0 && parts[parts.length - 1] === name) { return; }
  parts.push(name);
}

/**
 * 这个省的名字是不是**到省为止**（= 它的第二级没有任何一个"独立的市"）。
 *
 * 返回 `true` 的有两小类，`formatPlace` 对它们一视同仁（都只输出省名）：
 *   · **直辖市**（北京/天津/上海/重庆）—— 本批要改的，用户要求"统一到直辖市"；
 *   · 特别行政区与哨兵行（香港/澳门/国外）—— 改动前就已是这个字符串，**逐字不变**。
 *
 * ── 为什么需要这个判据（三条路都走过）────────────────────────────────────────
 *   ① **硬编码 4 个名字**（`['北京','天津','上海','重庆']`）：能用，但它是把一份
 *      **可以问数据**的事实抄成了常量；数据换了（上游改名、增补）它不会报错，只会
 *      静默地不再命中，而且它无法解释"为什么偏偏是这 4 个"。
 *   ② **`city === province`**（任务书里提到的那个结构）：**漏掉重庆**。真实数据里
 *      重庆的第二级是上游合成的「重庆城区／重庆郊县」（见 areaData.ts 文件头
 *      "上游怪癖"），`city !== province`，于是重庆会得到 `重庆·重庆城区` ——
 *      正是用户要消灭的形态。所以"省==市"当判据**不够**。
 *   ③ 本函数：**"这个省的每一个市名都以省名开头"** —— 它是 ① 的语义、② 的形式，
 *      而且**能覆盖重庆**（`重庆城区`/`重庆郊县` 都以 `重庆` 开头）。
 *
 * ── 为什么"以省名开头"在这里是安全的（差点踩的坑）────────────────────────────
 *   危险的名字只有一对：**吉林 / 吉林市**（`'吉林市'` 确实以 `'吉林'` 开头）。
 *   但本判据是**全称**：要求该省**每一个**市都满足。吉林还有 长春/四平/辽源/… ——
 *   第一个就不以"吉林"开头 → 立即返回 `false` → `吉林·吉林市·永吉` 原样保留（单测钉住）。
 *   也就是说它不是"市名以省名开头就合并"，而是"**这个省压根没有自己的市**"。
 *   顺带它也扛得住"某天数据给北京补一个『北京新区』"这类变化（补进来的照样以省名开头）。
 *
 * ── 实测（真实数据 35 个省，单测**逐省**把这个集合钉死）────────────────────────
 *   返回 `true` 的恰好 **7** 个：`北京` `天津` `上海` `重庆` `香港` `澳门` `国外`。
 *   其余 28 个（含 `吉林` `海南` `新疆`）全部 `false`。
 *   东莞/中山/儋州这些"直筒子市"是**市=县**同名，由 formatPlace 规则 2 的相邻合并处理，
 *   与本判据无关 —— 用户没反对那个形态，本批不动它。
 *
 * ── 两个"必须返回 false"的退化路径（否则会把普通省误判成直辖市）──────────────
 *   · `province` 是空串/纯空白 → `false`（`hit` 三级全空时 formatPlace 仍应给空串）；
 *   · `citiesOf` 查不到这个省（**区划数据没装载**，或名字对不上）→ `false` →
 *     `formatPlace` 退回**改动前的三级行为**。也就是说"数据读不到"时不会更糟，
 *     只是直辖市又带上区名（设备侧 WallPage 在 buildScene 之前一定会先装载区划数据）。
 */
export function nameStopsAtProvince(province: string): boolean {
  if (isBlankName(province)) { return false; }
  const cs: string[] = citiesOf(province);
  if (cs.length === 0) { return false; }
  for (let i = 0; i < cs.length; i++) {
    const c: string = cs[i];
    // 前缀判断用 substring 而不是 startsWith：本仓库 core 只用最保守的 ES5 子集，
    // 免得在 ArkTS 的实现差异上多一处需要真机验证的东西。
    if (c.length < province.length || c.substring(0, province.length) !== province) { return false; }
  }
  return true;
}

/**
 * 地点的**显示名**：地图墙的钉子要写"一个人能读的地名"（例：`河北·石家庄·正定`、`上海·浦东`）。
 *
 * ── 为什么要有它、而且要把结果**落盘** ──────────────────────────────────────
 *   墙上每个钉子要显示地名，而**只有一个坐标是显示不出来的**。用 `nearestCounty(lng, lat)`
 *   反查虽然可行，但有两处代价：① 反查是**近似** —— 最近的县中心 ≠ 用户选的那个县，
 *   省界/县界附近会选错，而那正是"用户明确选过"的地方；② 反查每次要多扫一遍 2851 个县的全表。
 *   用户**明确选过**那个县，把名字直接存下来是最忠实的。本函数就是那个名字的唯一来源：
 *   写侧（`pages/SwipePage.ets` → `data/placeStore.ets`）调它，读侧（地图墙）直接用存下来的串。
 *   **不要**在选择器 UI 或别处再拼一遍 —— 两处格式必然漂移，而漂移不会报错，只会让地图上
 *   一半的钉子长一个样。
 *
 * ── 格式规则（四条，按顺序应用）─────────────────────────────────────────────
 *   0) **直辖市只到市**（本批新增，用户原话：「北京 天津 上海这种直辖市就不要具体到区了，
 *      统一到直辖市就行」）。判据是 `nameStopsAtProvince(province)`，即"这个省的
 *      第二级没有独立的市" —— 见那个函数的说明（为什么不是硬编码 4 个名字、
 *      为什么 `city === province` 不够）。产出恒为**省名本身**：
 *        `北京/北京/东城` → `北京`；`上海/上海/徐汇` → `上海`；`天津/天津/和平` → `天津`；
 *        `重庆/重庆城区/万州` → `重庆`（上游把重庆拆成"城区/郊县"两个合成市，
 *        所以重庆**不能**靠"省==市"判出来 —— 这一条是本判据存在的直接理由）。
 *      港澳与"国外"也落在这一支上，但它们改动前就是 `香港` / `澳门` / `国外`
 *      （三级同名合并），产出**逐字不变**。本规则是**产品要求覆盖结构判断**，
 *      不改变 `hasPlace` / 坐标 / 落盘字段 —— 只改显示的那个字符串。
 *   1) 层级顺序恒为 **省 · 市 · 县**，分隔符 `·`（U+00B7）。
 *   2) **相邻两级同名时只保留一个**。这一条覆盖三类真实数据（同一件事：两级说的是同一个地方，
 *      重复写一遍只是噪音，看起来还像 bug）：
 *        · 非直辖市的省=市同名（当前数据里没有，规则留着以防上游补数据），
 *          **不是** `X·X·Y` 这种形态。
 *        · "直筒子市"的补齐行：市=县同名 —— `广东/东莞/东莞` → `广东·东莞`。
 *          这是**一整类、不是孤例**：真实数据里有 37 条（东莞、中山、仙桃、潜江、天门、
 *          济源、嘉峪关，以及海南 12 个省直辖县、新疆 13 个兵团市、港澳）。
 *          用户**没有**反对这个形态，本批不动它（要动得先问）。
 *        · 港澳：省=市=县全同名 —— `香港/香港/香港` → `香港`。
 *   3) **不做任何后缀拼接**：`areaData.ts` 里的名字本身就是**短名**（`河北`、`内蒙古`、
 *      `上海`），**直接用它**。往短名上拼"省/市/自治区"必然出错（`内蒙古` → "内蒙古省"？
 *      `广西` → "广西省"？），而短名在 UI 里本来就短、干净、与系统里其它地方一致。
 *
 *   规则 2 是**字符串全等**比对，不是前缀/包含判断：`吉林` vs `吉林市`（数据里唯一一个带
 *   "市"后缀的市名）会被原样保留成两级 —— 它们是不同的名字，不是重复。所以规则 2 合并掉的
 *   那一级**仍然是县名本身**（`广东·东莞` 里的 `东莞` 就是县名）。
 *
 *   ⚠️ **规则 0 打破了"显示名里一定含县名"这条老不变量**（单测相应放宽）：
 *   直辖市现在**故意**只说 `北京`，不带 `东城`。这不是丢信息 —— 用户明确要求不看到区名。
 *
 * ── 契约 ────────────────────────────────────────────────────────────────────
 *   纯函数：不读文件、不碰模块缓存、无副作用，同一个 `hit` 恒得同一个字符串（可单测、可复现）。
 *   空名字（空串 / 纯空白）的那一级**跳过**；三级都空时返回**空串** `''`，由调用方按
 *   "没有名字"处理（`PlaceStore.setManual` 会把空串落成"没有 place 字段"，见那里的说明）。
 *   它**只产出显示名**，不回答"这条记录算不算有地点"（那是 `hasPlace`）。
 */
export function formatPlace(hit: CountyHit): string {
  // 规则 0：名字到省为止（直辖市 / 港澳 / 国外）→ 只给省名。见 nameStopsAtProvince。
  if (nameStopsAtProvince(hit.province)) { return hit.province; }
  const parts: string[] = [];
  pushIfDistinct(parts, hit.province);
  pushIfDistinct(parts, hit.city);
  pushIfDistinct(parts, hit.county);
  return parts.join(PLACE_SEP);
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
