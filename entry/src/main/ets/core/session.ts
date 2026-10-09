// 放回抽样式的「刷照片会话」模型（产品改版：没有"认领"动作，改为按张数刷照片）。
//
// 为什么是"放回抽样"（产品负责人原话：「前面刷过的照片可以继续放到整个照片池子里被抽中」）：
//   抽样范围是**整个已授权池**，与"是否已决策"无关 —— 已归档/已收藏/已上墙的照片
//   仍会被抽中并在新会话里再次出现。用户不需要记得"哪些认领过了"，也不会为了找旧照片一直下滑。
//   seenIds / prevQueue 只影响**优先级**（顺序），**不做排除** —— 任何照片都不会因为
//   "看过"或"上一批抽过"而失去被抽中的资格，这正是"放回"的含义。
//
// 平台约束（已实测，别绕）：第三方应用无法枚举相册（READ_IMAGEVIDEO 是 system_basic，
// 声明它会导致安装失败），唯一入口是系统选图器，选中的 URI 有永久授权。
// 所以本模块的 pool = **已授权池**，不是整个相册；"自动给用户 N 张" = 从已授权池里抽 N 张。
//
// 注意：本文件是纯逻辑，禁止 import @kit.*（否则 Node 无法加载，单测跑不起来）。

/** 一次刷照片会话 */
export interface SwipeSession {
  /** 本会话要刷的张数（含已刷进度） */
  size: number;
  /** 本会话的队列：抽样出来的 photoId，顺序即刷的顺序 */
  queue: string[];
  /** 当前刷到第几张（0-based；== queue.length 表示刷完） */
  cursor: number;
}

export const DEFAULT_SESSION_SIZE = 100;
export const SESSION_SIZE_CHOICES: number[] = [20, 50, 100, 200];

// ── 伪随机的选择与理由 ────────────────────────────────────────────────────────
// 用自带的 xorshift32 + **可注入种子**，不用 Math.random()：
//   Math.random() 没有种子入口 → 抽样不可复现 → 「同入参同结果」「未见过的优先」这类断言
//   根本写不出来，只能靠概率去撞，CI 上就是随机红灯；线上抽样出 bug（抽重、优先级失效）
//   也无法用一行种子在本地重放。xorshift32 只有三次位运算，同一种子给出同一序列，
//   测试可精确断言、线上传 Date.now() 之类的种子即可。它不是密码学安全的随机，
//   但"从自己的照片池里挑顺序"不需要密码学强度。
const XORSIHFT_FALLBACK_SEED = 0x9e3779b9;

/** 返回 [0, 2^32) 的整数序列；同一种子必然给出同一序列 */
function makeRng(seed: number): () => number {
  // 归一化到 uint32；xorshift32 的 0 是吸收态（永远是 0），换成非零常量
  let s = (Math.floor(seed) | 0) >>> 0;
  if (s === 0) { s = XORSIHFT_FALLBACK_SEED; }
  return () => {
    let x = s;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    s = x;
    return x;
  };
}

/** [0, n) 的整数；rnd()/2^32 是精确的双精度（除数是 2 的幂，无舍入误差），结果可复现 */
function randBelow(rnd: () => number, n: number): number {
  return Math.floor((rnd() / 4294967296) * n);
}

/** 从 items 里随机取 k 个（不放回），不改 items */
function pickRandom(items: string[], k: number, rnd: () => number): string[] {
  const arr = items.slice();   // 逐元素复制到自己的数组，绝不原地动入参
  const out: string[] = [];
  const n = Math.min(k, arr.length);
  for (let i = 0; i < n; i++) {
    // 部分 Fisher-Yates：把随机挑中的换到位置 i 再取走，保证同一会话内不重复
    const j = i + randBelow(rnd, arr.length - i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
    out.push(arr[i]);
  }
  return out;
}

/** 保序去重（防御性：调用方不应传重复，但纯函数要自洽） */
function dedupe(pool: string[]): string[] {
  const seen: Set<string> = new Set();
  const out: string[] = [];
  for (let i = 0; i < pool.length; i++) {
    const id = pool[i];
    if (seen.has(id)) { continue; }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 从已授权池里抽样出一个会话队列。
 *
 * 口径（产品负责人明确要求「放回抽样」）：
 *   - 抽样范围是**整个已授权池**，与"是否已决策"无关 —— 已归档/已收藏/已上墙的照片
 *     仍会被抽中并在新会话里再次出现（这是"放回"的含义）。
 *   - **同一会话内不重复**（否则一次会话里同一张会出现两次，体验是 bug）。
 *   - 抽不满 size 时返回能抽到的全部（不报错）。
 *
 * 优先级（在"不重复"的前提下尽量让回忆有新鲜感）—— **三层**，按序取用、缺多少从下一层补：
 *   1) **没见过的**（不在 seenIds 里）：回忆有新鲜感，永远优先。
 *   2) **见过、但不在上一批里的**（不在 prevQueue 里）：这就是"循环回来"该先轮到的那批。
 *   3) **上一批里的**（在 prevQueue 里）：最后才用它们补足。
 *   "见过"由 seenIds 提供（调用方从持久化状态读出）。
 *
 * 为什么要有第 2 层（它修的是一个确定性缺陷，不是口味问题）：
 *   池子 100 张、会话要 100 张、这 100 张都已看过时，第 1 层**恒为空**，两层实现退化成
 *   「每轮从同一个已见过的集合里抽满」—— 用户点「继续刷」看到的每一批都来自同一批照片，
 *   抽样看起来像坏了。加了第 2 层后，池子 200 张 / 每批 100 张的场景能连着给出 200 张不重复的，
 *   之后才开始循环。**第 3 层仍然保留**：池子 ≈ 张数时重叠不可避免，此时必须能抽满。
 *
 * 向后兼容：**prevQueue 传空数组时本函数与"两层版本"逐位一致**（含队列顺序与每个位置的取值），
 *   因为 prev 为空集 ⟹ 第 3 层恒空 ⟹ 第 2 层恰好就是原来的 known 桶，且分桶顺序、
 *   每层 pickRandom 的调用顺序与消耗的随机数个数都未变。core/session.test.ts 里有
 *   「旧实现差分」用例守着这条（不是靠肉眼论证）。
 *
 * size 字段：抽不满时保留**请求值**（同"池子空了"的口径），实际可刷张数以 queue.length 为准。
 *
 * @param pool      已授权池（photoId 列表）
 * @param size      本次要抽的张数
 * @param seenIds   历史上曾被展示过的 photoId（**只用于分桶，绝不排除**）
 * @param prevQueue 上一会话抽中的队列（用于"优先避开上一批"；空数组 = 退化为旧两层行为）
 * @param seed      随机种子（**必须可注入**：纯逻辑要可测、可复现）
 */
export function sampleSession(
  pool: string[],
  size: number,
  seenIds: string[],
  prevQueue: string[],
  seed: number
): SwipeSession {
  // NaN 也走这里（!(NaN > 0) === true）；口径同 claim.ts sortByTakenDesc 的 NaN 处理
  if (!(size > 0)) {
    return { size: 0, queue: [], cursor: 0 };
  }
  const uniq = dedupe(pool);
  if (uniq.length === 0) {
    // 池子空了：队列为空但保留请求的 size，UI 才能显示「要 100 张，可池子里一张都没有」
    return { size: size, queue: [], cursor: 0 };
  }
  const seen: Set<string> = new Set();
  for (let i = 0; i < seenIds.length; i++) { seen.add(seenIds[i]); }
  const prev: Set<string> = new Set();
  for (let i = 0; i < prevQueue.length; i++) { prev.add(prevQueue[i]); }
  // 分桶。**遍历 uniq 的顺序必须保持**：每一层内部保留池子里的相对顺序，再由 pickRandom
  // 按种子打散 —— 既保证"层内仍随机"，也让 prevQueue 为空时的结果与旧实现逐位相同。
  const fresh: string[] = [];   // 第 1 层：没见过
  const rest: string[] = [];    // 第 2 层：见过、但不在上一批里
  const last: string[] = [];    // 第 3 层：上一批里的
  for (let i = 0; i < uniq.length; i++) {
    const id = uniq[i];
    if (!seen.has(id)) { fresh.push(id); }
    else if (!prev.has(id)) { rest.push(id); }
    else { last.push(id); }
  }
  // 小数 size 只按整数张抽（张数是离散的；floor 后自然落在 [0, uniq.length]）
  const want = Math.min(Math.floor(size), uniq.length);
  const rnd = makeRng(seed);
  // 逐层取用：每层各自独立打散，上一层不够才动下一层；取用量恒为 [0, 该层长度]，
  // 所以层内随机性完整保留（同一层的不同取用顺序由 seed 决定，不是固定顺序）。
  const fromFresh = pickRandom(fresh, want, rnd);
  const fromRest = pickRandom(rest, want - fromFresh.length, rnd);
  const fromLast = pickRandom(last, want - fromFresh.length - fromRest.length, rnd);
  // 顺序即刷的顺序：新鲜的在前，其次是上一批之外的旧照片，最后才是上一批的（补足用）
  const queue = fromFresh.concat(fromRest).concat(fromLast);
  return { size: size, queue: queue, cursor: 0 };
}

/** 队列是否已刷完 */
export function isSessionDone(s: SwipeSession): boolean {
  return s.cursor >= s.queue.length;
}

/** 当前该刷的那张（刷完则返回 ''） */
export function currentPhotoId(s: SwipeSession): string {
  if (s.cursor < 0 || s.cursor >= s.queue.length) { return ''; }
  return s.queue[s.cursor];
}

/**
 * 前进一张；已刷完则原样返回（幂等）。
 * 幂等 = **内容**不变：仍返回新对象（本节口径是"全部返回新对象、不改原对象"），
 * queue 也另存一份，避免新旧会话共享可变数组（同 claim.ts mergeBatch 的取舍）。
 */
export function advance(s: SwipeSession): SwipeSession {
  if (isSessionDone(s)) {
    return { size: s.size, queue: s.queue.slice(), cursor: s.cursor };
  }
  return { size: s.size, queue: s.queue.slice(), cursor: s.cursor + 1 };
}
