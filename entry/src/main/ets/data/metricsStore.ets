/**
 * 指标落盘：`files/metrics.json` —— 刷卡事件窗口 + 「已淘汰条数」。
 *
 * 为什么需要它（本文件存在的唯一理由）：
 *   spec §5.3 的三条验收指标（决策间隔中位数 / 回弹率 / 上墙转化率）原本只在内存里，
 *   App 一退就没了 —— 于是指标**只能当场看**，无法从历史数据算，也就无法在验收时复现。
 *   落盘之后它们变成可复核的历史读数（「使用统计」页 pages/StatsPage.ets 读的就是本文件）。
 *
 * 存储层的写法**与另外四个 store 共用同一份原子写**（`data/atomicWrite.ets` 的 `writeTextAtomic`，
 * 纯逻辑在 `core/atomicText.ts`，有 Node 单测）。下面五条约定逐条对齐，其中 1)、2) 已交给那份实现：
 *   1) **原子写**：先写 `metrics.json.tmp`，再 rename 覆盖真身 ——
 *      `.tmp` 路径由 `core/atomicText.ts` 的 `tmpPathOf` 统一推导（真身 + `.tmp`），
 *      与本文件原先手拼的 `${filesDir}/metrics.json.tmp` **逐字相同**；
 *   2) **短写检测**：按 **UTF-8 字节数**（不是 `payload.length`）比对写入量
 *      —— photoId 是 file:// media URI，真机上可能含非 ASCII（中文相册名/文件名），两者会不等；
 *      检出短写就**不放行** rename，于是**绝不拿截断的 .tmp 覆盖一份好数据**；
 *      （本文件原先自己实现了这一条，迁移后由 `writeTextAtomic` 承担，逐项差异见 save() 的说明。）
 *   3) **短读检测**：校验 `readSync` 的返回值，并且只解码**实际读到的字节**
 *      —— 否则 buf 尾部是 NUL 填充，JSON.parse 失败后会静默退化成空状态（伪装成"没保存"）；
 *   4) **UTF-8 解码**：`buffer.from(bytes).toString('utf-8')`，**禁止**逐字节 String.fromCharCode 拼串
 *      （本项目为此栽过 4 次，见 Ruling 24）；
 *   5) **形状校验**：读回来的 JSON 逐条校验结构，坏了就退回空状态（**不抛**）。
 *      逐条校验本身在 `core/metrics.ts` 的 `decodeEvents`（纯函数，跑在 node 单测里），
 *      本文件只负责"顶层形状 + IO" —— 校验规则因此有一份可被单测钉住的实现。
 *
 * 为什么把 1)、2) 交出去（而不是留着这份"本来就是对的"实现）：
 *   本项目原子写缺陷族（claimStore 的旧 save 没有 `.tmp`；decisionStore / sessionStore 的旧 save
 *   有 `.tmp` 却丢弃 `writeSync` 的返回值）的成因**都不是逻辑写错，而是同一件事写了两遍、只改了一遍**。
 *   留着第二份正确实现 = 把同一个坑再挖一次。迁移后全仓库的 rename 与平台写盘调用
 *   只出现在 `data/atomicWrite.ets` 一处，并由 `core/storeWiring.test.ts` 的接线守卫钉住
 *   （它现在把本文件也算在"必须接线"的 store 列表里）。
 *
 * 与另外三个 store 的**刻意差异**（两条，都是本文件独有的）：
 *   · `load()` 返回**两样东西**：事件窗口 + 累计淘汰条数。淘汰条数必须一起读出来，
 *     否则页面无法说明"这份读数是滚动窗口"（见 core/metrics.ts 的 MAX_METRIC_EVENTS）；
 *   · `load()` 内部会再裁一次容量（`capEvents`）。理由：文件可能被手工改大，
 *     而读进来之后每刷一张卡都要对整个数组排序求中位数 —— 不裁就等于把这个代价交给热路径。
 *
 * 读写权限（谁写谁读）：
 *   · **写**：只有 pages/SwipePage.ets 一处（内存是权威副本 + 1 秒节流全量写，与 decisions.json 同款）；
 *   · **读**：SwipePage（启动时把历史读进内存，否则首次全量写会抹掉历史）与
 *     pages/StatsPage.ets（只读快照，页面本身绝不写）。
 */
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { buffer } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import {
  SwipeEvent, MetricsState, emptyMetrics, capEvents, decodeEvents, MetricsCap, EventsDecode,
  MAX_METRIC_EVENTS
} from '../core/metrics';
import { writeTextAtomic } from './atomicWrite';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

/** 把 catch 到的值转成一行可打印文本（与 data/locationIndex.ets 的 errText 同款口径）。 */
function errText(e: Object): string {
  if (e instanceof Error) { return e.message; }
  return JSON.stringify(e);
}

// 路径与 core/claim.ts 的 claimStorePath 同风格（本文件私有：路径拼接是 IO 语义的一部分，
// core/ 保持无 IO）。
function metricsStorePath(filesDir: string): string {
  return `${filesDir}/metrics.json`;
}

// 原先这里还有一个私有的 tmpPathOf(filesDir)（手拼 `${filesDir}/metrics.json.tmp`）。
// 迁移到 writeTextAtomic 后由 core/atomicText.ts 的 tmpPathOf 统一推导（真身 + '.tmp'），
// 两者对同一路径**逐字相同**，于是删掉本地这一份 —— 路径拼接只留一处，才不会出现
// "写了 .tmp 却 rename 另一个名字"。

/**
 * metrics.json 的落盘形状。
 *
 * 为什么是对象而不是裸数组（seen.json 的 v1 就是裸数组，吃了亏）：这里有两样东西要存
 * —— 事件窗口与"已淘汰条数"。淘汰条数是**解释读数**所必需的（它是"这份统计覆盖了多少历史"
 * 的答案），不能丢；而把它塞进事件数组里就得给每条事件加个重复字段。
 *
 * 兼容性：本文件是本批**新增**的，盘上不存在旧版本的 metrics.json，所以没有"旧形状"要认。
 * 但读侧仍然接受**裸数组**（当成 `dropped = 0` 的事件表）—— 那是任何人手工写这个文件时
 * 最自然的形状，接住它比让整份统计静默归零更符合"坏数据要能读回来一部分"的取向。
 * 注意区分：**顶层形状不认识**（既不是数组也没有合法的 events 数组）才走"按空状态处理"的告警路径。
 */
interface MetricsFile {
  events: SwipeEvent[];
  dropped: number;
}

/** load() 的结果：事件窗口 + 累计淘汰条数（两者必须**一起**读出来，理由见文件头） */
export interface MetricsLoad {
  state: MetricsState;
  dropped: number;
}

export class MetricsStore {
  private ctx: common.UIAbilityContext;

  constructor(ctx: common.UIAbilityContext) { this.ctx = ctx; }

  /**
   * 读盘。**首次运行（文件不存在）是正常路径**：静默返回空状态、dropped = 0，
   * 一句日志都不打（用 statSync 成功与否区分"文件不存在"与"文件在但读不出来"）。
   * 后者（读取/解析失败、顶层形状不认识）才告警，并且一律**退回空状态、绝不抛**：
   * 调用点在页面构建路径上，抛错会让整页白屏。
   *
   * 空状态是**安全**的降级方向：`eventCount === 0` 会让三条指标都显示"还没有数据"，
   * 而不是显示 0 然后看起来达标（见 core/metrics.ts 的 verdictText）。
   * 用户想重置统计也可以直接删掉这个文件 —— 走的就是这条"首次运行"路径。
   */
  load(): MetricsLoad {
    const path = metricsStorePath(this.ctx.filesDir);
    // 两次 statSync 是刻意的（同 decisionStore）：第一次只回答「文件在不在」。
    let exists = false;
    try {
      fileIo.statSync(path);
      exists = true;
    } catch (e) {
      exists = false;
    }
    if (!exists) { return { state: emptyMetrics(), dropped: 0 }; }

    try {
      const st = fileIo.statSync(path);
      const buf = new ArrayBuffer(st.size);
      const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      let n: number = 0;
      try {
        n = fileIo.readSync(file.fd, buf);
      } finally {
        fileIo.closeSync(file);
      }
      // readSync 声明返回「实际读取字节数」；越界值只可能来自 SDK 违约，属于真异常。
      if (n < 0 || n > st.size) { throw new Error('readSync 返回值异常'); }
      // 只解码实际读到的字节：若文件在 stat 与 read 之间变小（短读），buf 尾部是 NUL 填充，
      // 整段解码会让 JSON.parse 失败并静默退化为空状态（= 指标全丢，伪装成"没记录过"）。
      const bytes: Uint8Array = new Uint8Array(buf, 0, n);
      // save() 写的是 UTF-8，必须按 UTF-8 解码；按字节拼串等价于 Latin-1，
      // 会把非 ASCII 的 photoId 解成 mojibake 继而在 JSON.parse 处整体失败（Ruling 24）。
      const text: string = buffer.from(bytes).toString('utf-8');
      // 先当 Object 接住，再按形状下行转型（与 data/sessionStore.ets 同一写法：
      // 裸数组与对象两种顶层形状互不相关，直接 as 会被 ArkTS 拒绝）。
      const raw: Object = JSON.parse(text) as Object;
      let rawEvents: SwipeEvent[] = [];
      let rawDropped: number = 0;
      if (Array.isArray(raw)) {
        // 手工写的裸数组：不是异常，是"只有事件"的可理解形状 → dropped 视为 0
        rawEvents = raw as SwipeEvent[];
      } else {
        const asFile: MetricsFile = raw as MetricsFile;
        if (!Array.isArray(asFile.events)) {
          // 事件表是全部指标的输入：读不出来就不能假装有（静默返回空 = 三条指标都显示"还没有数据"）。
          hilog.warn(DOMAIN, TAG, '%{public}s',
            `metrics.json 的 events 不是数组（实际是 ${typeof asFile.events}），已按空状态处理`);
          return { state: emptyMetrics(), dropped: 0 };
        }
        rawEvents = asFile.events;
        // dropped 非有限数/负数一律当 0：它只用于**显示**，猜一个数不如显示 0
        //（0 的含义是"这份窗口就是全部历史"，与"确实淘汰过"不同 —— 所以不猜）。
        rawDropped = typeof asFile.dropped === 'number' && Number.isFinite(asFile.dropped) && asFile.dropped > 0
          ? Math.floor(asFile.dropped) : 0;
      }
      // 逐条校验（纯函数，规则见 core/metrics.ts 的 decodeEvents）
      const decoded: EventsDecode = decodeEvents(rawEvents);
      if (decoded.skipped > 0) {
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `metrics.json 中有 ${decoded.skipped} 条非法事件记录，已跳过（条目保留其余的，指标按剩余样本计算）`);
      }
      // 防御性再裁一次：文件可能被手工改大，或来自上限更小的旧版本。
      // 不裁的话，这个超大数组会一直留在内存里被每次刷卡排序（medianDecisionMs）。
      const capped: MetricsCap = capEvents(decoded.events);
      if (capped.dropped > 0) {
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `metrics.json 中的事件超过 ${MAX_METRIC_EVENTS} 条上限，读入时已淘汰最旧的 ${capped.dropped} 条`);
      }
      return { state: { events: capped.events }, dropped: rawDropped + capped.dropped };
    } catch (e) {
      // 必须带 e：这一支的四种成因（JSON 语法错、编码错、短读越界、fileIo 报错）
      // 在日志里长得一模一样，只有 e.message 能分开 —— 而它正是"指标为什么全没了"的答案。
      hilog.warn(DOMAIN, TAG, '%{public}s', `指标文件存在但读取/解析失败，已按空状态处理: ${errText(e)}`);
      return { state: emptyMetrics(), dropped: 0 };
    }
  }

  /**
   * 全量原子落盘。失败只告警（不抛：调用点在页面退出的收尾路径上，抛错没有任何人能接住）。
   *
   * 实现见 `core/atomicText.ts`（纯逻辑，16 个执行绪级用例）+ `data/atomicWrite.ets`（平台适配），
   * 本方法只是接线。**迁移前的形态曾是本文件自己实现的一整段**（`.tmp` + 按
   * `buffer.from(text).length` 比对返回值 + 不等就抛 → catch → 告警），它是对的，
   * 但那是仓库里的**第二份**正确实现（见文件头的"为什么把 1)、2) 交出去"）。
   *
   * 迁移的行为逐项对齐（四处刻意差异，都不是功能回退）：
   *   ① `.tmp` 路径：本地 `tmpPathOf(filesDir)` = `${filesDir}/metrics.json.tmp`；
   *      core 的 `tmpPathOf(真身)` = 真身 + `.tmp` = 同一个字符串 —— **逐字相同**（本地那份已删）；
   *   ② 期望字节数：原先只算平台的 `buffer.from(text).length`；现在**先算纯函数
   *      `utf8ByteLength(text)` 再与平台值交叉比对**，不一致就**拒绝落盘**（保留旧文件 + 告警 + 抛）。
   *      两者对 `JSON.stringify` 的输出恒等（ES2019 起它是 well-formed 的，落单代理会被转义成 ASCII），
   *      所以生产路径上不可观测；这是**更严**的一侧，不是更松；
   *   ③ 失败分类：原先只有 `w !== want` 一种判据（一律叫"短写"）；现在 `classifyWrite` 分成
   *      short / over / invalid 三种成因，日志能区分。三条都**不放行 rename**，后果完全相同；
   *   ④ `closeSync` 失败：原先被 `finally` 吞掉后**照样 rename**；现在把 close 失败记成整体失败、
   *      **不 rename**（close 负责把写缓冲刷下去，先 rename 就等于把"新文件内容为空"这个最坏后果
   *      从写侧又放回来）。这是**更安全**的一侧。
   * 除以上四处，其余逐项相同：UTF-8 字节数口径、"失败 ⇒ 真身一个字节都没改"、
   * "残留 `.tmp` 无害（下次 TRUNC 覆盖）"、以及成功路径的 open→write→close→rename 顺序。
   *
   * @param m 内存里的权威副本（SwipePage 持有；含**从盘上读回来的历史**）
   * @param dropped 累计被容量淘汰的条数（由 SwipePage 累加 capEvents 的返回值）
   *
   * ⚠️ 这是**全量写**：`m.events` 必须是"盘上已有的 + 本次新增的"，
   * 空数组起步会把盘上的历史整体抹掉 —— 与 decisionStore.saveAll 完全同一条前提
   *（这也是 SwipePage.aboutToAppear 必须先把历史读进内存的原因）。
   */
  save(m: MetricsState, dropped: number): void {
    try {
      // `JSON.stringify` **留在 try 内**（迁移前它在 try 内、只是位置在 openSync 之后）：
      // 万一它抛（例如 events 里混进了带循环引用的对象），也要走下面"只告警不抛"的降级，
      // 不能把它漏成未捕获异常。位置移到 open 之前对 MetricsFile 不可观测。
      const payload: MetricsFile = { events: m.events, dropped: dropped };
      // label 用「指标」：迁移前的告警是 `指标落盘失败: …`，取这个 label 后前缀**逐字不变**
      //（新文本为 `指标落盘失败，盘上旧文件未改动: …`，多出的六个字是可 grep 的增量）。
      writeTextAtomic(metricsStorePath(this.ctx.filesDir), JSON.stringify(payload), '指标');
    } catch (e) {
      // 本文件的既有契约是「落盘失败只告警不抛错」（调用点在页面退出的收尾路径上，
      // 抛出去没有任何人能接住）。日志**已经由 writeTextAtomic 打过**（含 want/got 与实际原因，
      // 以及"盘上旧文件未改动"），所以这里只把异常降级为"不抛"，不再重复打一行 ——
      // 与 decisionStore.saveAll / sessionStore.writeEntries 的迁法完全一致。
    }
  }
}
