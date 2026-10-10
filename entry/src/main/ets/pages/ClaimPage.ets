import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ClaimStore, pickPhotos } from '../data/claimStore';
import { DecisionStore } from '../data/decisionStore';
import { LocationIndex, LocationEntry } from '../data/locationIndex';
import { SessionStore, setSession } from '../data/sessionStore';
// 以下 import 是为了把 core 层留在 ArkTS 编译图内（Ruling 17）。
// 重要：必须出现在「值位置」——只当类型用会被 ArkTS 擦成 type-only import，
// 那些模块就不会被编译，而构建照样 BUILD SUCCESSFUL（假绿）。
// 判定真伪：编译后检查 entry/build/.../ets/core/<name>.protoBin 是否存在。
// 本页现在**真正**消费 core/session.ts（sampleSession / DEFAULT_SESSION_SIZE /
// SESSION_SIZE_CHOICES 都在值位置），所以它的 protoBin 必须出现；其余几个模块仍只靠
// 下面的守卫字段留在图里，那些字段**不要删**。
import { ClaimState, emptyClaimState } from '../core/claim';
import { GeoPoint, haversineMeters } from '../core/geo';
import { computeLayout, PlacedPin, PinLayout } from '../core/placement';
import { projectMercator, CHINA_REGION, Projected } from '../core/projection';
import { applyDecision, emptyDecision, Action, Decision } from '../core/queue';
import { emptyMetrics, MetricsState, medianDecisionMs } from '../core/metrics';
import { DEFAULT_SESSION_SIZE, SESSION_SIZE_CHOICES, sampleSession, SwipeSession } from '../core/session';

// 「上次选的张数」在 AppStorage 里的键：刷照片页的「继续刷 N 张」会回到本页并要求
// **预选同一张数**。主路径上本页不会被重建（router.back() 回到栈里的实例，@State 原样保留），
// 但万一被重建（将来若改成 pushUrl / 换启动方式），@State 会重置成默认的 100 张，
// 「预选同一张数」就静默失效了。存一份到 AppStorage 让它在任何重建路径下都成立。
const SIZE_KEY = 'sessionSize';

/**
 * 把 catch 到的值渲染成一句**用户可见**的失败文案。
 *
 * 为什么需要它（本页修掉的缺陷）：原来两处 catch 都写
 *     `const err = e as BusinessError; this.msg = `…失败：${err.code} ${err.message}`;`
 * 而 **`code` 只有 BusinessError 才有**。本页的 catch 里冒出普通 `Error` 不是意外，是常态：
 * `restock` 的 catch 包住 `claimStore.addBatch` → `data/atomicWrite.ets` 的 `writeTextAtomic`，
 * 它失败时抛的是 `new Error('认领列表落盘失败: …')` —— 普通 Error，**没有 `code` 字段**。
 * 于是用户看到的是
 *     `选图失败：undefined 认领列表落盘失败: writeSync 短写：期望 N 字节，实际写入 M 字节`
 * ——一个凭空出现的 "undefined" 顶在真正的原因前面，把唯一有用的信息挤到后面。
 *
 * 规则（本页所有面向用户的失败文案统一走这里）：
 *   · **`message` 是主文案** —— 普通 Error 与 BusinessError 都有它，而且本项目所有失败原因
 *     （含 `writeTextAtomic` 的 want/got）都写在 message 里；
 *   · **`code` 只在确实是数字时**作为补充附在末尾。它不是"所有异常的必有字段"，
 *     所以这里用 `typeof` 收窄（写法同 `data/claimStore.ets` 的 `typeof p.batchId === 'number'`），
 *     保证"没有 code"这条路径下文案里**不会**出现 `undefined`。
 *
 * 与 `core/atomicText.ts` / `data/locationIndex.ets` / `data/metricsStore.ets` 的 `errText`
 * 同一口径（`e instanceof Error` 优先，非 Error 退化成 `JSON.stringify`），
 * 差别只在于这里要塞进 UI 文案而不是日志，所以要额外带上 code。
 */
function failureMsg(e: Object): string {
  if (e instanceof Error) {
    // BusinessError 是 Error 的子类（`interface BusinessError extends Error { code: number }`）。
    // 注：本行只是把 `message`/`code` 读出来，**不改变任何控制流** ——
    // 该中断的仍然中断、该回退的仍然回退，此处只负责把异常渲染成一句人话。
    const err = e as BusinessError;
    if (typeof err.code === 'number') {
      return `${err.message}（错误码 ${err.code}）`;
    }
    return err.message;
  }
  // 非 Error（SDK 违约路径上什么都可能抛）：至少留下一行能搜的东西，而不是 "undefined"。
  return JSON.stringify(e);
}

@Entry
@Component
struct ClaimPage {
  @State claimed: number = 0;
  @State msg: string = '';
  // 默认 100（产品口径：默认 100，可选 20/50/100/200）
  @State selectedSize: number = DEFAULT_SESSION_SIZE;
  // 「开始刷照片」的**防重入闸门**。连点两次会在第一次的 await 期间再进一次 startSession：
  // 两次都会抽样、都会 pushUrl，并且都会各起一次地点索引构建 —— 后者是两条并发写同一个
  // locations.json.tmp 的构建（见 data/locationIndex.ets 的 building 标记）。
  // 置真期间按钮禁用，用户能直接看到"正在准备"。
  @State starting: boolean = false;
  private ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
  private store: ClaimStore = new ClaimStore(this.ctx);

  // ── 编译图守卫（Ruling 17）──────────────────────────────
  // 这些字段只为让 core/*.ts 进入 ArkTS 模块图，业务上不使用。
  // 若将来 ClaimPage 真正消费了这些模块，可以把这些守卫字段删掉。
  private claimShape: ClaimState = emptyClaimState();
  private homePoint: GeoPoint = { lat: 31.2495, lon: 121.4813 };
  private homeToBeijingM: number =
    haversineMeters({ lat: 31.2495, lon: 121.4813 }, { lat: 39.9042, lon: 116.4074 });
  private homeOnMap: Projected =
    projectMercator(121.4813, 31.2495, 900, 700, CHINA_REGION.bounds);
  private guardPins: PlacedPin[] = [{ pinId: 'p1', x: 100, y: 100 }];
  private guardCounts: Map<string, number> = new Map<string, number>([['p1', 5]]);
  private guardLayout: PinLayout[] = computeLayout(this.guardPins, this.guardCounts, 1);
  private guardAction: Action = 'fav';
  private guardDecision: Decision = applyDecision(emptyDecision('guard'), this.guardAction, 0);
  private guardMetrics: MetricsState = emptyMetrics();
  private guardMedianMs: number = medianDecisionMs(this.guardMetrics);

  aboutToAppear(): void {
    this.claimShape = this.store.load();
    this.claimed = this.claimShape.photos.length;
    // 恢复上次用的张数。用 indexOf 对着 SESSION_SIZE_CHOICES 校验，而不是只看 isFinite：
    // 选项集之外的值（旧版本写进去的、或被别处改坏的）会让四个按钮**一个都不高亮**，
    // 界面看起来像坏了；不合法就老实用默认值。
    const saved: number | undefined = AppStorage.get<number>(SIZE_KEY);
    if (saved !== undefined && SESSION_SIZE_CHOICES.indexOf(saved) >= 0) {
      this.selectedSize = saved;
    }
  }

  build() {
    Column({ space: 16 }) {
      Text('照片墙').fontSize(26).fontWeight(FontWeight.Bold)
      Text(`已认领 ${this.claimed} 张照片`).fontSize(15).fontColor('#666')
      Text('选一个张数，直接开始刷照片。照片从这个池子里随机抽给你；池子不够时会自动打开系统相册补充。')
        .fontSize(13).fontColor('#999').textAlign(TextAlign.Center).padding({ left: 32, right: 32 })

      // 张数选择用「一排按钮」而不是 Select 下拉框，理由见报告：
      // 只有 4 个选项，平铺可以一眼看全 + 一次点击选中（下拉要先展开再选，多一次点击）；
      // 且选中态直接高亮在按钮上，「默认 100」这条产品口径不需要展开控件就能确认。
      Text('这次刷多少张').fontSize(13).fontColor('#666')
      Row({ space: 8 }) {
        ForEach(SESSION_SIZE_CHOICES, (n: number) => {
          Button(`${n}`)
            .fontSize(14).height(38).layoutWeight(1)
            .backgroundColor(this.selectedSize === n ? '#1F6FEB' : '#E6E6E6')
            .fontColor(this.selectedSize === n ? '#FFFFFF' : '#333333')
            .onClick(() => { this.chooseSize(n); })
        }, (n: number) => `${n}`)
      }
      .width('100%').padding({ left: 24, right: 24 })

      Button('开始刷照片')
        .fontSize(16).height(46).width(200)
        // 构建索引 + 抽样 + 跳转期间禁用：双击不再产生第二次会话，
        // 也不会再起第二次地点索引构建（那两次会争同一个 .tmp）。
        // ArkUI 的 enabled(false) 自带置灰效果，这就是给用户的视觉反馈。
        .enabled(!this.starting)
        .onClick(() => { this.startSession(); })

      Button('看收藏')
        .fontSize(16).height(46).width(200)
        .onClick(() => { router.pushUrl({ url: 'pages/FavPage' }); })

      Text(this.msg).fontSize(12).fontColor('#D33')
    }
    .width('100%').height('100%').justifyContent(FlexAlign.Center)
  }

  private chooseSize(n: number): void {
    this.selectedSize = n;
    AppStorage.setOrCreate(SIZE_KEY, n);
  }

  /**
   * 「开始刷照片」= 本页现在唯一的主流程（产品口径：没有认领动作）。
   * 顺序：读池子 → 不够就补货 → 重新读池子 → 抽样 → 存会话 → 进刷照片页。
   *
   * **防重入**：整段被 `this.starting` 闸门 + try/finally 包住。出口共四类 ——
   * ① 重入时直接 return（在置位前，不复位）；② 空池早退；③ 正常跳转成功；
   * ④ 任意一处抛错。②③④ 全部由 finally 复位，没有"按钮永久禁用"的路径。
   *
   * 补货仍然是打开系统选图器：第三方应用无法枚举相册
   *（READ_IMAGEVIDEO 是 system_basic，声明会导致安装失败），
   * 唯一入口是选图器，且选中的照片有永久授权。所以「自动给用户 N 张」= 从已授权池里抽 N 张。
   */
  private async startSession(): Promise<void> {
    // 防重入：本方法是 async，第一次调用会在 `await this.restock(...)` /
    // `await router.pushUrl(...)` 处让出，用户在窗口内再点一次就会重入。
    // 重入的代价不只是"开两次局"：它会让地点索引被并发构建两次。
    if (this.starting) {
      // 这一条 return **在置位之前**，所以不需要（也不应该）复位：标记属于那次正在跑的调用，
      // 由它自己的 finally 复位。这里若复位反而会把闸门打开。
      return;
    }
    this.starting = true;
    // 全流程包在 try/finally 里：本方法有**多条出口**（空池早退、正常跳转成功、
    // 以及任意一处抛错 —— restock 的 DecisionStore 读取、sampleSession、setSession、
    // setPrevQueue 都不在各自的 try 里），任何一条漏掉复位都会让按钮**永久禁用**。
    // 用 finally 一次性覆盖全部出口，未来新增 return 也不必记得补复位。
    try {
      this.msg = '';
      AppStorage.setOrCreate(SIZE_KEY, this.selectedSize);
      const size: number = this.selectedSize;
      const claimStore = new ClaimStore(this.ctx);
      let claimed: ClaimState = claimStore.load();
      if (claimed.photos.length < size) {
        // 池子不够本次要刷的张数：先补货，再重新读池子（补货只增不减，但重新读更诚实）
        await this.restock(claimStore, claimed);
        claimed = claimStore.load();
      }
      const pool: string[] = [];
      for (let i = 0; i < claimed.photos.length; i++) { pool.push(claimed.photos[i].photoId); }
      this.claimed = pool.length;
      if (pool.length === 0) {
        // 空池子不进刷照片页：那边会直接渲染「本会话刷完」，用户点了"继续"还是回到这里，
        // 看起来像卡住。留在本页把原因说清楚。
        this.msg = '还没有可刷的照片：在系统相册里选一批就能开始。';
        return;
      }
      // 地点索引：覆盖**整个已授权池**（不是本会话抽中的那几十张）——
      // 地图页（Task 10）要渲染全部照片，只索引一局会让未抽中的照片在地图上消失。
      // buildFrom 是幂等增量的（已索引的 URI 不重读），所以每次开始会话都调一次是安全的。
      // 不 await：它是后台性质的工作，不该阻塞跳转。
      //
      // 位置：紧跟 pool 构建（含补货后那次重读）与空池早退之后、抽样之前。三个理由：
      //   1) 此刻的 pool 就是马上要抽样、也是地图页要展示的那份池子，没有任何中间状态改过它；
      //   2) 放在空池早退**之后**：空池时 buildFrom 只会白读一次盘并打一条"0 条"的日志；
      //   3) 不 await，所以越早启动越好 —— 它随后与抽样、setPrevQueue、pushUrl 并发跑，
      //      用户走到地图页时索引已多读了一些。
      const idx = new LocationIndex(this.ctx);
      idx.buildFrom(pool)
        .then((list: LocationEntry[]) => {
          let withGps = 0;
          for (let i = 0; i < list.length; i++) {
            if (list[i].lat !== 0 || list[i].lon !== 0) { withGps++; }
          }
          hilog.info(0x0000, 'PhotoWall', '%{public}s', `地点索引 ${list.length} 条，其中带 GPS ${withGps} 条`);
        })
        .catch((e: Error) => {
          hilog.warn(0x0000, 'PhotoWall', '%{public}s', `地点索引构建失败: ${e.message}`);
        });
      // 「看过」与「上一批」一起构成抽样的输入：决策不再影响入池（放回抽样：已归档/已收藏/已上墙
      // 的照片仍会被抽中，见 core/session.ts 的文件头），但「看过」影响优先级。
      const sessionStore = new SessionStore(this.ctx);
      const seen: string[] = sessionStore.loadSeenIds();
      // 上一批（prevQueue）= 上一次开局抽中的那批照片，用于"优先避开上一批"。
      // 池子 ≈ 张数时（例如池 100、选 100、且这 100 张都看过），"没见过的优先"这一层恒为空，
      // 只按 seenIds 分桶会让每一轮都从同一个集合里抽 —— 用户点「继续刷」看到的是**完全相同的一批**。
      // 传进上一批后，池 200 / 每批 100 的场景能连着给出 200 张不同的，之后才循环回来。
      const prevQueue: string[] = sessionStore.getPrevQueue();
      // 种子 = Date.now()：每一局都必须是**不同**的抽样，否则「继续刷 N 张」会给出与上一局
      // 一模一样的队列和顺序（用户会以为按钮没生效）。可复现性由 core 层保证 ——
      // sampleSession 的 seed 是可注入的，单测传固定种子即可精确断言。
      // 附注：即便两次开局撞进同一毫秒（要用户在这一毫秒内连点两次，实际不可能），
      // 队列也不会相同 —— 分桶的输入一定变了：要么上一局刷过照片（seenIds 变大），
      // 要么"上一批"已经换成别的了（下面的 setPrevQueue 每次都重写它）。
      const session: SwipeSession = sampleSession(pool, size, seen, prevQueue, Date.now());
      setSession(session);
      // 记下"刚抽的这一批"，供下一轮避开。时机刻意在 sampleSession **之后**（记的是抽出来的
      // 队列，不是池子）、离开首页**之前**（下一轮开局时它一定已经在盘上了）。
      // 它内部会立刻原子落盘（首页没有别的收尾时机，见 data/sessionStore.ets 的 setPrevQueue）。
      sessionStore.setPrevQueue(session.queue);
      try {
        await router.pushUrl({ url: 'pages/SwipePage' });
      } catch (e) {
        // router.pushUrl 抛的确实是 BusinessError（有 code，如 100002），渲染规则仍与选图失败一致：
        // message 是主文案，code 只在确实存在时附在末尾（见 failureMsg 的说明）。
        // 这里**只改文案构造**：原来是 `err.code err.message` 硬拼，其余控制流一字未动。
        this.msg = `进入刷照片页失败：${failureMsg(e)}`;
      }
    } finally {
      // 在这里复位 = 覆盖上面**所有**出口（含空池 return 与任何异常）。
      // 注意 pushUrl 成功之后本页仍在路由栈里（pushUrl 不销毁当前页），
      // 用户返回时按钮必须已经可以再点 —— finally 正好在此之前执行。
      this.starting = false;
    }
  }

  /**
   * 补货：打开系统选图器，把用户选中的照片并入已授权池。
   *
   * 全程 best effort —— 用户取消、一张没选、选图器抛错，都只是"这次没补到货"，
   * 由调用方拿现有池子继续（池子非空时照样能刷）。这同时绕开了本项目尚未在真机验证的一件事：
   * 选图器被取消时到底 resolve([]) 还是 reject（见 data/claimStore.ets 的 pickPhotos 说明）——
   * 两种表现都被这里的兜底覆盖，所以本页**不**需要区分"取消"与"一张没选"。
   */
  private async restock(claimStore: ClaimStore, claimed: ClaimState): Promise<void> {
    // 把「已认领但还没刷过」的照片作为**预选项**传给选图器：它们会以选中状态呈现，
    // 用户点系统「完成」即可一键保留这批，想加新的就在同一个网格里顺便多选几张。
    // 判据（没有决策记录，或决策仍是 unseen）与原来一致，没有跟着本次改版漂移。
    const decisions = new DecisionStore(this.ctx).loadAll();
    const undecided: string[] = [];
    for (let i = 0; i < claimed.photos.length; i++) {
      const id = claimed.photos[i].photoId;
      const d = decisions.get(id);
      if (d === undefined || d.state === 'unseen') { undecided.push(id); }
    }
    try {
      const uris: string[] = await pickPhotos(undecided);
      if (uris.length === 0) {
        this.msg = '没有选中新照片，就用现有的继续';
        return;
      }
      // 「补货前」的张数直接复用上面那次 load 的结果，不再读一次盘：addBatch 内部已经要 load()。
      const before: number = claimed.photos.length;
      const next: ClaimState = claimStore.addBatch(uris, Date.now());
      const added: number = next.photos.length - before;   // 真正新增的张数（预选会让 uris 含大量旧照片）
      this.claimed = next.photos.length;
      this.msg = added > 0
        ? `本次新增 ${added} 张，池子共 ${next.photos.length} 张`
        : `没有新增（这 ${next.photos.length} 张都在池子里了）`;
    } catch (e) {
      // 这个 catch 接住的是**两类**异常，写法必须同时容得下它们：
      //   · `pickPhotos` 拒绝时抛的 BusinessError（选图器/权限，带 code）；
      //   · `claimStore.addBatch` → `writeTextAtomic` 失败时抛的**普通 Error**
      //     （无 code，原因写在 message 里，如"认领列表落盘失败: writeSync 短写：…"）。
      // 旧写法 `${err.code} ${err.message}` 对后者会渲染成 `选图失败：undefined 认领列表落盘失败: …`。
      // 只改文案构造：仍然把异常吞在这里（本方法没有"向上抛"的契约），msg 之外什么都不动。
      this.msg = `选图失败：${failureMsg(e)}`;
    }
  }
}
