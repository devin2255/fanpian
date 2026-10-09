import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { buffer } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SwipeSession } from '../core/session';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

// ── 本文件承载两类状态，生命周期刻意不同 ──────────────────────────────────────
//
// 1) 「看过哪些」（seenIds）—— **必须持久化**。
//    它是抽样优先级的唯一输入（见 core/session.ts 的 sampleSession：未见过的优先抽，
//    不做排除）。不落盘的话每次冷启动都当「全都没看过」，优先级就退化成纯随机，
//    用户会反复看到刚刷过的照片 —— 而这正是「放回抽样」最容易被感知为 bug 的地方。
//
// 2) 「当前会话」（SwipeSession）—— **只在内存**。
//    会话的语义是「这一次要刷的这批」。App 重启后从池子里重抽一批是合理行为
//    （产品口径：没有认领动作，随时可以再开一局），落盘反而会把「上次刷到一半的进度」
//    变成必须恢复的强约束；而池子内容随时可能因为补货而变化，恢复旧会话的收益为负。
//    更实际的：把它落盘就要面对「队列里的 photoId 已经被用户从相册删掉」这类失效恢复，
//    为一个可随时重抽的东西引入这条路径不划算。

/** 「看过」的一条记录。lastSeenAt 只用于淘汰（见 MAX_SEEN_ENTRIES），不参与优先级判定 */
export interface SeenEntry {
  photoId: string;
  lastSeenAt: number;
}

/**
 * 「看过」的上限。选 5000 的理由：
 *   - 它只是一个**优先级提示**、不是排除集（sampleSession 只用它给"没见过的"排前面），
 *     所以丢掉最旧的那些只会让少数照片重新显得"新鲜"，不会丢数据、不会让照片消失；
 *     这让"淘汰"成为一个安全的降级动作，上限因此可以放心设小。
 *   - 5000 条 ≈ 480 KB JSON（每条含一个 file:// media URI），冷启动/首次开局读一次、
 *     解析几毫秒；内存里一个 5000 项的 Map 约几百 KB。都在可接受范围内。
 *   - 5000 也远超 M1 的真实使用量（要滑满 5000 张才触顶），所以触顶之前它是"全量"的。
 */
export const MAX_SEEN_ENTRIES = 5000;

/**
 * 淘汰的低水位：**超过上限时一次性淘汰到 MAX - SEEN_EVICT_SLACK**，而不是每次只砍一条。
 * 理由：淘汰要先按 lastSeenAt 排序（O(n log n)，n = 5001）。若每次只砍一条，那么在上限之上
 * 每多刷一张就要排一次 5000 项 —— 这是跑在 UI 线程上的滑动热路径，一次排序就是几毫秒。
 * 低水位把它摊薄成「每新增 500 张排一次」。代价是 Map 规模在 [4500, 5000] 之间波动，
 * 即最旧的 500 条会被提前忘掉 —— 对"优先级提示"这个用途无影响（见上）。
 * 硬性上限仍然是 MAX：任何时刻落盘条数 ≤ MAX_SEEN_ENTRIES。
 */
export const SEEN_EVICT_SLACK = 500;

// 路径与 core/claim.ts 的 claimStorePath 同风格（本文件私有：路径拼接是 IO 语义的一部分，
// core/ 保持无 IO；本文件也没有第二个调用方）。
function seenStorePath(filesDir: string): string {
  return `${filesDir}/seen.json`;
}

// 原子写的临时文件：先写它，再 rename 覆盖真身（与 decisionStore 同规矩）。
function seenTmpPath(filesDir: string): string {
  return `${filesDir}/seen.json.tmp`;
}

// ── 模块级缓存（不是实例字段，理由见 SessionStore 的类注释）────────────────────
let seenLoaded: boolean = false;
let seenEntries: Map<string, SeenEntry> = new Map();
let seenDirty: boolean = false;

/** 按 lastSeenAt 淘汰最旧的，直到低水位。只在超上限时调用。 */
function evictOldest(): void {
  if (seenEntries.size <= MAX_SEEN_ENTRIES) { return; }
  const all: SeenEntry[] = [];
  seenEntries.forEach((e: SeenEntry) => { all.push(e); });
  // 升序 = 最旧的在前；保留末尾（最新）的 keepCount 条
  all.sort((a: SeenEntry, b: SeenEntry) => a.lastSeenAt - b.lastSeenAt);
  const keepCount: number = MAX_SEEN_ENTRIES - SEEN_EVICT_SLACK;
  // Math.max 只是防御：正常路径下 all.length > MAX > keepCount，keepFrom 必然为正。
  const from: number = Math.max(0, all.length - keepCount);
  const next: Map<string, SeenEntry> = new Map();
  for (let i = from; i < all.length; i++) {
    next.set(all[i].photoId, all[i]);
  }
  const dropped: number = all.length - next.size;
  seenEntries = next;
  hilog.info(DOMAIN, TAG, '%{public}s',
    `「看过」记录超过 ${MAX_SEEN_ENTRIES} 上限，已淘汰最旧的 ${dropped} 条（按 lastSeenAt）`);
}

/**
 * 读 seen.json。**三条存储层规矩**（与 data/decisionStore.ets 逐条对齐）：
 *   1) UTF-8 解码：写盘走 JSON.stringify（UTF-8 字节），必须用 buffer.from(bytes).toString('utf-8')；
 *      按字节拼串等价于 Latin-1，会把非 ASCII 的 photoId 解成 mojibake。
 *   2) 形状校验：非数组 → 空；photoId 非字符串或空 → 跳过并计数告警；
 *      lastSeenAt 非有限数 → 0（**不跳过**：这条记录仍然表达了"这张看过"，只是失去了时间信息）。
 *   3) 原子写（在 writeEntries 里）：先写 .tmp 再 rename。
 */
function readEntries(path: string): Map<string, SeenEntry> {
  const m = new Map<string, SeenEntry>();
  // 两次 statSync 是刻意的（同 decisionStore）：第一次只回答「文件在不在」。
  // 文件不存在 = 首次运行的正常路径，静默返回空；「文件在但读/解析失败」才告警。
  let exists = false;
  try {
    fileIo.statSync(path);
    exists = true;
  } catch (e) {
    exists = false;
  }
  if (!exists) { return m; }

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
    // 整段解码会让 JSON.parse 失败并静默退化为「全都没看过」，伪装成「没保存」。
    const bytes: Uint8Array = new Uint8Array(buf, 0, n);
    const text: string = buffer.from(bytes).toString('utf-8');
    const parsed = JSON.parse(text) as SeenEntry[];
    if (!Array.isArray(parsed)) {
      hilog.warn(DOMAIN, TAG, '%{public}s', 'seen.json 不是数组，已按「全都没看过」处理');
      return m;
    }
    let skipped = 0;
    for (let i = 0; i < parsed.length; i++) {
      const e = parsed[i];
      if (e === null || e === undefined) { skipped = skipped + 1; continue; }
      if (typeof e.photoId !== 'string' || e.photoId === '') { skipped = skipped + 1; continue; }
      const at: number = typeof e.lastSeenAt === 'number' && Number.isFinite(e.lastSeenAt) ? e.lastSeenAt : 0;
      // 重复 photoId 以文件中最后一条为准（正常路径不会产生重复：写盘前它就是一张 Map）。
      m.set(e.photoId, { photoId: e.photoId, lastSeenAt: at });
    }
    if (skipped > 0) {
      hilog.warn(DOMAIN, TAG, '%{public}s', `seen.json 中有 ${skipped} 条非法记录，已跳过`);
    }
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '%{public}s', 'seen.json 存在但读取/解析失败，已按「全都没看过」处理');
  }
  return m;
}

/** 全量原子落盘。失败只告警（不抛：调用点在页面退出的收尾路径上）。 */
function writeEntries(filesDir: string, entries: Map<string, SeenEntry>): void {
  const arr: SeenEntry[] = [];
  entries.forEach((e: SeenEntry) => { arr.push(e); });
  const tmp = seenTmpPath(filesDir);
  try {
    // 原子写：先写临时文件，再 rename 覆盖，避免写到一半失败留下半个文件
    const file = fileIo.openSync(tmp,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, JSON.stringify(arr));
    } finally {
      fileIo.closeSync(file);
    }
    fileIo.renameSync(tmp, seenStorePath(filesDir));
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '%{public}s', 'seen.json 落盘失败');
  }
}

/** 惰性加载：每个进程只读一次盘。置位在读取**之前**，坏文件不会被每次滑动重读一遍。 */
function ensureLoaded(ctx: common.UIAbilityContext): void {
  if (seenLoaded) { return; }
  seenLoaded = true;
  seenEntries = readEntries(seenStorePath(ctx.filesDir));
}

/**
 * 「看过」与「当前会话」的存取层。
 *
 * 为什么缓存是**模块级**而不是实例字段：首页与刷照片页各自 new 一个 SessionStore
 * （沿用 ClaimStore / DecisionStore 的风格，调用点不必关心单例）。若缓存挂在实例上，
 * 两个实例就会各持一份互不可见的副本 —— 刷照片页标记的"看过"回首页再开一局时读不到
 * （首页那份缓存还是开局前读的），优先级立刻失真。挂在模块级 = 两个实例天然共享同一份真相。
 * 另一条路是「每次读盘」，那会让 markSeen 变成"每滑一张一次全量读 + 一次全量写"
 * （decisionStore 的 set() 注释明确反对这种形态：全量同步 I/O 跑在 UI 线程上）。
 */
export class SessionStore {
  private ctx: common.UIAbilityContext;

  constructor(ctx: common.UIAbilityContext) { this.ctx = ctx; }

  /**
   * 读出全部「看过」的 photoId，供 sampleSession 的优先级使用。
   * 顺序无意义（sampleSession 会把它装进 Set）。
   */
  loadSeenIds(): string[] {
    ensureLoaded(this.ctx);
    const out: string[] = [];
    seenEntries.forEach((e: SeenEntry) => { out.push(e.photoId); });
    return out;
  }

  /**
   * 标记若干张为「已看过」（带时间戳）。
   * 只改内存 + 置脏标记，**不在这里写盘**：唯一调用点在刷照片的换卡热路径上，
   * 每滑一张就全量读 + 全量写是必须避免的形态。落盘由 flush() 承担，
   * 调用方（SwipePage）把它挂在已有的 1 秒防抖窗口与页面退出的 flushSave() 上。
   *
   * 刻意**不提供**「取消看过」的接口：看过就是看过了（见 pages/SwipePage.ets 的 navigate
   * 说明 —— 「返回上一张」会撤销那张的**决策**，但绝不该撤销「看过」）。
   * 没有这个接口，撤销就是结构上不可达的，而不是靠调用点自觉。
   */
  markSeen(ids: string[], now: number): void {
    ensureLoaded(this.ctx);
    let changed = false;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id === '') { continue; }
      // 同一张再看到：刷新时间戳（它同时决定淘汰顺序），不新增条目
      seenEntries.set(id, { photoId: id, lastSeenAt: now });
      changed = true;
    }
    if (!changed) { return; }
    seenDirty = true;
    evictOldest();
  }

  /** 把内存里的「看过」全量落盘。未加载过（没读过也没标过）时什么也不做 —— 绝不写空覆盖真身。 */
  flush(): void {
    if (!seenLoaded || !seenDirty) { return; }
    seenDirty = false;
    writeEntries(this.ctx.filesDir, seenEntries);
  }
}

// ── 当前会话（只在内存，理由见文件头）────────────────────────────────────────
let currentSession: SwipeSession | undefined = undefined;

/** 存下本次要刷的会话（由首页在抽样后调用）。 */
export function setSession(s: SwipeSession): void {
  currentSession = s;
}

/**
 * 取出**并清空**当前会话（由刷照片页在 aboutToAppear 调用）。
 *
 * 为什么是 take（读取即清空）而不是 get：
 *   刷照片页每次进入都会重建；若取走后不清空，下一次进入本页会**原样复用**上一局的队列 ——
 *   cursor 从 0 起，用户把刚刷过的照片从头再刷一遍，而"看过/决策"两边都以为它是新的。
 *   清空让「一局会话只能被消费一次」成为结构事实：本页每次拿到队列，都必须来自首页一次
 *   显式的 setSession（= 一次显式的抽样）。取不到就是空会话 → 本页进完成态引导用户回首页，
 *   而不是猜着抽一批（那会绕过首页的张数选择与补货）。
 */
export function takeSession(): SwipeSession | undefined {
  const s = currentSession;
  currentSession = undefined;
  return s;
}
