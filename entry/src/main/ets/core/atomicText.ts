// 注意：本文件是纯逻辑，禁止 import @kit.*（否则 Node 无法加载，单测跑不起来）
//
// ── 这一层为什么存在（本批最重要的产出之一）────────────────────────────────────
// 「原子写」在本地历史上被写错过两次，而它错一次的代价是**用户不可再生的数据被永久毁掉**：
//   · data/claimStore.ets 的旧 save()：直接对真身 TRUNC 打开、丢弃 writeSync 的返回值 ——
//     一次短写就把 239 张「用户逐张点选、经系统选图器永久授权」的 URI 换成空文件；
//   · data/decisionStore.ets / data/sessionStore.ets 的旧 save：有 .tmp + rename，但**不校验**
//     writeSync 的返回值 —— 截断的 .tmp 被 rename 上去，把一份**好**文件换成了坏的
//     （seen.json 上限 5000 条 ≈ 480 KB，是四个文件里最大、短写概率最高的）。
//
// 这两条都**无法在真机上复现**（要靠 ENOSPC 或中断），所以修法必须做到「能被证据证明」。
// 做法是把「该写多少字节 / 返回值算不算成功 / 什么时候才允许 rename / fd 何时关」
// 全部搬到本文件（纯逻辑、无平台调用），平台动作经 AtomicWritePort 注入：
//   · data/atomicWrite.ets   → 真实 fileIo 端口（唯一一处 @kit 调用）
//   · core/atomicText.test.ts → 内存假文件系统端口（可注入短写/抛错/rename 失败）
// 于是「短写必被检出」「失败时真身一个字节都没动」「每条异常路径都关 fd」这三条断言
// 跑在 Node 里、有输出可查，而不是只写在注释里。
//
// ── 三步缺一不可 ──────────────────────────────────────────────────────────────
//   1) 先写 `.tmp`：不写 .tmp 就没有回退余地，短写直接毁掉真身；
//   2) **校验短写**（按 UTF-8 字节数）：不校验就是把一份好文件换成坏的；
//   3) 校验必须按**字节数**而不是 `text.length`：非 ASCII 的 photoId 会让两者不等。
//      注意错法的危害方向：用字符数当 want 时，一个正好被截断在 `text.length` 字节的坏文件
//      会被判成"写全了"而**放行 rename**（见 core/atomicText.test.ts 的判别性用例）。
//
// 失败时可能残留一个 `.tmp`：无害 —— 下次写入用 TRUNC 打开它即被覆盖。

/**
 * 原子写依赖的**平台端口**。core 不认识 fileIo，只认识这四个动作。
 *
 * 句柄刻意用 `number`（fd）而不是平台对象：core 不能 import @kit.*，
 * 而 fileIo 的 openSync/closeSync 都接受 fd（`closeSync(file: number | File)`，见 SDK d.ts）。
 */
export interface AtomicWritePort {
  /** 打开 `.tmp`（READ_WRITE | CREATE | TRUNC）。失败必须抛。返回 fd。 */
  openTrunc(tmpPath: string): number;
  /** 写字符串（平台按 UTF-8 编码）。返回**实际写入的字节数**（不保证等于字符串的字节数）。 */
  write(fd: number, text: string): number;
  /** 关闭 fd。必须在 rename **之前**调用（close 负责把写缓冲刷下去）。 */
  close(fd: number): void;
  /** 把 .tmp 原子地改名为真身。 */
  rename(tmpPath: string, finalPath: string): void;
}

/** 一次原子写的结果。失败时 `renamed` 必须为 false —— 那正是"真身未被改动"的机器可读形式。 */
export interface AtomicWriteResult {
  ok: boolean;        // 字节数完全相等、fd 已关、rename 成功
  renamed: boolean;   // 是否执行了 rename（失败路径上**必须**为 false）
  want: number;       // 期望写入的 UTF-8 字节数
  got: number;        // writeSync 实际返回的值（未写入时为 -1）
  detail: string;     // 失败原因（ok 时为 ''）
}

/** 写入结果的分类。刻意不合并成布尔：`short` / `over` / `invalid` 三种成因在真机上要能分开。 */
export type WriteClass = 'ok' | 'short' | 'over' | 'invalid';

/**
 * 文本的 UTF-8 字节数。**必须**用它（而不是 `text.length`）当写入量的期望值。
 *
 * 与平台编码器的等价性论证（为什么可以自己数、而不是调 `buffer.from(text).length`）：
 *   · 唯一的实现差异空间是**落单代理**（lone surrogate）：本函数按 U+FFFD 计 3 字节，
 *     与 WHATWG TextEncoder / Node `Buffer.from` / ArkTS 运行时的替换规则一致；
 *     成对的代理（emoji）两处都算 4 字节。
 *   · 本项目四个 store 只把 `JSON.stringify(...)` 的输出交给原子写，而 ES2019 起
 *     `JSON.stringify` 是 "well-formed" 的：落单代理会被转义成 `\uD800` 这样的 **ASCII** 序列。
 *     也就是说生产路径上**根本不存在**落单代理，上述差异空间为空。
 *   · 即便如此，data/atomicWrite.ets 仍会把本函数的结果与平台的 `buffer.from(text).length`
 *     交叉比对一次，不一致就**拒绝落盘**（宁可少写一次，也不拿坏文件覆盖好文件）。
 */
export function utf8ByteLength(text: string): number {
  let n: number = 0;
  for (let i = 0; i < text.length; i++) {
    const c: number = text.charCodeAt(i);
    if (c < 0x80) {
      n = n + 1;
    } else if (c < 0x800) {
      n = n + 2;
    } else if (c >= 0xD800 && c <= 0xDBFF) {
      // 高位代理：后面必须跟一个低位代理，合成一个 4 字节字符（emoji 等）
      const next: number = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        n = n + 4;
        i = i + 1;      // 低位代理已计入，跳过它
      } else {
        n = n + 3;      // 落单的高位代理 → U+FFFD（替换字符本身是 3 字节）
      }
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      n = n + 3;        // 落单的低位代理 → U+FFFD
    } else {
      n = n + 3;        // 0x800..0xFFFF 的三字节字符（中文等）
    }
  }
  return n;
}

/**
 * 一次写入算不算成功。**这是本缺陷族的判定核心**，所以它必须是纯函数、必须有单测。
 *
 * 判据是「完全相等」，不是「不小于」：
 *   · `got < want` → 短写（POSIX 语义下 ENOSPC / 被信号中断**可以短计数而不抛**）；
 *   · `got > want` → 写多了。SDK 契约下不该发生，属于违约；此时我们无法推理盘上到底是
 *     什么内容，所以**同样不放行** rename（宁可保留上一份好文件）。
 * 两者都会让调用方知道失败，且都不会 rename。
 */
export function classifyWrite(want: number, got: number): WriteClass {
  if (!Number.isFinite(want) || want < 0) { return 'invalid'; }
  if (!Number.isFinite(got) || got < 0) { return 'invalid'; }
  if (got === want) { return 'ok'; }
  if (got < want) { return 'short'; }
  return 'over';
}

/** 失败原因的可读文本。带上 want/got 两个数字：真机上只看到一句"落盘失败"是没法下手的。 */
export function describeWriteFailure(cls: WriteClass, want: number, got: number): string {
  if (cls === 'short') { return `writeSync 短写：期望 ${want} 字节，实际写入 ${got} 字节`; }
  if (cls === 'over') { return `writeSync 写入字节数超出期望：期望 ${want} 字节，实际写入 ${got} 字节`; }
  if (cls === 'invalid') { return `writeSync 返回值非法：期望 ${want} 字节，实际返回 ${got}`; }
  return '';
}

/**
 * 把 catch 到的值转成一行可打印文本。**与 data/locationIndex.ets 的同名私有函数逐字一致**
 * （那边保持原样不动，这里给新增的原子写路径用）。
 *
 * 为什么需要它：ArkTS 禁 `any`，catch 参数不能当 any 用，要取 `message` 必须显式转换；
 * 同时又**不能假设抛出来的都是 Error**（fileIo 抛的是 BusinessError —— 它是 Error 的子类，
 * 但 SDK 违约路径上什么都可能抛）。非 Error 时退化成 `JSON.stringify(e)`：
 * 至少保证日志里留下一行能搜的东西，而不是 `undefined`。
 */
export function errText(e: Object): string {
  if (e instanceof Error) { return e.message; }
  return JSON.stringify(e);
}

/**
 * `.tmp` 路径的唯一约定：真身路径 + `.tmp`。
 *
 * 为什么做成函数：四个 store 各自拼过一次（`locations.json.tmp` / `decisions.json.tmp` /
 * `seen.json.tmp`），拼错就是"写了 .tmp 却 rename 另一个名字"——那会**报错并保留真身**
 *（还好），或者更糟：rename 到一个不存在的路径。集中一处，`claimStore` 新增时也不必再拼。
 */
export function tmpPathOf(finalPath: string): string {
  return `${finalPath}.tmp`;
}

function makeResult(ok: boolean, renamed: boolean, want: number, got: number, detail: string): AtomicWriteResult {
  return { ok: ok, renamed: renamed, want: want, got: got, detail: detail };
}

/**
 * 原子写文本的**全部逻辑**：写 `.tmp` → 校验字节数 → 关 fd → rename。
 *
 * 契约（四条，逐条都有单测）：
 *   1) `ok === true` **当且仅当** 字节数完全相等、fd 已关闭、rename 成功；
 *   2) 任何失败路径下 `renamed === false` ⇒ 真身文件**一个字节都没动**（上一份好数据还在）；
 *   3) **每条异常路径都关 fd**（包括短写那条、write 抛错那条）。本项目出过一次真实缺陷：
 *      `openSync` 成功 → 中间抛异常 → catch 提前 return → **fd 泄漏**；所以从 open 成功到
 *      关闭那一行之间**没有任何 return**（catch 只赋值 fail、不返回），"关 fd"因此不可能被跳过；
 *   4) **close 在 rename 之前**（与 data/locationIndex.ets 的既有实现一致）：close 负责把写缓冲
 *      刷下去，先 rename 再 close 的话，一次掉电就可能让"已经原子换上"的新文件内容为空 ——
 *      等于把本函数防的最坏后果从写侧又放回来。
 *
 * 不抛错：所有异常都转成 `AtomicWriteResult.detail`。**是否抛给用户由 data 层决定**
 *（见 data/atomicWrite.ets：它打完日志后抛，好让"这次没保存"不可能被静默忽略）。
 */
export function writeTextAtomicWithPort(port: AtomicWritePort, tmpPath: string, finalPath: string, text: string): AtomicWriteResult {
  const want: number = utf8ByteLength(text);
  let fd: number = -1;
  let got: number = -1;
  let fail: string = '';

  // ① 打开 .tmp。TRUNC 顺手清掉上一次失败残留的 .tmp（见文件头：残留无害）。
  try {
    fd = port.openTrunc(tmpPath);
  } catch (e) {
    // 没打开成功 ⇒ **没有 fd 可关**（此时 fd 仍是 -1，下面不会去 close 一个不存在的句柄）
    return makeResult(false, false, want, got, errText(e));
  }

  // ② 写 + 校验。这一段的任何异常都**不能**跳过 ③ 的关闭 —— 所以这里只赋值、不 return。
  try {
    got = port.write(fd, text);
    const cls: WriteClass = classifyWrite(want, got);
    if (cls !== 'ok') {
      fail = describeWriteFailure(cls, want, got);
    }
  } catch (e) {
    fail = errText(e);
  }

  // ③ 无论成功、短写还是抛错，都在这里关 fd（短写路径也要关，否则泄漏 fd）。
  if (fd >= 0) {
    try {
      port.close(fd);
    } catch (e) {
      // 关不掉 = 数据可能没刷下去。此时绝不 rename（见 ④），所以把它记成失败。
      if (fail === '') { fail = `closeSync 失败: ${errText(e)}`; }
    }
  }

  if (fail !== '') {
    // 失败 ⇒ 不 rename ⇒ 真身原封不动。这正是"绝不拿截断的 .tmp 覆盖好文件"。
    return makeResult(false, false, want, got, fail);
  }

  // ④ 只有「got === want 且 fd 已关闭」才可能走到这一行。
  try {
    port.rename(tmpPath, finalPath);
  } catch (e) {
    return makeResult(false, false, want, got, errText(e));
  }
  return makeResult(true, true, want, got, '');
}
