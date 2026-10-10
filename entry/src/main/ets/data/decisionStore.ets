import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { buffer } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Decision, DecisionState } from '../core/queue';
import { errText } from '../core/atomicText';
import { writeTextAtomic } from './atomicWrite';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

// 本文件私有：与 core/claim.ts 的 claimStorePath 命名一致，但不 export
//（路径拼接是 IO 语义的一部分，core/ 保持无 IO；本任务也没有第二个调用方）。
function decisionStorePath(filesDir: string): string {
  return `${filesDir}/decisions.json`;
}

// 原子写的临时文件路径由 core/atomicText.ts 的 tmpPathOf 统一推导（真身路径 + ".tmp"），
// 本文件不再自己拼 —— 原先那个私有 tmpPathOf 随本批迁移删掉了（拼错会 rename 到别的路径）。

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
      // 必须带 e：这一支的四种成因（JSON 语法错、编码错、短读越界、fileIo 报错）在日志里
      // 长得一模一样，只有 e.message 能分开 —— 而它正是"用户已归档/收藏/上墙的决策为什么
      // 全部复活了"的答案（本批修复的 D2 里，这就是短写事故的第二现场）。
      hilog.warn(DOMAIN, TAG, '%{public}s',
        `决策文件存在但读取/解析失败，已按空状态处理（所有照片会回到队列）: ${errText(e)}`);
    }
    return m;
  }

  saveAll(m: Map<string, Decision>): void {
    const arr: Decision[] = [];
    m.forEach((v: Decision) => { arr.push(v); });
    try {
      // 原子写：先写 .tmp → **校验短写（UTF-8 字节数）** → 相等才 rename 覆盖。
      // 实现见 core/atomicText.ts（纯逻辑，有单测）+ data/atomicWrite.ets（平台适配）。
      //
      // 旧形态（本批修掉的 D2）：有 .tmp + rename，但 `fileIo.writeSync(...)` 的返回值被丢弃、
      // **无条件 rename** —— 截断的 .tmp 覆盖掉一份好决策 → 下次 loadAll() 解析抛 →
      // 空 Map → 用户已归档/收藏/上墙的决策全部"复活"。这不是"没保存"，是把好数据换成空的。
      writeTextAtomic(decisionStorePath(this.ctx.filesDir), JSON.stringify(arr), '决策');
    } catch (e) {
      // 本文件的既有契约是「落盘失败只告警不抛错」（调用点在滑动/页面退出的收尾路径上，
      // 抛出去没有任何人能接住）。日志**已经由 writeTextAtomic 打过**（含 want/got 与实际原因，
      // 以及"盘上旧文件未改动"），所以这里只把异常降级为"不抛"，不再重复打一行。
    }
  }

  // 这里刻意不再提供 set(d: Decision)（Task 8 曾有）：它内部 = loadAll() + saveAll()，
  // 一旦被放在滑动热路径上就是「每滑一张一次全量读 + 一次全量写」，且跑在 UI 线程上。
  // SwipePage 已改为「内存 Map 为权威副本 + 防抖合并全量写」，单条写入口再无调用者。
  // 将来若确实需要单条写，先确认调用点不在热路径上，并且手上已有一份全量 Map。

  /**
   * 撤销一张照片的决策（「返回上一张」用：回到刚看过的那张，让它重新可决定）。
   * 返回是否真的删掉了一条（false = 盘上本来就没有它，无需删）。
   * 注：saveAll() 内部只告警不抛错，所以 true 只保证「读到了、且已尝试落盘」。
   *
   * 为什么必须**当场写盘**、不能只改内存再等 SwipePage 的 1 秒防抖合并：
   * 撤销的正确性依赖「内存与盘同时回到未决策」。若只改内存，用户在这 1 秒内杀掉 App，
   * 盘上仍留着那条 archived / faved / walled，下次启动时 SwipePage.aboutToAppear 会把它
   * 当「已决策」过滤掉 —— 用户「回去重新决定」的意图静默失效（照片再也不会出现在队列里）。
   * 代价（已知并接受）：这里是全量读 + 全量写在 UI 线程上，与上面 set() 注释所反对的形态同类；
   * 区别在调用频率 —— 它只有 SwipePage.navigate() 一个调用点，且只在「用户主动返回上一张」
   * 这条低频路径上，不在「每滑一张」的热路径上。
   */
  remove(photoId: string): boolean {
    const m = this.loadAll();
    if (!m.has(photoId)) { return false; }
    m.delete(photoId);
    this.saveAll(m);
    return true;
  }

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
