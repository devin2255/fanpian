/**
 * 原子写的**平台适配层**：把 core/atomicText.ts 的纯逻辑接到真实的 `fileIo` 上。
 *
 * ── 这层的分层原则（本批的核心产出）────────────────────────────────────────────
 * core/atomicText.ts 里是"该写多少字节 / 返回值算不算成功 / 什么时候才允许 rename /
 * fd 在哪一步关"——**全部纯逻辑**，因此能在 Node 里用内存文件系统跑出短写、ENOSPC、
 * close 失败、rename 失败这些真机上极难复现的场景（见 core/atomicText.test.ts）。
 * 本文件只剩下**四行平台调用**（open/write/close/rename）+ 告警 + 抛错，
 * 没有一处判断逻辑 —— 判断逻辑一旦分叉成两份，就会出现"某一份漏改了"的那种缺陷。
 *
 * ── 为什么失败要**抛**（而不是返回布尔）────────────────────────────────────────
 * 返回布尔时，调用方漏接返回值 = 静默失败，而这正是本缺陷族的成因（旧 claimStore 丢弃
 * writeSync 的返回值、旧 decisionStore 丢弃后无条件 rename）。抛错**不可能**被忽略：
 *   · claimStore.save 保持"往上抛"的原契约（它本来就没有 catch）；
 *   · decisionStore / sessionStore / locationIndex 三个「只告警不抛错」的既有契约，
 *     由它们各自 catch 住并降级（日志已经由本函数打过，不重复打）。
 */
import { fileIo } from '@kit.CoreFileKit';
import { buffer } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import {
  AtomicWritePort,
  AtomicWriteResult,
  tmpPathOf,
  utf8ByteLength,
  writeTextAtomicWithPort
} from '../core/atomicText';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

/** 真实平台端口。**无状态**（不持有任何字段），因此模块级一个实例就够，也没有并发问题。 */
class FileIoPort implements AtomicWritePort {
  openTrunc(tmpPath: string): number {
    const file = fileIo.openSync(tmpPath,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    // 只把 fd 交给 core：core 不能 import @kit.*，而 closeSync 接受 fd（SDK d.ts:
    // `declare function closeSync(file: number | File): void;`），所以句柄用 number 表达。
    return file.fd;
  }

  write(fd: number, text: string): number {
    // SDK 对返回值的原文（@ohos.file.fs.d.ts，writeSync 的 @returns）：
    //     "@returns { number } Length of the data written, in bytes."
    // 注意它说的是**已写入的长度**，而不是"调用成功"——所以调用方必须自己比对期望值。
    return fileIo.writeSync(fd, text);
  }

  close(fd: number): void {
    fileIo.closeSync(fd);
  }

  rename(tmpPath: string, finalPath: string): void {
    fileIo.renameSync(tmpPath, finalPath);
  }
}

const PORT: FileIoPort = new FileIoPort();

/**
 * 原子写文本：先写 `.tmp`，**校验短写**，只有字节数完全相等才 rename 覆盖真身。
 *
 * 为什么这三步缺一不可（本项目的真实历史）：
 *   · 不写 `.tmp` → 短写直接毁掉真身，**没有回退余地**（claimStore 的旧形态）；
 *   · 不校验短写 → 截断的 `.tmp` 被 rename 上去，**把一份好文件换成坏的**
 *     （decisionStore / sessionStore 的旧形态）；
 *   · 校验必须按 **UTF-8 字节数**，不是 `text.length` —— 非 ASCII 的 photoId 会让两者不等，
 *     而用字符数当期望值会**放行**一个正好截断在 `text.length` 字节的坏文件（见单测）。
 *
 * 失败时可能残留一个 `.tmp`：无害，下次写入用 TRUNC 打开它即被覆盖。
 *
 * @param path  真身文件的完整路径（`.tmp` 由 tmpPathOf 统一推导：真身路径 + `.tmp`）
 * @param text  要写入的完整文本（四个 store 传的都是 JSON.stringify 的结果）
 * @param label 日志里标识是哪个文件（如「认领列表」）—— 真机上"哪个文件落盘失败"必须一眼可见
 * @throws Error 落盘失败（含短写、fd 关闭失败、rename 失败、平台调用抛错）。
 *         **失败时真身文件一个字节都没改动**，所以调用方可以安全地重试或向上报错。
 */
export function writeTextAtomic(path: string, text: string, label: string): void {
  // ── 双重字节数交叉校验（宁可少写一次，也不拿坏文件覆盖好文件）────────────────
  // 纯函数算一遍、平台算一遍，两者不一致说明"我们对期望值的理解"与"平台实际会写多少"
  // 有分歧。此时**拒绝落盘**：最坏后果是这次没保存 + 一行告警，而真身仍是上一份好文件。
  // （为什么可以有把握两者恒等：四个 store 传进来的都是 JSON.stringify 的输出，
  //  ES2019 起它是 well-formed 的 —— 落单代理被转义成 ASCII，见 core/atomicText.ts 的论证。）
  const wantPure: number = utf8ByteLength(text);
  const wantPlatform: number = buffer.from(text).length;
  if (wantPure !== wantPlatform) {
    hilog.warn(DOMAIN, TAG, '%{public}s',
      `${label}落盘失败，盘上旧文件未改动: UTF-8 字节数校验不一致（纯函数 ${wantPure} / 平台 ${wantPlatform}），已拒绝落盘`);
    throw new Error(`${label}落盘失败：UTF-8 字节数校验不一致（${wantPure} / ${wantPlatform}）`);
  }

  const res: AtomicWriteResult = writeTextAtomicWithPort(PORT, tmpPathOf(path), path, text);
  if (!res.ok) {
    // 必须让调用方知道失败 —— 而且日志里要带 want/got 两个数字，否则真机上只剩一句"落盘失败"，
    // 完全分不清是盘满（短写）、fd 坏了还是 rename 失败。
    hilog.warn(DOMAIN, TAG, '%{public}s',
      `${label}落盘失败，盘上旧文件未改动: ${res.detail}`);
    throw new Error(`${label}落盘失败: ${res.detail}`);
  }
}
