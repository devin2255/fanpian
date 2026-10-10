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
import { writeTextAtomic } from './atomicWrite';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

/**
 * 把 catch 到的值转成一行可打印文本。**本文件所有告警都用它**。
 *
 * 为什么需要它：ArkTS 禁 `any`，catch 参数不能当 any 用，要取 `message` 必须显式转换；
 * 同时又**不能假设抛出来的都是 Error**（fileIo 抛的是 BusinessError —— 它是 Error 的子类，
 * 但 SDK 违约路径上什么都可能抛）。非 Error 时退化成 `JSON.stringify(e)`：
 * 至少保证日志里留下一行能搜的东西，而不是 `undefined`。
 *
 * 只打 message 不打 code 是够的：fileIo 的 BusinessError 把 errno 描述直接写在 message 里
 *（13900025 → "No space left on device"），区分「磁盘满」与「I/O 错误」不需要再取 code
 *（取 code 要 import BusinessError，见本文件写侧不做多余 import 的取舍）。
 */
function errText(e: Object): string {
  if (e instanceof Error) { return e.message; }
  return JSON.stringify(e);
}

export interface LocationEntry {
  photoId: string;   // 就是照片 URI（选图器回传的 photoId 与 thumbUri 同源）
  lat: number;       // 十进制度；与 lon 同时为 0 = 没有 GPS（读不到或照片本来没记录）
  lon: number;
  takenAt: number;   // epoch ms；0 = 时间未知（截图/无 EXIF 是常态，不是错误）
  /**
   * 这个地点是**用户自己在「上墙」时手选的**（省 → 市 → 县三级下拉），不是 EXIF 读出来的。
   *
   * 语义（三条，写清楚是为了不让这个字段的含义发散）：
   *   1) `true` = 手选。坐标是内嵌区划数据里的**县级中心点**，坐标系是 **GCJ-02**
   *      （与 areaData.ts 一致，那里明确不做转换）。
   *   2) 缺省 / `false` / 非布尔值 = **来自 EXIF 的 GPS**，坐标系是 **WGS-84**。
   *      两者的偏差约 300~500 米 —— 所以这个标记同时也是"这条坐标是哪个坐标系"的唯一线索，
   *      将来若要把手选地点精确落点，必须按它选转换方向。
   *   3) **优先级：手动 > EXIF**。用户亲手选的地点是他对这个记忆的定性
   *      （"这张是在老家拍的"），不是坐标精度问题；所以：
   *        · 判"有没有地点"以它为准（core/placePick.ts 的 hasPlace，规则只在那里定义）；
   *        · **重建索引时不得覆盖它**（见 doBuild 的两道防线）。
   *
   * 为什么是可选字段而不是另开一份「手动地点表」：手动与 EXIF 是**同一条记录的两个来源**，
   * 一个 photoId 只有一个地点。分两份存会让"这张到底在哪"有两个答案，而两份答案迟早打架。
   */
  manual?: boolean;
  /**
   * 地点的**显示名**，如「河北·石家庄·正定」「上海·浦东」。**唯一产出者**是
   * `core/placePick.ts` 的 `formatPlace`（格式规则只在那里定义，别处不要拼）。
   *
   * 语义（三条，写清楚是为了不让这个字段的含义发散）：
   *   1) **手动选择时由用户的选择直接写入**（`PlaceStore.setManual` 落盘）。为什么必须存下来
   *      而不是用 `nearestCounty` 反查：反查是**近似**（最近的县中心 ≠ 用户选的那个县，
   *      省界/县界附近会选错），而且每次要多扫一遍 2851 个县的全表；用户**明确选过**那个县，
   *      把名字直接存下来是最忠实的。
   *   2) **EXIF 来源的条目通常没有这个字段**（读盘时是 `undefined`，因此 `JSON.stringify`
   *      不会写出去，文件不会被一堆 `"place":""` 撑大）。地图墙遇到没有名字的钉子，
   *      可以退回用 `nearestCounty(lat, lon)` 反查一个近似名 —— 那是**退化路径**，不是默认路径。
   *   3) **本批之前写入的条目也没有这个字段**（本批升级前落盘的 239 条手动地点全部只有坐标）。
   *      缺这个字段是**正常**的，所以读侧的校验对它**不告警**（与 manual 的分级不同，见 load）。
   *
   * 与 `manual` 的关系：`place` 只在 `manual === true` 的条目上有意义（EXIF 条目的名字由地图墙
   * 自己反查）。但读侧**不**把两者绑定校验 —— 名字与坐标的来源判断是两件事，混在一起
   * 会让"升级前写入的旧条目"这类正常数据落进告警分支。
   */
  place?: string;
}

export function locationIndexPath(filesDir: string): string {
  return `${filesDir}/locations.json`;
}

// 原子写的 `.tmp` 路径由 core/atomicText.ts 的 tmpPathOf 统一推导（真身路径 + ".tmp"）：
// 原先本文件私有的 tmpPathOf 随本批迁移删掉了（它拼出来的仍是 `locations.json.tmp`，逐字相同）。

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
        // 不是异常、没有 e 可打：带上**实际类型**，否则真机上只能看到一句"不是数组"。
        // （`JSON.parse('null')` 与 `'"x"'` 都落在这一支，两者要能分开。）
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `locations.json 顶层不是数组（实际是 ${typeof parsed}），已按空索引处理`);
        return [];
      }
      const out: LocationEntry[] = [];
      let skipped = 0;
      // 跳过有两种成因，分开计数：真机上"有 12 条非法"没法下手，得知道是整条为 null
      // 还是 photoId 缺失（后者通常意味着写入方改了字段名）。
      let skippedNoId = 0;
      // manual 字段**存在但不是布尔值**的条数。它与上面两种"整条丢掉"**分级不同**：
      // 这一种只丢标记、保留条目（坐标与时间仍然是有效信息）。分开计数是为了让告警
      // 能说清"丢了什么"——把"丢了一个标记"和"丢了一条记录"混成一句，真机上无法定位。
      let badManual = 0;
      // place 字段**存在但不是非空字符串**的条数。分级与 badManual 相同（丢字段、留条目），
      // 但**必须单独计数**：两者是不同字段的错误，混在一起就分不清写侧到底写坏了哪一个。
      // 注意它与"**根本没有 place 字段**"是两回事：后者是**正常**数据（EXIF 条目、以及本批
      // 升级前写入的旧条目），一条都不计数、一个字都不告警（见下面 for 里的分支）。
      let badPlace = 0;
      for (let i = 0; i < parsed.length; i++) {
        const e = parsed[i];
        if (e === null || e === undefined) { skipped = skipped + 1; continue; }
        // photoId 是索引的键：没有它这条记录无法归属到任何照片，只能整条丢掉。
        if (typeof e.photoId !== 'string' || e.photoId === '') {
          skipped = skipped + 1;
          skippedNoId = skippedNoId + 1;
          continue;
        }
        // 坐标与时间是**可选**信息：非有限数一律置 0，**不跳过整条** ——
        // 没有 GPS 是照片的常态（截图、关闭定位时拍的），不是数据损坏。
        // 置 0 而不是保留 NaN，是因为 NaN 经 JSON.stringify 会写成 null，读回来又是 0，两轮不一致。
        //
        // manual 只认**严格等于 true**：`"yes"` / `1` / `"true"` 一律当成"来自 EXIF"。
        // 反过来（宽松真值转换）会让一条 EXIF 记录凭空变成不可覆盖的"手选地点"——
        // 那是**不可逆**的走样：用户没选过，而以后再也不会用 EXIF 更新它。
        // 宁可在这一侧保守：丢一个标记的代价是"下次重建时可能被 EXIF 覆盖"，
        // 而乱认一个标记的代价是"这条地点永远错了且无人知道"。
        if (e.manual !== undefined && typeof e.manual !== 'boolean') { badManual = badManual + 1; }
        // place（显示名）也是**可选**字段，但它的校验口径与 manual **刻意不同**：
        //   · 字段整个不存在 → **正常**（EXIF 条目、升级前写入的旧条目）→ 不计数、不告警；
        //   · 字段在但不是非空字符串（数字 / 布尔 / 对象 / 空串 / 纯空白）→ 写侧写坏了 → 计数告警，
        //     但**照旧保留条目**（坐标与时间仍然有效，只是地图上这个钉子暂时没有名字，
        //     读侧可退回 nearestCounty 反查）。
        // 空串一律当"没有名字"处理、而不是原样存成 `''`：`''` 落盘后读回来仍是 `''`，
        // 地图墙要判两次（undefined 与空串）才敢决定"要不要反查" —— 一个字段两种"空"
        // 是 bug 的温床（"没有名字"只该有一种表示）。
        let placeVal: string | undefined = undefined;
        if (typeof e.place === 'string' && e.place.trim() !== '') {
          placeVal = e.place;
        } else if (e.place !== undefined) {
          badPlace = badPlace + 1;
        }
        out.push({
          photoId: e.photoId,
          lat: typeof e.lat === 'number' && Number.isFinite(e.lat) ? e.lat : 0,
          lon: typeof e.lon === 'number' && Number.isFinite(e.lon) ? e.lon : 0,
          takenAt: typeof e.takenAt === 'number' && Number.isFinite(e.takenAt) ? e.takenAt : 0,
          // undefined 不会被 JSON.stringify 写出去，所以"来自 EXIF"的条目在盘上**没有这个键**，
          // 文件不会被一堆 `"manual":false` 撑大（3210 条索引里绝大多数是 EXIF 条目）。
          manual: e.manual === true ? true : undefined,
          // 同上：`undefined` 不落盘 → EXIF 条目与"名字已丢弃"的条目在盘上**都没有 place 键**，
          // 只有真正有名字的条目才多一个键（升级前写入的 239 条旧条目读进来仍是 5 个键，
          // 只有它们下次被手选覆盖时才会多出 place）。
          place: placeVal
        });
      }
      if (skipped > 0) {
        // 这一处不是异常、拿不到 e：给**分类计数**当上下文（见上面两个计数器的注释）。
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `地点索引中有 ${skipped} 条非法记录，已跳过（其中 ${skippedNoId} 条 photoId 缺失/非字符串，` +
          `${skipped - skippedNoId} 条整条为 null/undefined）`);
      }
      if (badManual > 0) {
        // 与上面分级不同：条目保留、只丢标记。所以单独一条告警，不混进"已跳过"里。
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `地点索引中有 ${badManual} 条的 manual 字段不是布尔值，已按"来自 EXIF"处理（条目保留、标记丢弃）`);
      }
      if (badPlace > 0) {
        // 同样单独一条：写坏的字段不同（place 而不是 manual），真机上要能一眼分开。
        // 触发它的只可能是写侧出错 —— **升级前写入的旧条目不会走到这里**（那些条目压根没有
        // place 键，走的是"不存在 → 不计数"那一支），所以这条告警一旦出现就是真问题。
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `地点索引中有 ${badPlace} 条的 place 字段不是非空字符串，已丢弃该字段（条目保留、坐标与时间不受影响）`);
      }
      return out;
    } catch (e) {
      // 必须带 e：这一支的四种成因（JSON 语法错、编码错、短读越界、fileIo 报错）
      // 在日志里长得一模一样，只有 e.message 能分开 —— 而它正是"索引为什么空了"的答案。
      hilog.warn(DOMAIN, TAG, '%{public}s', `地点索引文件存在但读取/解析失败，已按空索引处理: ${errText(e)}`);
      return [];
    }
  }

  /**
   * 原子写：先写 `.tmp`，**校验短写**，只有字节数完全相等才 rename 覆盖真身；
   * 任何一步失败都不会留下半个文件（内部只告警不抛错）。
   *
   * 本方法原本是本仓库**唯一**写对的那个实现，这份注释就是全项目的范本：
   * 短写（POSIX 语义下 ENOSPC 等可以短计数而**不抛**）若不检出，截断的 `.tmp` 会覆盖掉
   * 一份好索引 → 下次 `load()` 的 JSON.parse 抛错 → 告警 → 返回空索引 → 地图墙空白，
   * 而用户会以为"照片都没 GPS"（正是读侧短读要防的那个最坏后果，换到了写侧）。
   *
   * 本批把这段逻辑**原样**搬到了 core/atomicText.ts（纯逻辑，可单测）+
   * data/atomicWrite.ets（平台适配），因为另外三个 store 要么没有 `.tmp`、要么不校验短写。
   * 迁移后的行为逐项对齐（见报告"迁移矩阵"）：
   *   · `.tmp` 路径：`locations.json.tmp`（tmpPathOf = 真身路径 + ".tmp"，与原来拼出来的完全一致）；
   *   · 字节数比对：仍是 UTF-8 字节数（core 的 utf8ByteLength，并与 buffer.from(text).length 交叉校验）；
   *   · rename 只在 `w === want` 时执行，且**在 close 之后**（close 负责把写缓冲刷下去）；
   *   · 失败只告警不抛错（方法签名与调用方契约不变）。
   * 唯二的可见差异（都写进报告）：告警文本多了"盘上旧文件未改动"六个字（前缀不变，仍可 grep）；
   * 以及 `JSON.stringify` 从 openSync 之后移到了之前（对 LocationEntry[] 不可观测）。
   */
  save(list: LocationEntry[]): void {
    try {
      writeTextAtomic(locationIndexPath(this.ctx.filesDir), JSON.stringify(list), '地点索引');
    } catch (e) {
      // 与 load() 的既有契约一致：只告警不抛错（本方法的调用方 PlaceStore.setManual 不接异常）。
      // 日志已经由 writeTextAtomic 打过（含期望/实际字节数与"盘上旧文件未改动"），不重复打。
    }
  }

  /**
   * 增量构建：只读 `uris` 里**索引还没有**的那些，读到的并入内存，最后**一次性** save。
   *
   * @param uris 关心的照片 URI = **整个已授权池**（`ClaimStore.load()` 里的**全部** `photoId`），
   *        **不是**本次会话抽中的那几十张。必须传整池：地图墙（Task 10）要渲染**全部**照片，
   *        只索引一局会让**未抽中**的那些照片在地图上消失 —— 那正是批 26 修掉的缺陷
   *        （当时的 @param 写的是"通常是本次会话的队列"，照它传 `session.queue` 就会复现）。
   *        可含重复项，也允许含已索引的项。
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
    // 上面的「检查」与下面的「置位」之间**没有 await**：单线程事件循环下这一段是原子的，
    // 两次并发调用不可能同时通过检查 —— 这正是这个标记成立的全部依据，不要在其中插入异步。
    //
    // **置位必须是 try 的第一行**（不是 try 之前）：否则将来若有语句插在置位与 try 之间并抛错，
    // `building` 就**永久为真** —— 之后每次 buildFrom 都走上头的"并发快照"分支秒回，
    // awaitIdle 因 while 条件立即为假而直接返回，症状是**静默"少照片"且永不报错**
    //（比"并发写坏一次、下次重建"严重得多：它是永久性的）。放进 try 后，任何抛错都经过 finally 复位。
    try {
      building = true;
      // 从 `building = true` 到 `pendingBuild = run` 之间**同样没有 await**（两者都在 try 内、
      // 都在第一个 await 之前）：所以"看得见 building 为真"的观察者一定也看得见 pendingBuild 非空
      //（awaitIdle 的循环依赖这一点，它另有防御条件）。
      const run: Promise<LocationEntry[]> = this.doBuild(uris, onProgress);
      pendingBuild = run;
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
        // 但要带上 e：这是"构建为什么失败"唯一能被记下来的地方（少了它，真机上只剩
        // 一句"构建失败"，与"什么都没读到"无法区分）。
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `等待地点索引构建时，正在进行的构建失败（已忽略，返回盘上索引）: ${errText(e)}`);
      }
    }
    // 从"循环条件为假"到这里**没有 await**：单线程事件循环下，「确认没人构建」与「读盘」
    // 之间插不进一个新的构建 —— 这就是"返回时没有别的构建在跑"这个承诺的依据。
    return this.load();
  }

  /**
   * 此刻是否有一次构建在跑。**只读查询**，给 UI 用：上墙流程在等待索引之前先用它决定
   * 要不要提示用户"正在读取照片地点信息"（等待只在这一支里可能长达数秒）。
   *
   * **不要**用它代替 `awaitIdle()`：它只是某一瞬间的快照，读到它到用它之间就可能过期
   *（构建刚启动/刚结束）。判"索引稳定了没有"的唯一正确做法仍然是 `await awaitIdle()`。
   */
  isBuilding(): boolean {
    return building;
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
      // ── 手选地点的**第二道**防线：EXIF 绝不覆盖它 ──────────────────────────
      // 第一道防线在 todo 的构造处（手选条目本来就在索引里 → 不进 todo，见上面的占位循环）。
      // 两道都留着，因为这一条的代价是**不可逆的用户数据丢失**：手选地点被 EXIF 坐标盖掉之后，
      // 用户没有任何入口知道这件事发生过（他只会发现"老家"变成了别的地方，或者地图上跑偏），
      // 而"手动 > EXIF"正是本功能的全部意义（见 LocationEntry.manual 的注释）。
      // 这一支在今天不可达（todo 已排除索引里有的 URI）；它挡的是将来有人改 todo 的构造方式
      //（例如为了"让 EXIF 更准"而改成"每轮全量重读"）——那时这里会接住，而不是静默丢数据。
      const prev: LocationEntry | undefined = byId.get(uri);
      if (prev !== undefined && prev.manual === true) {
        byId.set(uri, prev);   // 原样保留（坐标、时间、manual 一个都不动）
      } else {
        byId.set(uri, { photoId: uri, lat: info.lat, lon: info.lon, takenAt: info.takenAt });
      }
      if (onProgress !== undefined) { onProgress(i + 1, total); }
    }

    // ── 收尾前重新读盘：把「构建期间用户手选的地点」并回来 ─────────────────────
    // 为什么必需：本方法开头 load() 拿到一份快照，随后**逐张 await readExif**（几百张 =
    // 秒级到十几秒，见 buildFrom 的说明）。这段时间里用户在刷卡页点「上墙」并选好了地点，
    // PlaceStore 会把那条 manual 写进**同一个文件**；而下面这次 save(list) 是**全量写**，
    // 写的正是"本方法开头那份快照 + 本批读到的 EXIF" —— 用户刚选的地点会被静默抹掉。
    // 这不是理论风险：buildFrom 刻意不被 await（见 pages/ClaimPage.ets），索引构建与用户刷卡
    // 是**并发**的，这正是 awaitIdle 存在的理由。
    // 只并回 manual 条目：非 manual 条目以本次构建的结果为准（它读的就是最新的 EXIF）。
    // 顺序无关性（为什么不必担心"反过来被覆盖"）：PlaceStore.setManual 内部 load → upsert
    // → save 三步之间**没有 await**，所以它在事件循环里是原子的、不可能被本方法的 save 插进来；
    // 而本方法这次 save 一定在它之后或之前**整体**发生，两种次序的最终结果都由这段合并收敛。
    const onDisk: LocationEntry[] = this.load();
    for (let i = 0; i < onDisk.length; i++) {
      const d: LocationEntry = onDisk[i];
      if (d.manual !== true) { continue; }
      const cur: LocationEntry | undefined = byId.get(d.photoId);
      if (cur !== undefined && cur.manual === true) { continue; }   // 同一份手选地点，不必覆盖
      byId.set(d.photoId, d);
    }

    const list: LocationEntry[] = [];
    byId.forEach((e: LocationEntry) => { list.push(e); });
    this.save(list);
    return list;
  }
}
