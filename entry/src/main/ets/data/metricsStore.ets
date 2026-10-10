/**
 * 指标落盘：`files/metrics.json` —— 刷卡事件窗口 + 「已淘汰条数」。
 *
 * 为什么需要它（本文件存在的唯一理由）：
 *   spec §5.3 的三条验收指标（决策间隔中位数 / 回弹率 / 上墙转化率）原本只在内存里，
 *   App 一退就没了 —— 于是指标**只能当场看**，无法从历史数据算，也就无法在验收时复现。
 *   落盘之后它们变成可复核的历史读数（「使用统计」页 pages/StatsPage.ets 读的就是本文件）。
 *
 * 存储层的写法**照抄 `data/locationIndex.ets` / `data/sessionStore.ets` / `data/decisionStore.ets`**
 *（同一套已被多轮审查确认过的做法），逐条对齐：
 *   1) **原子写**：先写 `metrics.json.tmp`，再 `renameSync` 覆盖真身；
 *   2) **短写检测**：比较**UTF-8 字节数**（`buffer.from(payload).length`）而不是 `payload.length`
 *      —— photoId 是 file:// media URI，真机上可能含非 ASCII（中文相册名/文件名），两者会不等；
 *      检出短写就抛进 catch，于是**不会**执行 rename（绝不拿截断的 .tmp 覆盖一份好数据）；
 *   3) **短读检测**：校验 `readSync` 的返回值，并且只解码**实际读到的字节**
 *      —— 否则 buf 尾部是 NUL 填充，JSON.parse 失败后会静默退化成空状态（伪装成"没保存"）；
 *   4) **UTF-8 解码**：`buffer.from(bytes).toString('utf-8')`，**禁止**逐字节 String.fromCharCode 拼串
 *      （本项目为此栽过 4 次，见 Ruling 24）；
 *   5) **形状校验**：读回来的 JSON 逐条校验结构，坏了就退回空状态（**不抛**）。
 *      逐条校验本身在 `core/metrics.ts` 的 `decodeEvents`（纯函数，跑在 node 单测里），
 *      本文件只负责"顶层形状 + IO" —— 校验规则因此有一份可被单测钉住的实现。
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

// 原子写的临时文件：先写它，再 rename 覆盖真身。
function tmpPathOf(filesDir: string): string {
  return `${filesDir}/metrics.json.tmp`;
}

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
   * @param m 内存里的权威副本（SwipePage 持有；含**从盘上读回来的历史**）
   * @param dropped 累计被容量淘汰的条数（由 SwipePage 累加 capEvents 的返回值）
   *
   * ⚠️ 这是**全量写**：`m.events` 必须是"盘上已有的 + 本次新增的"，
   * 空数组起步会把盘上的历史整体抹掉 —— 与 decisionStore.saveAll 完全同一条前提
   *（这也是 SwipePage.aboutToAppear 必须先把历史读进内存的原因）。
   */
  save(m: MetricsState, dropped: number): void {
    const dir = this.ctx.filesDir;
    const tmp = tmpPathOf(dir);
    try {
      const file = fileIo.openSync(tmp,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        const payload: MetricsFile = { events: m.events, dropped: dropped };
        const text: string = JSON.stringify(payload);
        // 必须按**字节数**比对，不是 text.length —— 非 ASCII 的 photoId 会让两者不等。
        // 短写（POSIX 语义下 ENOSPC 等可以短计数而**不抛**）若不检出，截断的 .tmp 会覆盖掉
        // 一份好数据 → 下次 load() 解析失败 → 空状态 → 指标全丢，而用户会以为"没记录过"。
        const want: number = buffer.from(text).length;
        const w: number = fileIo.writeSync(file.fd, text);
        if (w !== want) {
          // 抛进 catch：于是**不会**执行下面的 renameSync，盘上的好数据原封不动。
          throw new Error(`writeSync 短写：期望 ${want} 字节，实际写入 ${w} 字节`);
        }
      } finally {
        // 无论上面抛不抛，句柄都在这里关掉（短写路径也要关，否则泄漏 fd）。
        fileIo.closeSync(file);
      }
      // 只有上面**没抛**（即 w === want）才可能走到这一行。
      fileIo.renameSync(tmp, metricsStorePath(dir));
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '%{public}s', `指标落盘失败: ${errText(e)}`);
    }
  }
}
