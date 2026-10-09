/**
 * 地点索引：photoId(URI) → 拍摄时间 + GPS，**增量**构建、JSON 落盘。
 * 供 Task 10 的地图墙使用：进地图页时不必重读全部 EXIF，只读索引里还没有的照片。
 *
 * 存储层的写法**照抄 `data/decisionStore.ets`**（同一套已被两轮审查确认过的做法）：
 * UTF-8 解码、边界校验、原子写、接住 readSync 的返回值。本文件是它的第三份实现，
 * 前两份（claimStore / decisionStore）都踩过「按字节拼串 = Latin-1 解码」的坑（Ruling 24）。
 */
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { buffer } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ExifInfo } from '../core/exifParse';
import { readExif } from './exifReader';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

export interface LocationEntry {
  photoId: string;   // 就是照片 URI（选图器回传的 photoId 与 thumbUri 同源）
  lat: number;       // 十进制度；与 lon 同时为 0 = 没有 GPS（读不到或照片本来没记录）
  lon: number;
  takenAt: number;   // epoch ms；0 = 时间未知（截图/无 EXIF 是常态，不是错误）
}

export function locationIndexPath(filesDir: string): string {
  return `${filesDir}/locations.json`;
}

// 原子写的临时文件：先写它，再 rename 覆盖真身。
function tmpPathOf(filesDir: string): string {
  return `${filesDir}/locations.json.tmp`;
}

// 「正在构建」标记。**模块级**而非实例级：首页与（将来的）地图页各自 new 一个
// LocationIndex，实例级标记挡不住这两个实例并发写同一个 locations.json.tmp。
// 同一时刻只允许一次构建，并发的调用直接拿到当前盘上的索引（见 buildFrom 的取舍说明）。
let building: boolean = false;
// 当前**正在进行的构建**（promise），供 awaitIdle() 等待 —— 没有它，调用方无法区分
// 「索引已完整」与「另一处正在构建」；**勿与 doBuild 内的 `todo`（本轮待处理的 URI）混淆**。
let pendingBuild: Promise<LocationEntry[]> | undefined = undefined;

export class LocationIndex {
  private ctx: common.UIAbilityContext;

  constructor(ctx: common.UIAbilityContext) { this.ctx = ctx; }

  /**
   * 读索引。文件不存在 = 首次运行的正常路径，**静默**返回空数组；
   * 「文件在但读/解析失败」才是要告警的异常（用 statSync 成功与否区分这两件事）。
   */
  load(): LocationEntry[] {
    const path = locationIndexPath(this.ctx.filesDir);
    // 两次 statSync 是刻意的：第一次只回答「文件在不在」。
    let exists = false;
    try {
      fileIo.statSync(path);
      exists = true;
    } catch (e) {
      exists = false;
    }
    if (!exists) { return []; }

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
      // 整段解码会让 JSON.parse 失败并静默退化为空索引 —— 那意味着地图墙空白，
      // 而用户会以为"照片都没 GPS"。
      const bytes: Uint8Array = new Uint8Array(buf, 0, n);
      // save() 写的是 UTF-8，必须按 UTF-8 解码；按字节拼串等价于 Latin-1，
      // 会把非 ASCII 的 photoId 解成 mojibake，继而在 JSON.parse 处整体失败（Ruling 24）。
      const text: string = buffer.from(bytes).toString('utf-8');
      const parsed = JSON.parse(text) as LocationEntry[];
      // 数据边界层校验（Ruling 18 同类要求）：外部文件不得静默通过。
      if (!Array.isArray(parsed)) {
        hilog.warn(DOMAIN, TAG, '%{public}s', 'locations.json 不是数组，已按空索引处理');
        return [];
      }
      const out: LocationEntry[] = [];
      let skipped = 0;
      for (let i = 0; i < parsed.length; i++) {
        const e = parsed[i];
        if (e === null || e === undefined) { skipped = skipped + 1; continue; }
        // photoId 是索引的键：没有它这条记录无法归属到任何照片，只能整条丢掉。
        if (typeof e.photoId !== 'string' || e.photoId === '') { skipped = skipped + 1; continue; }
        // 坐标与时间是**可选**信息：非有限数一律置 0，**不跳过整条** ——
        // 没有 GPS 是照片的常态（截图、关闭定位时拍的），不是数据损坏。
        // 置 0 而不是保留 NaN，是因为 NaN 经 JSON.stringify 会写成 null，读回来又是 0，两轮不一致。
        out.push({
          photoId: e.photoId,
          lat: typeof e.lat === 'number' && Number.isFinite(e.lat) ? e.lat : 0,
          lon: typeof e.lon === 'number' && Number.isFinite(e.lon) ? e.lon : 0,
          takenAt: typeof e.takenAt === 'number' && Number.isFinite(e.takenAt) ? e.takenAt : 0
        });
      }
      if (skipped > 0) {
        hilog.warn(DOMAIN, TAG, '%{public}s', `地点索引中有 ${skipped} 条非法记录，已跳过`);
      }
      return out;
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '%{public}s', '地点索引文件存在但读取/解析失败，已按空索引处理');
      return [];
    }
  }

  /**
   * 原子写：先写 `.tmp`，再 rename 覆盖；写到一半失败不会留下半个文件（内部只告警不抛错）。
   * 失败时可能残留一个 `locations.json.tmp`：无害，下次 save 用 TRUNC 打开它即被覆盖。
   */
  save(list: LocationEntry[]): void {
    const dir = this.ctx.filesDir;
    const tmp = tmpPathOf(dir);
    try {
      const file = fileIo.openSync(tmp,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(list));
      } finally {
        fileIo.closeSync(file);
      }
      fileIo.renameSync(tmp, locationIndexPath(dir));
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '%{public}s', '地点索引落盘失败');
    }
  }

  /**
   * 增量构建：只读 `uris` 里**索引还没有**的那些，读到的并入内存，最后**一次性** save。
   *
   * @param uris 关心的照片 URI（通常是本次会话的队列）。可含重复项，也允许含已索引的项。
   * @param onProgress 每读完一张回调一次 `(已完成, 本批待读总数)`；不传就不回调。
   *        它是 UI 侧唯一能知道"还要多久"的入口（本方法刻意不碰任何 UI 状态）。
   * @returns 合并后的全量索引（顺序 = 原有条目在前、本批新读的在后）。
   *
   * 关于「几百张会不会卡」（控制器的追问）：
   * - 每次 `await readExif` 都会让出事件循环，所以**不会长时间霸占 UI 线程**（本方法本身是 async）；
   * - 但整批是**串行**的：几百张 × 每张「open + getImageProperties + release」，总耗时是秒级到十几秒，
   *   期间没有任何取消机制。这可以接受，因为它是后台性质的工作、结果只影响地图墙，
   *   而且**只发生一次** —— 之后每张都在索引里，`todo` 为空，直接返回。
   * - `todo` 为空时（重进刷卡页的常态）**不重写文件**，省掉一次全量写。
   *
   * **契约（两条，务必看清）**：
   * 1. **并发时返回快照**：若已有一次构建在跑（`building` 闸门），本次调用**不等待、不抛错**，
   *    直接返回"此刻盘上有什么"。因此**返回值不承诺覆盖你传进来的 `uris`** ——
   *    它只保证"这是一份形状合法的索引"，**不保证**"这是一份完整的索引"。
   * 2. **需要完整索引的调用方必须用 `awaitIdle()`**：先 `await buildFrom(pool)` 触发补读，
   *    再 `await awaitIdle()` 拿稳定结果。**不要**拿本方法的返回值当"等到了"的证据：
   *    并发时它秒回局部数据，而且**不会有任何报错**，症状只会是"地图上少照片"。
   *
   * 已知取舍（都记在报告里）：
   * - 读不到 EXIF 的照片**也会入索引**（时间/坐标全 0）。这是"缓存"的语义：不记录就等于每次
   *   启动都要重读一遍截图。代价是**没有 TTL / 重试**：若某次读失败是暂时的，那张照片
   *   不会再被重新解析。索引是纯缓存，删掉 locations.json 即可全量重建。
   * - 并发调用**已被 `building` 标记挡住**（见方法体开头）：同一时刻只有一次构建在跑，
   *   另一次立即返回当前盘上的索引而非排队/抛错。这样两次构建不会争同一个 `.tmp`，
   *   也不会出现「后写的覆盖先写的」，更不会退化成空。代价是并发的那次**少读一批 EXIF**，
   *   要等下一次调用才补上 —— 索引最终仍然是整个池子的并集（调用方的每次开局都会调一次）。
   */
  async buildFrom(uris: string[], onProgress?: (done: number, total: number) => void): Promise<LocationEntry[]> {
    if (building) {
      // 已有一次构建在进行：返回当前快照，不并发写同一个 .tmp。
      // 需要"完整索引"的调用方应改用 awaitIdle()，而不是依赖本方法的返回值 ——
      // 这里的返回值只是"此刻盘上有什么"，不承诺覆盖 uris。
      hilog.info(DOMAIN, TAG, '%{public}s', '地点索引正在构建中，本次调用跳过（返回当前盘上的索引）');
      return this.load();
    }
    // 上面的「检查」与这里的「置位」之间**没有 await**：单线程事件循环下这一段是原子的，
    // 两次并发调用不可能同时通过检查 —— 这正是这个标记成立的全部依据，不要在其中插入异步。
    building = true;
    // 从调用 doBuild 到 `pendingBuild = run` 之间**同样没有 await**：所以"看得见 building 为真"
    // 的观察者一定也看得见 pendingBuild 非空（awaitIdle 的循环依赖这一点，它另有防御条件）。
    const run: Promise<LocationEntry[]> = this.doBuild(uris, onProgress);
    pendingBuild = run;
    try {
      return await run;
    } finally {
      // **必须**放 finally：一旦某次构建抛错而标记没复位，索引就永远无法再构建了
      //（那比"并发写坏一次、下次重建"严重得多 —— 它是永久性的）。
      // 注意此处只复位标记，不做任何等待：finally 在 return 之前同步执行。
      // 复位 building 与 pendingBuild 是同一个同步块里的两行、中间没有 await，因此不存在
      //「building 已假、pendingBuild 还留着旧 promise」这种会被 awaitIdle 观察到的中间态。
      building = false;
      pendingBuild = undefined;
    }
  }

  /**
   * 等到「当前没有构建在进行」，然后返回盘上的索引。
   *
   * 与 buildFrom 的区别（**这是本方法存在的唯一理由**）：
   *   - `buildFrom` 在并发时**返回快照**（不阻塞、不抛错），其返回值**不承诺覆盖你传的 uris**；
   *   - `awaitIdle` 承诺「返回时没有别的构建在跑」，因此结果**涵盖此前所有已提交的构建**。
   *
   * 调用方（地图页）应：先 `await buildFrom(pool)` 触发补读，再 `await awaitIdle()` 拿稳定结果。
   * 若本来就没有构建在进行，`awaitIdle()` 立即返回（一次 `load()` 的开销）。
   */
  async awaitIdle(): Promise<LocationEntry[]> {
    // 用 while 而不是 if：等待期间可能**又**有新的构建开始，那就必须接着等 ——
    // 用 if 只等一轮，会在"另一个构建还在跑"的时候返回，正是本方法要消灭的"看起来等过了"。
    while (building && pendingBuild !== undefined) {
      try {
        await pendingBuild;
      } catch (e) {
        // 别人构建失败**不该**让 awaitIdle 抛错：否则地图页会因为一次与它无关的失败而白屏。
        // 吞掉即可 —— finally 已经把 building 复位，下一轮循环条件必为假、正常退出，
        // 调用方拿到的是"此刻盘上有什么"（与并发时 buildFrom 的返回值同一语义，不是错误）。
        hilog.warn(DOMAIN, TAG, '%{public}s', '等待地点索引构建时，正在进行的构建失败（已忽略，返回盘上索引）');
      }
    }
    // 从"循环条件为假"到这里**没有 await**：单线程事件循环下，「确认没人构建」与「读盘」
    // 之间插不进一个新的构建 —— 这就是"返回时没有别的构建在跑"这个承诺的依据。
    return this.load();
  }

  /**
   * 真正的构建逻辑：原 buildFrom 的方法体**整体挪到这里、内容一字未改**
   *（只是不再自带 try/finally —— 闸门的置位与复位留在 buildFrom，见那里的注释）。
   */
  private async doBuild(uris: string[], onProgress?: (done: number, total: number) => void): Promise<LocationEntry[]> {
    const existing: LocationEntry[] = this.load();
    const byId: Map<string, LocationEntry> = new Map();
    for (let i = 0; i < existing.length; i++) {
      byId.set(existing[i].photoId, existing[i]);
    }
    // 局部 `todo` = 本轮待办（索引里还没有的 URI），顺带去重（入参可能含重复 URI）。
    // 这里先往 byId 放一条全 0 的**占位**，有两个作用：
    //   ① 后面重复出现的同一个 URI 会被上面的 byId.has 挡掉（不必再引入一个 Set 去重）；
    //   ② 新条目在 Map 里的**位置**此刻就定下来（Map.set 覆盖已有键不改变顺序），
    //      于是最终列表恒为「原有条目在前、本批新读的在后」，与读取顺序一致。
    // 占位在下面读完 EXIF 后会被真实值覆盖；若 readExif 意外抛错，占位也不会落盘
    //（异常会直接冲出本方法，save 不会执行 —— readExif 的契约是不抛，这里只是兜底推理）。
    const todo: string[] = [];
    for (let i = 0; i < uris.length; i++) {
      const u = uris[i];
      if (u === undefined || u === null || u === '') { continue; }
      if (byId.has(u)) { continue; }
      byId.set(u, { photoId: u, lat: 0, lon: 0, takenAt: 0 });
      todo.push(u);
    }
    if (todo.length === 0) {
      // 全都在索引里了：不写盘、不回调（没有进度可言）
      return existing;
    }

    const total: number = todo.length;
    for (let i = 0; i < todo.length; i++) {
      const uri: string = todo[i];
      // readExif 内部吞掉所有异常（读不到 → 全 0），所以这里不会再抛：
      // 一张坏照片不该让整批索引构建失败。
      const info: ExifInfo = await readExif(uri);
      byId.set(uri, { photoId: uri, lat: info.lat, lon: info.lon, takenAt: info.takenAt });
      if (onProgress !== undefined) { onProgress(i + 1, total); }
    }

    const list: LocationEntry[] = [];
    byId.forEach((e: LocationEntry) => { list.push(e); });
    this.save(list);
    return list;
  }
}
