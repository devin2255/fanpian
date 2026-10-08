import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { buffer } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Decision, DecisionState } from '../core/queue';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

// 本文件私有：与 core/claim.ts 的 claimStorePath 命名一致，但不 export
//（路径拼接是 IO 语义的一部分，core/ 保持无 IO；本任务也没有第二个调用方）。
function decisionStorePath(filesDir: string): string {
  return `${filesDir}/decisions.json`;
}

// 原子写的临时文件：先写它，再 rename 覆盖真身。
function tmpPathOf(filesDir: string): string {
  return `${filesDir}/decisions.json.tmp`;
}

/** state 必须是 DecisionState 的成员；外部数据（持久化回放）不得静默通过（Ruling 18 同类要求） */
function isValidState(s: string): boolean {
  return s === 'unseen' || s === 'archived' || s === 'faved' || s === 'walled';
}

export class DecisionStore {
  private ctx: common.UIAbilityContext;

  constructor(ctx: common.UIAbilityContext) { this.ctx = ctx; }

  loadAll(): Map<string, Decision> {
    const m = new Map<string, Decision>();
    const path = decisionStorePath(this.ctx.filesDir);
    // 两次 statSync 是刻意的：第一次只回答「文件在不在」。
    // 文件不存在 = 首次运行的正常路径，静默返回空 Map；
    // 「文件在但读/解析失败」才是要告警的异常（下面的 catch）。
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
      // 只解码实际读到的字节：若文件在 stat 与 read 之间变小（短读），
      // buf 尾部是 NUL 填充，整段解码会让 JSON.parse 失败并静默退化为空 Map
      //（= 所有照片回到队列，伪装成「没保存」）。
      const bytes: Uint8Array = new Uint8Array(buf, 0, n);
      // saveAll() 写的是 UTF-8，必须按 UTF-8 解码；
      // 按字节拼串等价于 Latin-1，会把非 ASCII 的 photoId 解成 mojibake（Ruling 24）。
      const text: string = buffer.from(bytes).toString('utf-8');
      const parsed = JSON.parse(text) as Decision[];
      // Ruling 18：数据边界层校验，非法数据不得静默通过。
      // 尤其 state 非法者必须跳过——queue.ts 的 buildQueue 对无法识别的 state
      // 会静默把照片从队列里移除（Task 4 审查 Minor #3/#4）。
      if (!Array.isArray(parsed)) {
        hilog.warn(DOMAIN, TAG, '%{public}s', 'decisions.json 不是数组，已按空状态处理');
        return m;
      }
      let skipped = 0;
      for (let i = 0; i < parsed.length; i++) {
        const d = parsed[i];
        if (d === null || d === undefined) { skipped = skipped + 1; continue; }
        if (typeof d.photoId !== 'string' || d.photoId === '') { skipped = skipped + 1; continue; }
        if (typeof d.state !== 'string' || !isValidState(d.state)) { skipped = skipped + 1; continue; }
        m.set(d.photoId, {
          photoId: d.photoId,
          state: d.state as DecisionState,
          decidedAt: typeof d.decidedAt === 'number' && Number.isFinite(d.decidedAt) ? d.decidedAt : 0,
          deferCount: typeof d.deferCount === 'number' && Number.isFinite(d.deferCount) ? d.deferCount : 0
        });
      }
      if (skipped > 0) {
        hilog.warn(DOMAIN, TAG, '%{public}s', `决策文件中有 ${skipped} 条非法记录，已跳过`);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '%{public}s', '决策文件存在但读取/解析失败，已按空状态处理');
    }
    return m;
  }

  saveAll(m: Map<string, Decision>): void {
    const arr: Decision[] = [];
    m.forEach((v: Decision) => { arr.push(v); });
    const dir = this.ctx.filesDir;
    const tmp = tmpPathOf(dir);
    try {
      // 原子写：先写临时文件，再 rename 覆盖，避免写到一半失败留下半个文件
      const file = fileIo.openSync(tmp,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(arr));
      } finally {
        fileIo.closeSync(file);
      }
      fileIo.renameSync(tmp, decisionStorePath(dir));
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '%{public}s', '决策落盘失败');
    }
  }

  // 这里刻意不再提供 set(d: Decision)（Task 8 曾有）：它内部 = loadAll() + saveAll()，
  // 一旦被放在滑动热路径上就是「每滑一张一次全量读 + 一次全量写」，且跑在 UI 线程上。
  // SwipePage 已改为「内存 Map 为权威副本 + 防抖合并全量写」，单条写入口再无调用者。
  // 将来若确实需要单条写，先确认调用点不在热路径上，并且手上已有一份全量 Map。

  /** 收藏池：含已上墙的（上墙是从收藏里精选，两者不是互斥状态） */
  favedIds(): string[] {
    const out: string[] = [];
    this.loadAll().forEach((d: Decision) => {
      if (d.state === 'faved' || d.state === 'walled') { out.push(d.photoId); }
    });
    return out;
  }

  walledIds(): string[] {
    const out: string[] = [];
    this.loadAll().forEach((d: Decision) => {
      if (d.state === 'walled') { out.push(d.photoId); }
    });
    return out;
  }
}
