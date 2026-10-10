// 刷照片的核心交互：一张可上下滑动的卡片（spec §5.1；M1 交互模型重构后）。
// 四个已验证的设计事实：
//   1. 上滑 = 下一张、下滑 = 上一张（抖音式翻页），翻页本身不产生决策；但下滑回到刚看过的那张时，
//      会把那张的决策从内存与盘上一并撤销，让它重新可决定（见 pages/SwipePage.ets 的 navigate）；
//   2. 三个动作（归档 / 上墙 / 收藏）与「主页面」都是卡片外侧下方的按钮，卡片本体只承载翻页手势。
//      「主页面」只做页面级导航（回首页），不产生任何内容决策 —— 详见 onHome。
//      左右滑手势全部取消 —— 斜着滑时无法判定方向归属，与上下滑直接冲突；
//   3. 阈值必须同时落在「速度」与「位移」两个维度：轻轻一甩能过，拖到位也能过。
//      基准是**卡高**（不再是卡宽），卡高由父组件经 onAreaChange 传入（见 cardHeight）；
//   4. 队列边界（idx === 0，没有上一张）不播翻出动画而是普通回弹：翻出动画之后父组件只能原样
//      换回同一张，用户看到的是「卡片滑走又原地弹回」，比不响应更像故障（见 canPrev / canNav）。
//      且这一次**不上报回弹**（产品裁决：无法再往前不是一次「滑了但没结果」的滑动尝试，
//      不该计入回弹率）—— 见 springBack(report) 与 settle()。
//
// 另注：卡片翻出的时刻由 setTimeout(...,210) 回调；CardStack 自身不计时，
// 「这张照片显示了多久」由 SwipePage.shownAt 承担（它才是跨卡片持有度量的那一层）。
//
// ── 本批（task-20）新增的两件事：动图播放 + 照片缩放/平移 ──────────────────────
//   5. **动图**：后缀疑似（`core/anim.ts` 的白名单）→ 帧数确认（`getFrameCount() > 1`，
//      权威判据）→ 按像素预算解帧 → `AnimatedDrawableDescriptor` 交给 `Image` 播。
//      **播放依赖可见性**（SDK 明说绑定组件不可见即自动暂停），且解码只发生一次
//      （装载时），播放阶段不再解码 —— 这是"卡片不可见时不继续解码"的结构性保证。
//      帧数组（`PixelMap[]`）是**本任务最容易泄漏的东西**：只有一个所有权对象
//      （`data/animSource.ets` 的 `AnimFrames`），释放出口在本文件里是**可枚举的三处**
//      —— 见 releaseAnim() 的说明。
//   6. **缩放/平移**：数据源从 `ImageFit.Cover` 改成 `Contain`（照片完整显示，见报告 §4
//      的独立判断），二指捏合缩放 1×~4×、双击复位到 1×。放大态下**一指拖动变成平移照片**
//      （不再是翻页）—— 这条规则由一个纯函数 `core/zoom.ts::isZoomed` 判定。
//
//   ⚠️ 新增手势（Pinch / 双击 Tap）与既有 PanGesture（翻页）**共存**的仲裁是本批最大风险，
//      详见 build() 里 `.gesture(...)` 上方的说明与 onActionUpdate 里的 fingerList 判据。
//
// ── 依赖方向（本批唯一新增的一条）──────────────────────────────────────────
//   `ui/` → `data/animSource`。动图的帧数组是**平台资源**（`fileIo` + `Image` + 一个
//   与 Image 组件 1:1 绑定的 `AnimatedDrawableDescriptor`），它必须由**渲染它的那个组件**
//   持有：把它经 `@Prop` 从页面传下来会有两个问题 ——
//     · `@Prop` 对对象做拷贝，而 descriptor 是原生对象，"拷贝后还指得回同一个组件吗"
//       是框架内部行为，SDK 又明确要求 descriptor 与 Image 是 **1:1**（`drawableDescriptor.d.ts:520`）；
//     · 平移边界还需要这张照片的**固有像素尺寸**（`AnimFrames.srcW/srcH`），
//       拆成"页面传 descriptor + 页面传宽高"就是同一个事实的两处表达，迟早漂移。
//   所以：谁渲染，谁持有，谁释放。
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AnimFrames, loadAnimFrames } from '../data/animSource';
import { clampScale, isZoomed, resolveContentSize, clampOffset, SCALE_MIN, ZoomSize, PanOffset } from '../core/zoom';

// 与 pages/SwipePage.ets 同款口径（DOMAIN / TAG 在本项目里是全局一致的）。
const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

export const NAV_VELOCITY = 800;         // vp/s：轻轻一甩就翻页
export const NAV_DISTANCE_RATIO = 0.28;  // 卡高比例：拖到位也翻页
export const SPRING_BACK_MS = 150;

// 双击复位缩放的动画时长。与 springBack 的 150ms 同一量级：短到"立刻到位"、
// 长到能让人看出"这是复位而不是跳变"。刻意**不**导出：它不是任何判定的依据，纯观感。
const ZOOM_RESET_MS = 150;

// 队列里的一张照片。定义在这里并导出：CardStack 自己要用它，
// SwipePage 也从这里 import（不要各自定义一份）。
export interface QueueItem { photoId: string; thumbUri: string }

/** 翻页方向：dir = 1 上一张（卡片向下走）、dir = -1 下一张（卡片向上走）。 */
export interface NavPayload { dir: number }

/** 一次真实的决定（只由卡片下方的动作按钮触发：归档 / 收藏）。 */
export interface DecidePayload { action: 'archive' | 'fav' }

/**
 * 卡片向父组件上报的事件（判别联合）。用它而非多个独立参数，是为了让**字面量/直赋值形态**的
 * 非法配对在编译期报错：'decide' 必须携带 action、'wall' 与 'nav' 各自携带自己的形态，
 * 所以「决定却不带 action」这类写法过不了编译，而不是被 SwipePage.handle() 的守卫静默丢弃
 *（那会让卡片飞走、决定静默丢失）。
 *
 * 边界（已知且当前无害，勿删消费侧的按 kind 解码）：TS 的多余属性检查只作用于「新鲜」字面量，
 * 因此把一个带多余字段的**变量**传进来仍能编译 —— 这是结构化类型的固有行为，与联合形态的选择无关。
 * 真正的防线是消费侧按 kind 单向解码（见 pages/SwipePage.ets 的 handle）：
 * 未知 kind 走不到任何写盘路径，多余字段也不可能回流影响决策与指标。
 * 另注：本联合不编码「出口 ↔ kind」的对应关系 —— 新增手势/按钮出口时需自行确认
 * 它上报的 kind 与实际行为一致（见 onDecide 上方的出口清单）。
 *
 * 'wall' 分支表示「这张直接上墙，不必先收藏」：用户看到照片的当下就可能已经有上墙判断，
 * 不必被迫先点收藏、再回来找入口。它不携带 action —— 上墙不是方向性决定。
 *
 * 'nav' 分支表示翻页（不产生决策）：dir = 1 上一张、dir = -1 下一张。
 * 注意：'skip' 与删除不在此列 —— 它们不是本页的滑动/按钮动作（跳过在长按菜单、删除另设路径）。
 *
 * ArkTS 硬约束决定了这里只能写成三个「具名 interface」的联合，而非内联对象类型：
 *   - arkts-no-obj-literals-as-types：内联对象字面量不能作为类型声明；
 *   - arkts-no-untyped-obj-literals：对象字面量必须对应显式声明的 class/interface，
 *     所以调用点用显式标注的局部变量构造，不把字面量直接塞进联合类型的参数位。
 * 这两条只影响「怎么写」，不改变上面「边界」所述的判别范围。
 */
export interface CardDecide { kind: 'decide'; payload: DecidePayload }
export interface CardWall { kind: 'wall' }
export interface CardNav { kind: 'nav'; payload: NavPayload }
export type CardEvent = CardDecide | CardWall | CardNav;

/**
 * 回弹（**手势没过阈值**：滑了但没结果，卡片弹回原位）。它**刻意不是** CardEvent 的一支，
 * 而是与 CardEvent 并列的第二种上报类型：回弹不是「卡片做出的动作」，没有动作语义可判别，
 * 唯一用途是喂 core/metrics.ts 的 rollbackRate —— 「回弹率 < 3%」这条验收指标的**唯一数据源**。
 * 所以它必须继续由 springBack(true) 上报、必须继续被 SwipePage.handle() 解码
 *（rolledBack = true：只进指标、不消耗队列）。删掉它等于让回弹率的分子结构性恒为 0、指标恒"达标"。
 * 但它**不是**队首下滑的上报类型：那一支走 springBack(false)（产品裁决「不算，静默弹回」）。
 */
export interface SwipeRollback { kind: 'rollback' }

@Component
export struct CardStack {
  /**
   * 队列里当前这张。
   *
   * `@Watch('onItemChanged')` 是**本批新增的换卡信号**，也是新引入的那些"跟着卡片走"的
   * 状态（动图帧、缩放/平移、照片固有尺寸）**唯一真正的换卡时刻**：
   * `@Prop` 变化 = 父组件把另一张照片放进了同一个（被复用的）组件实例。
   * 三条理由说明为什么用它、而不是让父组件多发一个"已换卡"的信号：
   *   1) 组件实例是复用的（见 navOut 的 try/finally 与 commit 里"归零"那段），
   *      `aboutToAppear` 只在**第一次**建卡时跑，换卡根本不会触发它 —— 没有 @Watch
   *      就没有任何回调知道"现在这张不是刚才那张了"；
   *   2) 这个信号天然携带**新的 photoId**，而新引入的每一份状态都必须按 photoId 判定归属
   *      （异步解帧的结果回来时可能已经换了两张卡）；
   *   3) 它与"父组件发了新的事件"无关：翻页、按钮决策、返回上一张三条换卡路径
   *      最终都只表现为 `item` 变化，所以监听它一次就覆盖全部路径。
   *
   * ⚠️ 但 @Watch 在某些状态下可能被**重复**触发（父组件别的 @State 变化导致重渲染时
   * 重新赋值同一个 item）。所以 onItemChanged 的**第一件事**是按 photoId 去重 ——
   * 否则一次无关的重渲染就会把用户正在捏的缩放复位掉。见 onItemChanged。
   */
  @Prop @Watch('onItemChanged') item: QueueItem;
  // 卡片实际高度（= 父组件量到的可用高度 × 0.62，见 SwipePage.ets 的 CARD_HEIGHT_RATIO）。
  // 600 只是父组件尚未量出高度时的兜底，不是判定依据：位移阈值与翻出距离都以它为准。
  @Prop cardHeight: number = 600;
  // 队列里是否还有上一张（父组件按 idx > 0 传入）。false 时下滑手势不播翻出动画：
  // 父组件的 navigate(1) 只能早退，卡片飞出去之后会被原样换回同一张 = 用户看到「滑走又弹回」。
  @Prop canPrev: boolean = false;
  // 上报的是一次交互的「内容结果」：CardEvent（决定 / 上墙 / 翻页）或 SwipeRollback（回弹）。
  // 合法组合由类型编码，字面量形态下传错组合会在编译期报错，而不是运行期被 handle() 的守卫
  // 静默丢弃；变量形态可绕过（见 CardEvent 上方「边界」），且「出口 ↔ kind」对应不在编码范围内
  // —— 新增出口时请自行核对。当前六个出口：
  //   手势上滑 → 'nav'(dir=-1)、手势下滑 → 'nav'(dir=1)（队列边界时改为静默回弹、不上报）、
  //   「归档」按钮 → 'decide'/archive、「收藏」按钮 → 'decide'/fav、
  //   「上墙」按钮 → 'wall'、回弹 → 'rollback'。
  // 「主页面」按钮**不在**此列：它是页面级导航，走下面独立的 onHome。
  onDecide: (photoId: string, ev: CardEvent | SwipeRollback) => void = () => {};

  /**
   * 「主页面」按钮的出口：回首页（认领页 pages/ClaimPage，App 首屏）。它**刻意不是** CardEvent 的一支，
   * 走独立回调而不是 onDecide，理由是「决策」与「导航」是两类不同的东西：
   *   1) 语义：onDecide 的契约是「卡片上报一个**关于这张照片的内容**事件」—— 决定 / 上墙 / 翻页。
   *      回首页不产生任何内容状态：不写决策、不进指标、不消耗队列，photoId 对它毫无意义。
   *      把这支塞进 CardEvent 会让「内容事件」这个契约多出一个反例，下一个维护者得先读懂
   *      「这个联合里有一个成员其实与内容无关」才能正确改动消费侧。
   *   2) 消费路径：'home' 若成为 CardEvent 的一支，SwipePage.handle() 就必须为它加一条
   *      早退分支 —— 于是「一个纯导航动作」被塞进那个专门解码**决策**的函数（它下面的
   *      `action` 守卫、recordSwipe、applyDecision 全是决策逻辑），导航的正确性反过来
   *      依赖那条早退分支的位置。独立回调把这条路径整个绕开。
   *   3) 误用代价：commit() 是内容出口的**唯一**收尾动作，它除了调 onDecide 还会写 decidedId /
   *      decidedDuringGesture（作废在途手势）、并 endSpringWindow()。回首页不需要其中任何一项
   *      —— 它不动这张照片的位置、也不动回弹窗口；一旦被误走 commit()，那些状态就会被写上一个
   *      与「定案」无关的时刻，掩盖掉它真正的含义（决策唯一性 / 回弹窗口归属）。
   *      独立回调让「走错收尾」在结构上不可达，而不是靠调用点自觉。
   * 默认空实现：与 onDecide 同口径 —— 未接线的父组件只会得到一个点了没反应的按钮，不会崩。
   */
  onHome: () => void = () => {};
  // dx：垂直模型下**没有任何写入路径**（手势只写 dy），保留它只为两件事：
  //   1) .translate({ x: this.dx }) 需要一个显式的横向分量；
  //   2) 所有「这张卡已定案 / 换卡归位」的出口都显式把它置 0 —— 组件实例是复用的
  //      （见 navOut 的 try/finally），万一将来重新引入横向位移，这里保证复用的实例
  //      不会带着旧偏移出现在下一张上。
  @State dx: number = 0;
  @State dy: number = 0;
  @State animating: boolean = false;   // 翻出动画期间为真，作为手势/按钮闸门（Ruling 27）；回弹不计入
  // 已经上报过决策（或翻页）的那张照片 —— 三个动作按钮在 onDecide **之前**写它。
  // 翻页/决定都**不**设 animating 之外的保护：动作按钮要立即上报、不走 navOut 的 210ms 延迟，
  // 所以多指场景下「另一根手指在途的拖拽」会在 idx 已前进后继续写 dy，抬手时 settle() 会以
  // **新** photoId 上报 → 用户没打算决定的那张被静默消耗（批 15 修的缺陷）。
  // 这张记录是否让某个手势作废，由 isGestureVoided() 按「手势起点」判定（见该方法的说明）。
  private decidedId: string = '';
  // 定案是否发生在**当前这一次手势**期间：onActionStart 清、commit() 置真。
  // 判据 1 的时限。光看 photoId 恒等分不清「窗口」与「陈旧」—— 「点击 → 换卡」那一帧内
  // item 就是这张，而「← 返回上一张」回到同一张之后 item 又是这张（见 isGestureVoided）。
  private decidedDuringGesture: boolean = false;
  // 本次手势「是在哪张卡上开始的」：onActionStart 里无条件记录（每次新手势刷新），
  // 手势结束时由 onActionEnd 清空 —— 它必须只在手势在途期间非空，见 isGestureVoided 判据 2。
  // 作废判据必须依据它，而不是 this.item.photoId —— 定案/翻页后父组件重渲染会在约一帧内
  // 把 @Prop item 换成另一张，此后 item.photoId 已经不是那张卡了，而在途手势仍属于它：
  // 拿 item 去比会漏掉这个手势，那正是本缺陷的形态（手指会在换卡之后继续产生几百毫秒的 update）。
  private gestureId: string = '';
  private lastY: number = 0;
  private lastT: number = 0;
  private velocity: number = 0;
  private flyTimer: number = -1;       // navOut 的 setTimeout 句柄，卸载时必须清掉（Ruling 28）
  // springBack 的上报防抖窗口句柄：非 -1 表示「同一次回弹」尚未结束（Ruling 29）。
  // 它只影响是否重复上报，不是手势闸门——回弹期间仍可重新拖拽。
  private springTimer: number = -1;

  // ── 缩放 / 平移（本批新增）────────────────────────────────────────────────
  // 三个 @State 是**渲染输入**（照片的 .scale() 与 .offset()），所以必须是 @State：
  // 组件实例复用，改它们是唯一让画面跟着手指动的手段。
  // ⚠️ 字段名**不能**叫 `scale`：`CustomComponent`（每个 @Component 的基类）上已经有
  // 同名的属性方法 `scale(value: ScaleOptions)`，重名会让 ArkTS 报
  // "Property 'scale' ... is not assignable to the same property in base type"。
  // 这不是风格问题，是编译期硬约束 —— 同理不能用 `offset` / `clip` / `width` 这类名字。
  @State zoomScale: number = 1;
  @State panX: number = 0;
  @State panY: number = 0;
  // 捏合手势的**连乘基准**：PinchGesture 的 `e.scale` 是相对手势起点的累计值，
  // 所以基准只能是"这次手势开始时的 zoomScale"，不能每帧拿 this.zoomScale 去乘（会指数放大）。
  private scaleAtPinchStart: number = 1;
  // 一指拖动的**起点平移量**：PanGesture 的 offsetX/offsetY 同样是"相对手势起点"的累计值。
  private panStartX: number = 0;
  private panStartY: number = 0;
  // 「本次一指手势已经被定性为缩放/多指手势」：一旦有两指同时落下就置真，直到本次手势结束。
  // 它存在的唯一理由是**翻页必须被挡住** —— PanGesture({fingers:1}) 的 fingers 是**最少**
  // 手指数，两指捏合照样会命中它（见 onActionUpdate）。置真之后 settle() 不得翻页、不得记回弹。
  private gestureIsZoom: boolean = false;
  // PinchGesture 当前是否被识别（onActionStart~onActionEnd/Cancel）。它比 fingerList 更早、
  // 更可靠地说明"这是缩放"，作为 fingerList 判据的补充（第三根手指抬起等瞬时形态）。
  private pinching: boolean = false;

  // ── 几何：三个尺寸，各来自不同的事实（都只在回调里读，不需要 @State）──────
  // 卡片盒子尺寸（vp）= 照片要做 Contain 的那个"框"，由 onAreaChange 量到。
  private boxW: number = 0;
  private boxH: number = 0;
  // 照片**固有**像素尺寸（px；0 = 尚未知道）。静态图由 onComplete 给，动图由 AnimFrames 给。
  private srcW: number = 0;
  private srcH: number = 0;
  // `onComplete` 报的"实际绘制内容"尺寸。只有静态图有（SDK：动图不触发 onComplete），
  // 所以换卡时必须清零 —— 否则下一张会拿着**上一张**的内容尺寸去算平移边界。
  private drawnW: number = 0;
  private drawnH: number = 0;

  // ── 动图（本批新增）──────────────────────────────────────────────────────
  // 交给 Image 的动图描述符；undefined = 走静态 URI（**绝大多数**照片都是这条）。
  @State animDesc: DrawableDescriptor | undefined = undefined;
  // 帧数组的**所有权对象**（唯一持有者）。释放出口见 releaseAnim()。
  private animOwner: AnimFrames | undefined = undefined;
  // 「哪一张 photoId 的动图结论已经拿到」：'' = 没有结论。
  // 它同时是"这张正在装载中"的标记 —— 用它去重，避免同一张卡重复解帧。
  private animForId: string = '';
  // 解帧是异步的（要读文件头 + 解码全部帧）。换卡比解帧快时，旧结果回来必须被丢弃并释放。
  // 用**递增序号**当凭据（与 pages/SwipePage.ets 的 wallSeq 同一手法）：只有最后一次请求有效。
  private animSeq: number = 0;
  // 「上一次 @Watch 处理过的 photoId」：@Watch 可能被重复触发（父组件别的 @State 变化），
  // 而所有按卡的状态**只允许在 photoId 真的变了**的时候被重置。见 onItemChanged。
  private curItemId: string = '';

  aboutToAppear(): void {
    this.dx = 0;
    this.dy = 0;
    this.velocity = 0;
    // 本批新增的每卡状态：与 dx/dy 同一口径 —— 实例复用，新卡不会自己回到初始态。
    this.resetZoom();
    this.clearPhotoGeometry();
    // 第一张卡：`@Watch` 在 @Prop **初始化时不触发**（SDK 明说），所以首张必须在这里主动起装载。
    this.curItemId = this.item.photoId;
    this.ensureAnimForCurrent();
  }

  // 组件卸载（用户 210ms 内返回上一页）后不能再回调 onDecide。
  aboutToDisappear(): void {
    if (this.flyTimer !== -1) { clearTimeout(this.flyTimer); this.flyTimer = -1; }
    // 卸载也是「这张卡的回弹窗口到此为止」：不结束的话，残留 timer 的回调会晚于卸载触发。
    this.endSpringWindow();
    // 卸载 = 这张卡永远消失：动图帧必须在这里放手（见 releaseAnim 的三条出口）。
    this.releaseAnim();
  }

  /**
   * `@Prop item` 变化 = **换卡**（本批新增的状态全部挂在这个时刻）。
   *
   * 做四件事，顺序有意义：
   *   1) **按 photoId 去重**（第一件事）：@Watch 可能被重复触发（父组件别的 @State 变了
   *      导致重渲染并重新赋值同一个 item）。不去重的话，一次无关的重渲染就会把用户
   *      正在捏的缩放复位、把正在播的动图释放重解 —— 症状是"缩放偶尔自己弹回 1×"。
   *   2) 释放上一张的动图帧（**本任务最容易泄漏的一条路径**，见 releaseAnim）。
   *   3) 复位缩放/平移与照片尺寸：上滑下一张之后**不能还是放大的**。
   *   4) 为新的这张起装载（动图）。同步静态图在这条路径上**什么都不做**
   *      （`isAnimatedCandidate` 是纯字符串判断，一次都不开文件）。
   */
  onItemChanged(): void {
    const id: string = this.item.photoId;
    if (id === this.curItemId) { return; }   // 同卡重渲染：一概不动（理由见上第 1 条）
    this.curItemId = id;
    this.releaseAnim();
    this.resetZoom();
    this.clearPhotoGeometry();
    this.ensureAnimForCurrent();
  }

  /** 把「不随 item 变化而自动重置」的缩放/平移状态归位到 1× 居中（平赋值，不做动画）。 */
  private resetZoom(): void {
    this.zoomScale = SCALE_MIN;
    this.panX = 0;
    this.panY = 0;
    // 手势状态一并清掉：换卡可能发生在"另一根手指还按着"的时候（第三指点按钮），
    // 留着 gestureIsZoom = true 会让新卡上的第一次拖动被静默忽略。
    this.gestureIsZoom = false;
    this.pinching = false;
  }

  /**
   * 清掉"上一张照片的尺寸"。**必须与换卡同时发生**：
   * 这三个数是"这张照片长什么样"的度量，跨卡沿用会算出**错误但看不出来**的平移边界
   * （照片被推出卡片露出底色，或该拖的地方拖不动）。
   */
  private clearPhotoGeometry(): void {
    this.srcW = 0;
    this.srcH = 0;
    this.drawnW = 0;
    this.drawnH = 0;
  }

  /**
   * 照片**实际绘制尺寸**（vp）—— 平移边界的唯一输入。
   * 判定链（`onComplete` 的绘制尺寸 → 固有尺寸 + Contain 换算 → 算不出）
   * 全在纯函数 `core/zoom.ts::resolveContentSize` 里，有单测。
   */
  private contentSize(): ZoomSize {
    return resolveContentSize(this.drawnW, this.drawnH, this.srcW, this.srcH, this.boxW, this.boxH);
  }

  /**
   * 按当前 scale 重新夹住平移量。三个调用点各有一个理由：
   *   · 捏合每帧变化后 —— 缩放变了，可拖范围跟着变；**缩回 1× 时余量归零、平移自动清零**，
   *     这就是"缩小到 1× 必定回到居中"的机制（不需要额外的复位代码）；
   *   · 盒子尺寸变化后（onAreaChange）—— 边界跟着框走；
   *   · 动图装载完成后 —— 固有尺寸这时才拿到，边界从"算不出"变成"算得出"。
   */
  private reclampPan(): void {
    const c: ZoomSize = this.contentSize();
    const o: PanOffset = clampOffset(this.panX, this.panY, c.width, c.height, this.boxW, this.boxH, this.zoomScale);
    this.panX = o.x;
    this.panY = o.y;
  }

  // ── 动图：装载 / 释放 ─────────────────────────────────────────────────────

  /**
   * 为**当前这张**装载动图。三道闸（全部在 data/animSource 内，这里只是触发）：
   * 后缀白名单 → 缓存 → `getFrameCount()` 权威确认 → 解帧。
   *
   * 去重靠 `animForId`：它同时表示"正在装载"与"已经有结论（含'不是动图'）"。
   * 所以同一张卡无论被触发多少次，最多解一次帧。
   */
  private ensureAnimForCurrent(): void {
    const id: string = this.item.photoId;
    if (id === '') { return; }
    if (this.animForId === id) { return; }
    this.releaseAnim();
    this.animForId = id;
    this.animSeq = this.animSeq + 1;
    const seq: number = this.animSeq;
    const p: Promise<AnimFrames | undefined> = loadAnimFrames(id);
    p.then((af: AnimFrames | undefined) => { this.onAnimLoaded(id, seq, af); })
      .catch((): void => {
        // loadAnimFrames 内部已吞掉全部异常（任何失败都返回 undefined）——
        // 这里只是不让一个意外的 rejection 变成未处理异常。失败退路是静态图，不是白屏。
      });
  }

  /**
   * 解帧结果回来。**第一件事是判定它还算不算数** —— 用户完全可能在这几十毫秒里已经翻走。
   * 不算数的那一份**必须在这里释放**，否则每快速划过一张动图就漏一整套帧
   * （一张 30 帧的 GIF ≈ 十几 MB，几十张就是 GB 级）。
   */
  private onAnimLoaded(id: string, seq: number, af: AnimFrames | undefined): void {
    if (seq !== this.animSeq || this.animForId !== id || this.item.photoId !== id) {
      if (af !== undefined) {
        hilog.info(DOMAIN, TAG, '%{public}s',
          `动图结果已过期，直接释放: ${id}（帧数释放=${af.release()}）`);
      }
      return;
    }
    if (af === undefined) {
      // 不是动图 / 解析失败 / 方向需静态路径摆正 → 保持静态路径。
      // animForId 已经是这张，所以不会再重复探测（这是"失败要优雅"的全部代价：一张静态图）。
      return;
    }
    // 同一张卡理论上不会再有一个 owner（animForId 去重），但换卡路径可能留下旧的：
    // 释放掉再装，保证"最多只有一个 AnimFrames 活着"这条不变量。
    if (this.animOwner !== undefined) {
      this.animOwner.release();
      this.animOwner = undefined;
    }
    this.animOwner = af;
    // 固有尺寸：动图**没有** onComplete（SDK 明说该事件对 AnimatedDrawableDescriptor 不触发），
    // 所以它只能从这里来；平移边界靠它才成立。
    // **同时必须清掉 drawn 尺寸**：那个数只可能来自"上一张静态图"的 onComplete
    //（动图的 onComplete 不触发），而 `resolveContentSize` 会优先采用它 ——
    // 不清的话，一张动图会拿着**上一张照片**的绘制尺寸去算平移边界：
    // 边界看起来"算得出来"，却是错的（拖出去露底色，或该拖的地方拖不动）。
    // 这是"跨卡沿用度量"的典型形态：数值合法、结果错误、不会报错。
    this.drawnW = 0;
    this.drawnH = 0;
    this.srcW = af.srcW;
    this.srcH = af.srcH;
    this.animDesc = af.descriptor;
    this.reclampPan();
  }

  /**
   * 释放当前动图。**这是帧数组唯一的释放出口**，三个调用点穷举了所有"这张卡不再需要它"的时刻：
   *   1) `onItemChanged`（换卡）；
   *   2) `aboutToDisappear`（页面卸载）；
   *   3) `onAnimLoaded` 的过期分支（解帧回来时这张卡已经走了）。
   * 除此之外没有第二个持有者（`animOwner` 是唯一字段），所以"没有别的泄漏路径"是结构事实，
   * 不是靠调用点自觉。`AnimFrames.release()` 幂等，重复调用无害。
   */
  private releaseAnim(): void {
    // 先让在途的解帧结果作废（它回来时会自己释放自己那一份），再放手当前这份。
    this.animSeq = this.animSeq + 1;
    this.animForId = '';
    if (this.animOwner !== undefined) {
      const n: number = this.animOwner.release();
      this.animOwner = undefined;
      // 真机核验动图有没有泄漏的**唯一直接证据**：每换走一张动图就该看到一行，
      // 且 n > 0。若换卡时**没有**这行日志，说明释放路径没走到（泄漏）。
      hilog.info(DOMAIN, TAG, '%{public}s', `换卡释放动图帧: 释放=${n}`);
    }
    this.animDesc = undefined;
  }

  /** 交给 Image 的源：有动图就给它，否则给静态 URI（**绝大多数**照片走这一支）。 */
  private imgSource(): ResourceStr | DrawableDescriptor {
    const d: DrawableDescriptor | undefined = this.animDesc;
    if (d !== undefined) { return d; }
    return this.item.thumbUri;
  }

  /**
   * `onComplete`：静态图加载完成时框架报的尺寸。
   * 三个输入各有用处：固有尺寸（px，算 Contain）与**实际绘制尺寸**（算平移边界，
   * 见 `resolveContentSize` 的判定链）。
   * 注意 SDK：**参数类型是 AnimatedDrawableDescriptor 时本事件不触发** ——
   * 动图这两条信息由 `AnimFrames` 提供，两条路径不重叠也不冲突。
   */
  private onPhotoDrawn(srcPxW: number, srcPxH: number, drawnW: number, drawnH: number): void {
    if (srcPxW > 0 && srcPxH > 0) {
      this.srcW = srcPxW;
      this.srcH = srcPxH;
    }
    if (drawnW > 0 && drawnH > 0) {
      this.drawnW = drawnW;
      this.drawnH = drawnH;
    }
    // 尺寸变了 → 平移边界跟着变（首次拿到尺寸时把"算不出"变成"算得出"）
    this.reclampPan();
  }

  /**
   * 结束当前这张卡的回弹上报窗口。任何「这张卡已经定案 / 已经翻页」的出口都必须调用：
   * 否则残留窗口会让下一张卡在窗口内的首次回弹被误判为「已上报」而静默丢弃
   * → rollbackRate 偏低（指标向"好看"方向失真）。
   * 现有出口：navOut()、三个动作按钮共用的 commit()。
   */
  private endSpringWindow(): void {
    if (this.springTimer !== -1) {
      clearTimeout(this.springTimer);
      this.springTimer = -1;
    }
  }

  /**
   * 这个手势是否已作废（不得再写 dy，也不得在 settle() 里上报）。
   * 两条互补判据，缺一不可：
   *   1) 手势起点卡就是刚定案的那张，**且定案就发生在这一次手势期间** —— 按钮路径必须
   *      **当场**作废：从按钮点击到 @Prop item 换卡之间还隔着约一帧，在途手指能在这段窗口里
   *      把 dy 写歪，而按钮刚显式归过零（见 commit() 里「归零」那段）。
   *      三个条件各自的作用与不可省性：
   *        - `decidedId !== '' && gestureId === decidedId` 只说「这个手势的起点卡被定过案」，
   *          **不能**单独作判据（原缺陷）：定案后父组件若把 idx 退回同一张 ——「← 返回上一张」
   *          正是如此，且该路径**不重建组件实例**（idx 从 1 回到 0 时 `idx < items.length`
   *          分支没有切换，@Prop item 只是换回了同一张照片）—— decidedId 会陈旧成「当前这张」，
   *          而 onActionStart 每次把手势起点刷成同一张，于是恒真且不自愈：
   *          这张卡不可滑、不可决策、连动作按钮也失效，只能杀 App。
   *        - `item.photoId === decidedId`（「还没换卡」）**不改变任何判定**：判据 2 为假时必有
   *          gestureId === item.photoId，故在「判据 2 为假」这个唯一需要判据 1 说话的状态下，
   *          它是恒真的推论；判据 2 为真时本就已作废。保留它只是把「还没换卡」写进代码，
   *          别指望它解开上面那个锁（那要靠下一条）。
   *        - `decidedDuringGesture` 才是真正区分「窗口」与「陈旧」的信息：窗口期那根在途手指
   *          **早在定案之前**就已经开始（onActionStart 已跑过），而定案之后才开始的手势是
   *          新的一次操作（onActionStart 会把它清掉）—— 两条路径的 photoId 完全相同，
   *          时间先后是唯一可用的判据。它只在「点击 → 换卡」约一帧的窗口内为真；
   *          换卡之后由判据 2 接管（跨卡作废，且随 @Prop item 变化自动解除）。
   *   2) 手势起点卡已不是当前显示的那张 —— 换卡本身即作废。它让作废跨过换卡继续有效，
   *      并覆盖「decidedId 被下一次定案覆盖」的情形（两指连点两次按钮：第二次把
   *      decidedId 写成新卡后，判据 1 就认不出第一根手指的在途手势了）；而且不可逆 ——
   *      起点卡再也回不到当前位，所以一个被作废的手势在它自己结束之前始终作废
   *      （手势结束即由 onActionEnd 清空 gestureId，此后判据 2 不再说话）。这正是不必在
   *      onActionStart 早退的前提：基线照常刷新，但刷新的基线永远用不到决策上。
   * 判据一律看「手势起点」而不是「当前显示的那张」：定案/翻页后约一帧内 item 就会换成
   * 另一张，用 item 比对会漏掉在途手势（它属于旧卡），那个漏网正是本缺陷的形态。
   * 空字符串表示「还没有记录」：此时不作废 —— 宁可少作废也不误作废，
   * 误作废会让这一页的手势整段失灵。
   */
  private isGestureVoided(): boolean {
    if (this.decidedId !== '' && this.gestureId === this.decidedId
        && this.item.photoId === this.decidedId && this.decidedDuringGesture) { return true; }
    if (this.gestureId !== '' && this.gestureId !== this.item.photoId) { return true; }
    return false;
  }

  /** 翻页闸门：dir = 1（上一张）要求队列里确实还有上一张（canPrev 由父组件按 idx 传入）。 */
  private canNav(dir: number): boolean {
    if (dir > 0) { return this.canPrev; }
    // 下一张永远可达：走完最后一张时父组件会渲染「刷完了」，不再有卡片可以滑。
    return true;
  }

  /**
   * 卡片上的照片本体。抽成 @Builder 的理由：它有**两个源**（静态 URI / 动图 descriptor），
   * 而除源以外**每一个属性都必须完全一致**（objectFit / 缩放 / 平移 / onComplete）——
   * 分两份写迟早漂移，而漂移不报错，只会让"动图能缩放、静态图不能"这种形态出现。
   *
   * ── `objectFit` 从 `Cover` 改成 `Contain`（本批的产品决策，理由见报告 §4）────────
   *   `Cover` 为了填满卡片会**裁掉**照片的一部分，而且裁得没有任何提示：
   *   对"要不要留下这张/挂上墙"的决策场景，用户正在看的那块很可能不是他判断依据的那块。
   *   更要紧的是：**`Cover` 之下"放大"是假的** —— 被裁掉的那部分在任何放大倍数下都看不到，
   *   放大只是把已经裁好的画面放大。所以 Contain 与"支持放大"是同一件事的两面。
   *   代价（写进报告，不藏）：照片比例与卡片比例不同时，卡片上会出现"照片之外的底色"
   *   （卡片底色 `#EEE`，读起来像相框衬纸）。这是**可见的诚实代价**，换来"看到的就是全图"。
   *
   * ── 缩放/平移怎么落在渲染上（两层是**不同机制**，顺序确定）──────────────────
   *   · `.scale()` 是**渲染变换**（默认绕组件中心）；
   *   · `.offset()` 是**布局偏移** —— 布局先于渲染，所以顺序是确定的：
   *     照片中心先被移到"居中 + (panX, panY)"，再绕这个中心缩放。
   *     即屏幕坐标 = 中心 + pan + scale × (p − 中心)，正是 `core/zoom.ts` 的边界公式假设的变换。
   *     （不用 `.translate()`：它和 `.scale()` 同属渲染变换，两者相对顺序要靠平台约定，
   *       而 offset 与 scale 分属布局/渲染两层，顺序不是约定而是事实。）
   *   · 卡片 Stack 上的 `.clip(true)` 负责把放大后溢出卡片的部分裁掉。
   */
  @Builder
  photoNode() {
    Image(this.imgSource())
      .width('100%').height('100%')
      .objectFit(ImageFit.Contain)
      .scale({ x: this.zoomScale, y: this.zoomScale })
      .offset({ x: this.panX, y: this.panY })
      // 静态图加载完成 → 拿到固有尺寸与实际绘制尺寸（动图**不走**这里，SDK 明说不触发）。
      // 只读四个数，不写任何与手势/决策有关的状态，所以不会与手势回调争状态。
      .onComplete((event) => {
        if (event === undefined) { return; }
        this.onPhotoDrawn(event.width, event.height, event.contentWidth, event.contentHeight);
      })
  }

  /**
   * 双击 = 复位到 1× 居中。
   *
   * 三个判据各有一条理由，与四个按钮的闸门口径**刻意保持一致**：
   *   · `animating`：翻出动画期间卡片视觉上已经飞走（而 idx 要等 210ms 才推进），
   *     此时改它的缩放没有意义；更要紧的是那 200ms 的 `dy` 动画正在播，
   *     复位会把它的位移一起打断（`animateTo` 的 dy 归零 = 卡片半路停住）。
   *   · `isGestureVoided()`：另一根手指正在这张卡上拖（或这张卡刚被定案）时，
   *     "这次双击属于哪一张"是不确定的 —— 与 commit / tapHome 同一取舍。
   *     注意双击本身**不产生手势起点**（它不写 gestureId），所以本判据只在
   *     "另一根手指在途"这一种形态下为真 —— 那正是它要挡的形态。
   *   · "本来就是 1× 居中"直接返回：双击是高频手势，无操作时不该白白触发一次重渲染
   *     （`animateTo` 里写三个 @State 会让整棵子树重画一遍）。
   */
  private onDoubleTap(): void {
    if (this.animating) { return; }
    if (this.isGestureVoided()) { return; }
    if (!isZoomed(this.zoomScale) && this.panX === 0 && this.panY === 0) { return; }
    animateTo({ duration: ZOOM_RESET_MS, curve: Curve.EaseOut }, () => {
      this.zoomScale = SCALE_MIN;
      // 平移与缩放必须**一起**归位：只归缩放的话，一个"已经放大过的位移"会被
      // 原样留在一个 1× 的照片上 —— 照片会偏在卡片一角，而它已经不可能被拖回来了
      //（1× 时余量为 0，clampOffset 会把任何拖动都夹成 0）。
      this.panX = 0;
      this.panY = 0;
    });
  }

  build() {
    Column() {
      // 卡片本体：照片 + 翻页/缩放/平移手势 + 位移。按钮**不在**这里 —— 按钮在卡片外侧下方一行，
      // 既完全不遮挡照片主体，也让手势命中区与按钮命中区互不重叠
      //（按钮不是本节点的子节点 → 点按钮不会同时起一个 PanGesture，手势仲裁最简单）。
      Stack() {
        // 照片本体抽成 @Builder：它有**两个源**（静态 URI / 动图 descriptor），
        // 但除源以外的每一个属性都必须完全一致 —— 分两份写迟早漂移，
        // 而漂移不会报错，只会让动图和静态图的观感不同（例如一个有缩放一个没有）。
        this.photoNode()
      }
      // 62% 与 SwipePage.ets 的 CARD_HEIGHT_RATIO 是同一个事实的两处表达：
      // 改一处必须改另一处。父组件量到 Stack 高之后乘 0.62 作为 cardHeight 传进来，
      // 所以 @Prop cardHeight 与本节点的高度是同一个值（不是估算）。
      .width('100%').height('62%')
      .backgroundColor('#EEE')
      .borderRadius(16)
      // **放大/平移后必须裁掉溢出**：Contain + 4× 的照片会画到卡片之外，
      // 不裁的话照片会盖住卡片下方的按钮行（那是"看不见的按钮还能点"的形态）。
      // 圆角是否被一并裁掉由平台决定（真机需看一眼），所以照片自身**不再**设 borderRadius：
      // 那会让 4× 时的圆角被一起放大成一个大圆角，比直角更难看。
      .clip(true)
      .translate({ x: this.dx, y: this.dy })
      .onAreaChange((oldVal: Area, newVal: Area) => {
        // 卡片盒子尺寸 = 照片做 Contain 的那个"框"，也是平移边界的两个输入之一。
        const w: number = Number(newVal.width);
        const h: number = Number(newVal.height);
        if (w > 0 && h > 0) {
          this.boxW = w;
          this.boxH = h;
          this.reclampPan();
        }
      })
      // ── 三个手势共存（本批最大风险点）──────────────────────────────────────
      // 手势组必须是 **GestureMode.Parallel**，这不是随手选的：
      //   · `Exclusive` 的语义（gesture.d.ts:180-186）是「一旦有手势识别成功，识别过程即结束、
      //     其余手势一律判为未识别」。而 `PanGesture({fingers: 1})` 的 fingers 是**最少**手指数
      //     —— 两指捏合时第一根手指动 5vp 就会让 Pan 先识别成功，Pinch **从此再也不会被识别**，
      //     缩放整个失效。这是"看起来对、一上真机就没反应"的典型形态。
      //   · `Parallel` 语义（同文件 170-179）：「各手势并发识别，互不影响」—— 三者都会触发，
      //     于是冲突改由**回调里的判据**处理（这也正是可以单测/可推理的那一层）：
      //       ① Pan 的 update 里用 `e.fingerList.length > 1` 把"多指"定性为缩放（不写 dy）；
      //       ② Pinch 只改 scale/pan，从不写 dy；
      //       ③ Tap(2) 只做复位。
      //   · 顺序：Pan 在最前（它与既有行为完全一致，改动最小），其余两个是纯新增。
      //   · 不用 `.parallelGesture()`/多次 `.gesture()`：显式的手势组让"三者是并行的"
      //     成为**代码里读得到**的事实，而不是依赖平台对多次绑定的默认仲裁。
      .gesture(
        GestureGroup(GestureMode.Parallel,
          PanGesture({ fingers: 1, distance: 5 })
            .onActionStart((e: GestureEvent) => {
              // 基线必须先刷新：若把闸门放在首行，一次跨越 210ms 边界的拖拽会保留
              // 上一次手势的 lastY/lastT，解禁后的首个 update 用陈旧基线算出巨大的
              // 伪速度（|Δ| > NAV_VELOCITY），使新卡片在几十 vp 拖动下被误判翻页。
              // 闸门职责由 onActionUpdate 与 settle() 承担，这里不早退。
              // 同理，作废也不在这里早退 —— 本回调是唯一刷新 lastY/lastT 与 gestureId 的地方：
              //   (a) 跳过基线刷新：一旦「闸门在两次手势之间解除」，解禁后的首个 update 就会用
              //       陈旧基线算伪速度（上一条注释讲的泄漏会原样重演）；
              //   (b) 跳过 gestureId 刷新：作废会自持 —— gestureId 停在旧卡、item 已是新卡，
              //       判据 2 恒真，连新手势也在守卫处被挡，gestureId 再也刷不了
              //       → 整页手势永久死锁（与 navOut 的 try/finally 要避免的死锁同类）。
              // 作废只在 update/settle 两道出口上按 isGestureVoided() 判定，基线照常刷新即可。
              this.gestureId = this.item.photoId;   // 手势归属：本手势是在这张卡上开始的
              // 新手势开始 = 上一次定案的保护窗口到此为止（判据 1 的时限，见 isGestureVoided）。
              // 定案之后才开始的手势是新的一次操作，不该被上一次定案作废：否则
              //「按钮定案 → 返回同一张」会让判据 1 恒真且不自愈，那张卡彻底锁死
              //（photoId 上两条路径完全一样，先后关系是唯一区分得开的信息）。
              this.decidedDuringGesture = false;
              this.lastY = e.offsetY;
              this.lastT = Date.now();
              this.velocity = 0;
              // 本批新增：本次手势的缩放起点。平移的**基准**同样是"手势开始时"的值 ——
              // PanGesture 的 offsetX/offsetY 是相对手势起点的累计值，用增量累加会漂移。
              this.gestureIsZoom = false;
              this.panStartX = this.panX;
              this.panStartY = this.panY;
            })
            .onActionUpdate((e: GestureEvent) => {
              if (this.animating) { return; }
              // ── ① 多指 = 缩放，不是翻页（本批新增的第一道判据）────────────────
              // 为什么必须在这里挡：`PanGesture({fingers: 1})` 的 fingers 是**最少**手指数，
              // 两指捏合照样会命中它 —— SDK 还明确写了这种情况下
              //「this callback updates the location information of only one finger each time」
              //（gesture.d.ts:1663），于是 offsetY 会在两根手指之间来回跳，
              // 算出巨大的伪速度，抬手时直接翻掉一张。
              // 判据用 `fingerList.length`（文档：触点列表"包含全部触点"）而不是"数非空项"：
              // 稀疏数组里的空洞会被 length 计入，而**多算一根手指的代价只是"这次不翻页"，
              // 少算一根的代价是"捏合被当成翻页"** —— 后者正是要消灭的缺陷，所以方向取保守。
              // `pinching` 是补充判据：Pinch 已被识别时，即使某一帧只报出一根手指
              //（第三指抬起等瞬时形态），也必须继续按缩放处理。
              if (e.fingerList.length > 1 || this.pinching) {
                this.gestureIsZoom = true;
                // 已经写进 dy 的那几 vp 必须**当场**归零：那是"捏合时第一根手指先动的 5vp"，
                // 留着会让卡片歪着停在半路。平赋值不做动画：位移只有几 vp，动画只是多一帧延迟。
                this.dy = 0;
                this.velocity = 0;
                this.lastY = e.offsetY;
                this.lastT = Date.now();
                return;
              }
              // ② 本次手势已定性为缩放：即使后来只剩一根手指（捏合中抬起一根）也不翻页、不平移。
              // 语义：一次缩放操作**不因为手指数变化而变成翻页操作**。
              if (this.gestureIsZoom) { return; }
              // 这张卡已定案/已翻页（例如另一根手指刚点了按钮），或本次手势的起点卡已经换走：
              // 作废它的后续手势，否则抬手时的 settle() 会以换卡后的新 photoId 上报，
              // 静默消耗一张用户没打算决定的照片。
              if (this.isGestureVoided()) { return; }
              // ── ③ 放大态：一指拖动 = 平移照片（不再是翻页）────────────────────
              // 这是"放大后能看清某个角落"的前提 —— 只放大不能拖，看到的永远只有中心，
              // 那等于把"放大"做成了半成品。模式开关由纯函数 isZoomed 判定，1× 时
              // **必须**回到翻页（否则用户上滑没反应，是最严重的手感故障；容差见 ZOOM_EPS）。
              if (isZoomed(this.zoomScale)) {
                const c: ZoomSize = this.contentSize();
                const o: PanOffset = clampOffset(
                  this.panStartX + e.offsetX, this.panStartY + e.offsetY,
                  c.width, c.height, this.boxW, this.boxH, this.zoomScale);
                this.panX = o.x;
                this.panY = o.y;
                // 不写 lastY/velocity：平移不入翻页的判据（settle 在放大态直接早退），
                // 留着它们只会在缩回 1× 的那一帧被当成"上一次拖拽的陈旧基线"。
                return;
              }
              const now = Date.now();
              const dt = now - this.lastT;
              if (dt > 0) { this.velocity = ((e.offsetY - this.lastY) / dt) * 1000; }
              this.lastY = e.offsetY;
              this.lastT = now;
              this.dy = e.offsetY;   // 只跟手写 dy：横向（dx）在本模型下没有写入路径
            })
            .onActionEnd((e: GestureEvent) => {
              // 顺序不可颠倒：settle() 要靠 gestureId 判定「这次手势该不该作废」，
              // 先清空等于抽掉它唯一的判据（见 isGestureVoided 判据 2）。
              // 同理它也要读 gestureIsZoom（缩放手势不翻页、不记回弹），所以在 settle 之后才清。
              this.settle();
              // 手势已结束：清掉「手势起点」记录。
              // 不清的后果是主流程可达的按钮全失效 —— gestureId 的语义是「本次手势的起点」，
              // 而按钮点击不产生手势，于是上滑 A→B 后 gestureId 仍停在 A，
              // 判据 2（gestureId !== item.photoId）对 B 上的任何按钮点击恒真 → 点了没反应，
              // 直到用户在卡上再拖一次（≥5vp）才刷新。手势结束即作废判据的生命周期终点。
              this.gestureId = '';
              // 缩放的定性同样只在本次手势期间有效（与 gestureId 同一生命周期）
              this.gestureIsZoom = false;
              // **不**在此清 decidedDuringGesture：判据 1 要求 gestureId === decidedId ≠ ''，
              // 而上面刚把 gestureId 清空 —— 手势结束后它已无读取者，清它是无读者的冗余写入。
              // 它的生命周期由 onActionStart（清）与 commit（置真）划定，不再加第三个写入点。
            })
            .onActionCancel(() => {
              // 手势被取消时走这里而**不**走 onActionEnd（SDK：取消 = PanGesture 识别成功之后
              // 收到触摸取消事件；结束 = 所有手指抬起）。所以本回调也必须收尾：不清 gestureId，
              // 它就留着手势起点，而按钮点击不产生手势 —— 起点卡不是当前显示的那张时，
              // 判据 2（gestureId !== '' && gestureId !== item.photoId）对这张卡上的任何按钮恒真
              // → 四个按钮全部失效，直到用户再拖一次。
              //
              // 判据 2 需要「起点卡**已经**不是当前显示的那张」，取消本身并不制造这个状态：
              //   - 取消时若没换过卡（单指取消、且没点过按钮）→ gestureId === item.photoId，
              //     判据 2 为假；判据 1 也要求 item.photoId === decidedId，同样为假
              //     → 这次取消本来就不会让按钮失效。
              //   - 真正会死锁的是「手势还在途时起点卡被换走」：此后 item 已是 B 而 gestureId
              //     停在 A，判据 2 为真，且要等用户再拖一次（onActionStart 刷新起点）才自愈；
              //     判据 1 也救不了（它额外要求 item.photoId === decidedId，而这里 item 已是 B）。
              //     起点卡在途时被换走的两条路径都可达：
              //       (a) 拖动中点了动作按钮 —— commit 会当场换卡，且**不**设 animating，在途手势
              //           不会被闸门挡住（两指：一指拖 A、另一指点按钮；单指同理）。
              //       (b) 拖动中完成了一次上滑 —— navOut 播完 200ms 动画后、在 210ms 回调里换卡，
              //           这 210ms 内发生的取消都早于换卡（取消后手势即结束，不会再走 settle）。
              //
              // 语义：取消**不是**一次滑动尝试，所以**不上报回弹**（与「队首下滑静默弹回」同一口径）；
              // 但卡片必须归位（否则它停在拖到一半的位置），故用 springBack(false)。
              //
              // 已换走时跳过归位：那张已经定案、正在被新卡取代（情形 (a) item 已被换走，情形 (b)
              // 换卡回调已经在跑），两个换卡出口都已处理过它 —— commit 先归零 dx/dy 再上报，
              // navOut 在 210ms 回调的 finally 里平赋值归零，所以归位在此是多余的；
              // 更要紧的是**不要**给它开防抖窗口：窗口会落在新卡头上，吞掉新卡在 150ms 内的
              // 首个真实回弹，让 rollbackRate 偏低（偏好看方向，理由同 endSpringWindow 的说明）。
              // 没换走时必须照常归位，否则那张卡会停在拖到一半的位置。
              //
              // 本批新增的第二个跳过条件（gestureIsZoom）：一次**缩放**手势没有拖过卡片
              //（dy 在识别出多指的当场就归零了），归位无事可做；而它照样会开一个 150ms 的
              // 回弹窗口 —— 那会在用户捏合之后吞掉新卡的首个真实回弹，同样是让指标偏低。
              //
              // 归位与收尾的顺序不可颠倒：springBack(false)（它内部会 endSpringWindow() 并起
              // 归位动画）在前、gestureId = '' 在后 —— 与 onActionEnd 的顺序同理
              //（清空要先让收尾动作读完状态）。
              // 用 springBack(false) 而**不是** settle()：settle() 会按位移/速度替用户判定翻页或回弹，
              // 而「手势被取消」不是一次翻页意图，按位移/速度决定会凭空翻掉一张、或记一次伪回弹。
              if (!this.isGestureVoided() && !this.gestureIsZoom) {
                this.springBack(false);
              }
              this.gestureId = '';
              this.gestureIsZoom = false;
              // **不**在此清 decidedDuringGesture：与 onActionEnd 的既定处置一致 —— 上面清空
              // gestureId 之后判据 1 不再成立，它已无读取者（见 onActionEnd 的说明）。
            }),

          // ── 二指捏合缩放（本批新增）────────────────────────────────────────
          // 它**不写 dy**、不产生任何 CardEvent：缩放是纯粹的显示状态，与决策/翻页正交。
          // 三个回调的判据各有一条不能省的：
          //   · start/update 都要挡 animating：翻出动画期间卡片视觉上已经飞走，
          //     此时改它的缩放没有意义（而且 210ms 后就换卡了，改了也不会被看到）；
          //   · update 必须挡 `!pinching`：换卡时 resetZoom() 会把 pinching 置假，
          //     这就是"换卡作废在途捏合"的机制 —— 否则换卡后残留的那一次 update 会用
          //     **上一张**的 scaleAtPinchStart 去算新卡的缩放，新卡一出现就是放大的
          //     （正是"换卡必须复位"要消灭的形态）。它与 Pan 用 isGestureVoided() 是两种
          //     机制、同一目的：Pan 有 gestureId（在 onActionStart 记手势起点卡），
          //     捏合没有 —— 所以它用"每卡复位时清掉的那个标记"来判归属。
          PinchGesture({ fingers: 2 })
            .onActionStart((e: GestureEvent) => {
              if (this.animating) { return; }
              this.pinching = true;
              // 连乘基准只能是**手势开始时**的 scale：`e.scale` 是相对手势起点的累计值，
              // 每帧拿 this.zoomScale 去乘会指数放大（手指不动也会在几帧内飙到 4×）。
              this.scaleAtPinchStart = this.zoomScale;
            })
            .onActionUpdate((e: GestureEvent) => {
              if (this.animating || !this.pinching) { return; }
              this.zoomScale = clampScale(this.scaleAtPinchStart * e.scale);
              // 缩放变了 → 平移余量跟着变。**这就是"复位"的机制**：缩回 1× 时余量恒为 0，
              // 于是平移自动清零（不需要另写一段"缩小了就归位"的代码）。
              this.reclampPan();
            })
            .onActionEnd(() => {
              // 只清 pinching，**不**清 gestureIsZoom：后者属于本次 Pan 手势
              //（一次缩放操作不该因为一根手指抬起就让仍在途的那根手指开始翻页），
              // 由 Pan 的 onActionEnd / onActionCancel 收尾。
              this.pinching = false;
            })
            .onActionCancel(() => { this.pinching = false; }),

          // ── 双击复位到 1×（本批新增）────────────────────────────────────────
          // 双击是"我放大了想退回去"的通用手势（用户不需要先精确地捏回 1×）。
          // 闸门口径与四个按钮完全一致：animating（翻出期间不受理）+ isGestureVoided()
          //（另一根手指正在拖这张卡时，这次双击属于哪一张不确定）。
          // 注意：它**不**改 dy、**不**上报任何事件 —— 复位是显示状态，不是一次决策。
          TapGesture({ count: 2 })
            .onAction((e: GestureEvent) => { this.onDoubleTap(); })
        )
      )

      // 四个按钮：卡片外侧、卡片下方一行等分（layoutWeight(1)）。位置取舍见 M1 报告：
      // 塞进卡片内会压住照片主体（违反「不遮挡」），放在卡片外还顺带避开了与卡片
      // PanGesture 的竞争。顺序按使用频率与危险度排：主页面（回首页）/ 归档 / 上墙 / 收藏。
      Row({ space: 8 }) {
        Button('主页面')
          .fontSize(12).height(40).layoutWeight(1)
          .backgroundColor('#E6E6E6').fontColor('#333333')
          .onClick(() => { this.tapHome(); })
        Button('归档')
          .fontSize(12).height(40).layoutWeight(1)
          .backgroundColor('#E6E6E6').fontColor('#333333')
          .onClick(() => { this.tapDecide('archive'); })
        Button('上墙')
          .fontSize(12).height(40).layoutWeight(1)
          .backgroundColor('#1F6FEB').fontColor('#FFFFFF')
          .onClick(() => { this.tapWall(); })
        Button('收藏')
          .fontSize(12).height(40).layoutWeight(1)
          .backgroundColor('#E6E6E6').fontColor('#333333')
          .onClick(() => { this.tapDecide('fav'); })
      }
      .width('100%').height(44)
    }
    // 86% 与 SwipePage.ets 的 CARD_WIDTH_RATIO 曾经是同一个事实的两处表达；横向模型取消后
    // 宽度不再参与任何阈值，那个常量已随之删除，这里的 86% 只是纯布局。
    .width('86%').height('100%')
    // 卡片 + 按钮行作为一个整体居中：比「卡片单独居中」整体上移半个按钮行（约 22vp），
    // 视觉位置与重构前基本一致，同时百分高度有确定的换算基准（= 父组件量到的高度）。
    .justifyContent(FlexAlign.Center)
  }

  private settle(): void {
    if (this.animating) { return; }   // 已在翻出动画中，忽略（防御性；正常路径已被手势闸门挡住）
    // 本批新增的第一道闸：**这次手势是缩放，不是滑动**。
    // 两指落下过（gestureIsZoom）之后抬手，绝不能按 dy/velocity 去判翻页 ——
    // 那些值要么是 0（多指判据已把它们归零），要么是"只有一根手指时留下的陈旧基线"，
    // 用它判会凭空翻掉一张。也**不**记回弹：缩放不是一次"滑了但没结果"的尝试，
    // 记进去会让 rollbackRate 因为用户捏了两下而升高（指标失真）。
    if (this.gestureIsZoom) { return; }
    // 本批新增的第二道闸：**放大态下的一指拖动是平移照片，不是翻页**。
    // 与 onActionUpdate 的模式开关是同一个判据（纯函数 isZoomed），两处必须一致：
    // 只在一处挡的话，拖动时照片在平移、抬手却翻页 —— 那是本批最坏的形态。
    if (isZoomed(this.zoomScale)) { return; }
    // 本次手势的卡已定案/已换走：作废，否则会以换卡后的新 photoId 记一次决定
    //（或记一次挂在下一张头上的伪回弹）—— 按钮路径没有 animating，这里是唯一出口闸门。
    if (this.isGestureVoided()) { return; }
    // 用真实卡高算位移阈值：600 只是父组件尚未量出高度时的兜底，不是判定依据。
    const h = this.cardHeight > 0 ? this.cardHeight : 600;
    const commitDist = h * NAV_DISTANCE_RATIO;
    const fast = Math.abs(this.velocity) > NAV_VELOCITY;
    const far = Math.abs(this.dy) > commitDist;

    if (this.dy < 0 && (fast || far)) {
      this.navOut(-1);          // 上滑 → 下一张
    } else if (this.dy > 0 && (fast || far)) {
      // 下滑 → 上一张。idx === 0（队首）时没有上一张：走普通回弹而不是 navOut ——
      // navOut 会先把卡片送出视野，而父组件的 navigate(1) 只能早退，卡片原地弹回 = 像故障。
      // 但这一次回弹**不上报**（report=false；产品裁决：「不算，静默弹回」）：回弹率的语义是
      //「一次滑动尝试没能产生结果」，而队首下滑根本不是滑动尝试 —— 往前已经没有可翻的下一张，
      // 用户想「回看上一张」的意图在队列边界上不存在。上报它会让指标随用户在队首来回蹭而失真。
      if (this.canNav(1)) { this.navOut(1); } else { this.springBack(false); }
    } else {
      // 没过阈值 = 一次真正的「滑了但没结果」：照常上报，这是回弹率分子的唯一来源。
      this.springBack(true);
    }
  }

  /**
   * 翻页出口：卡片先沿垂直方向移出视野，再在 210ms 后上报 'nav'（不产生决策）。
   * 注意翻页**不设** decidedId（前任论证：收益为零、代价为正 —— 它引入一条不自愈的永久作废
   * 路径）：换卡本身由 isGestureVoided() 的判据 2 作废，且判据 2 不可逆、覆盖所有换卡出口。
   */
  private navOut(dir: number): void {
    this.animating = true;
    // 翻页也是「这张卡到此为止」：不结束回弹窗口，残留窗口会吞掉下一张的首个回弹。
    this.endSpringWindow();
    const h = this.cardHeight > 0 ? this.cardHeight : 600;
    // dir = 1（上一张）卡片向下走；dir = -1（下一张）卡片向上走。
    // 1.2 倍卡高（= 0.744 倍可用高度）**不**足以让卡片完全离开视野（需要约 1.36 倍卡高），
    // 这是刻意的：210ms 的换卡与动画结束只差 10ms，留下的一小条卡片正好遮住「换成新照片」
    // 那一帧（若完全飞出，那一帧会露出页面底色 = 闪一下）。
    const outY = dir > 0 ? h * 1.2 : -h * 1.2;
    animateTo({ duration: 200, curve: Curve.EaseOut }, () => { this.dy = outY; });
    if (this.flyTimer !== -1) { clearTimeout(this.flyTimer); }
    this.flyTimer = setTimeout(() => {
      this.flyTimer = -1;
      const p: NavPayload = { dir: dir };
      const ev: CardEvent = { kind: 'nav', payload: p };
      // 顺序：先上报（换卡）再归位位置。
      // 若先归位，会出现一帧「旧卡弹回中央」——连拍照片下新旧卡视觉几乎一样，
      // 用户会把「弹回来的旧卡」当成「照片没消失」。
      // try/finally：onDecide 抛错时也必须把闸门放下，否则实例复用会让整页手势死锁。
      try {
        this.onDecide(this.item.photoId, ev);
      } finally {
        // 归位一律**平赋值**，不要用 animateTo：节点被复用，动画会让已换新的照片
        // 继续渲染插值位姿 = 用户看到的「照片跳一下」。
        this.dy = 0;
        this.dx = 0;
        this.animating = false;
        // 本批新增：缩放/平移同样不能留给下一张（组件实例复用，@State 不会自己回 1×）。
        // 这与 onItemChanged 里的那次复位是**同一个事实的两处保险**，
        // 取舍与 dx/dy 完全一致：宁可多写一次幂等的复位，也不要赌"换卡回调一定先到"。
        // 动图**不**在这里释放 —— 它的换卡时刻只有一个（@Prop item 变化），
        // 提前在这里释放只会在随后的 onItemChanged 里被重新装载一次（白解一遍帧）。
        this.resetZoom();
      }
    }, 210);
  }

  /**
   * 三个动作按钮（归档 / 上墙 / 收藏）共用的出口。三件事缺一不可：
   *   1) 结束回弹窗口（否则下一张的首个回弹会被残留窗口吞掉）；
   *   2) 平赋值归零位移（拖到一半时点按钮；不要 animateTo，理由同 navOut 的 finally）；
   *   3) **在 onDecide 之前**记下 decidedId —— onDecide 会同步换卡，之后 this.item
   *      已经不是这张卡了，而在途手势（另一根手指）仍以它为起点。判据 1 靠这条记录
   *      当场作废那个手势，否则它会以换卡后的**新** photoId 上报，静默消耗一张照片。
   *      同一步把 decidedDuringGesture 置真：判据 1 的时限 = 「定案发生在这一次手势期间」，
   *      少了它就会连「返回同一张之后的新手势」一起作废（那个锁的成因，见 isGestureVoided）。
   */
  private commit(ev: CardEvent): void {
    // 与 onActionUpdate / settle() 同口径的闸门：翻出动画期间卡片视觉上已经飞走
    //（用户看到的是下一张的位置），但 idx 要等 navOut 的 210ms 回调才推进 ——
    // 这段窗口里 @Prop item 仍是已经飞走的那张，此刻再点一下（或另一只手指）
    // 会让同一张被上报两次 → SwipePage.handle() 跑两次 → idx 连跳两格
    // → 静默跳过一张照片。所以动画期间一律不接受按钮点击。
    if (this.animating) { return; }
    // 这张卡已定案，或本次在途手势的起点卡已经换走：不再接受新的动作上报。
    if (this.isGestureVoided()) { return; }
    this.endSpringWindow();
    // @State 不随 @Prop item 变化而自动重置 —— 组件实例是复用的（见 navOut 的 try/finally），
    // 新卡不会自己回到 dy = 0，所以归零必须显式做。
    this.dx = 0;
    this.dy = 0;
    // 本批新增：缩放/平移与位移同一条理由（实例复用不会自己回 1×），
    // 且这里**必须**复位 —— 用户完全可能放大着看细节时直接点「归档」，
    // 那张卡离开时若留着 4× 的状态，下一张一出现就是放大的。
    // 动图不在这里释放：见 navOut 的说明（换卡时刻只有一个）。
    this.resetZoom();
    // 注意：动作按钮**不**走 navOut() —— 那条路会设 animating 并延迟 210ms 才上报，
    // 而这里要立即上报（用户点的是动作，不是翻页）。所以上面只是把拖到一半的偏移归零，
    // 不涉及 animating；按钮在同一帧内被点两次（两指同点）时 @Prop item 尚未更新、
    // 第二次仍带着旧 photoId，这种重复由 SwipePage.handle() 的同 photoId 去重兜住。
    // 但「另一根手指还在拖这张卡」不同：idx 前进后它会以**新** photoId 上报，
    // 同 photoId 去重拦不住。所以定案必须当场记下，与上报同一个同步块。
    this.decidedId = this.item.photoId;
    this.decidedDuringGesture = true;
    this.onDecide(this.item.photoId, ev);
  }

  private tapDecide(action: 'archive' | 'fav'): void {
    const p: DecidePayload = { action: action };
    const ev: CardEvent = { kind: 'decide', payload: p };
    this.commit(ev);
  }

  /** 「上墙」= 当场把这张挂上地图，不必先收藏（上墙是从收藏里精选，两者不是互斥状态）。 */
  private tapWall(): void {
    const ev: CardEvent = { kind: 'wall' };
    this.commit(ev);
  }

  /** 「主页面」= 回首页（认领页）。导航出口，不产生决策，所以不走 commit()、也不写 decidedId。 */
  private tapHome(): void {
    // 闸门口径与其余三个按钮（归档 / 上墙 / 收藏，统一走 commit）**完全一致**，两条都要：
    //   - animating：翻出动画期间卡片视觉上已经飞走、而 idx 还要等 navOut 的 210ms 回调才推进，
    //     这段窗口里点「主页面」会让用户在「下一张正在就位」的中途离开这一页 —— 该点按落在
    //     哪一张的语义不确定（他们可能是想对下一张做决定）。与按钮闸门同一取舍：动画期间一律不受理。
    //   - isGestureVoided()：正在拖这张卡的那根手指（另一根手指点按钮）会让「这次点按属于哪张」
    //     同样不确定；与 commit 同口径。
    if (this.animating) { return; }
    if (this.isGestureVoided()) { return; }
    // 不调用 endSpringWindow()、不归零 dx/dy：那两件事是「这张卡到此为止」的收尾，而回首页
    // 不改这张卡的状态 —— 页面紧接着就退出，未落盘的决策由 SwipePage.onPageHide/aboutToDisappear
    // 的 flushSave() 收尾（见 pages/SwipePage.ets），不依赖这里做任何状态清理。
    this.onHome();
  }

  /**
   * 手势回弹：动画归位 +（report 为真时）上报一次回弹。
   * report 的两个取值与「这是不是一次滑动尝试」一一对应，调用点只有 settle() 的两支：
   *   - 没过阈值 → true：滑了但没结果，是回弹率分子的唯一来源，不得变成 false；
   *   - 队首下滑（canPrev 为假，无法再往前）→ false：不是一次滑动尝试（产品裁决），
   *     只做视觉归位，不进任何指标。
   * report 只决定**上不上报**：防抖窗口（springTimer）与归位动画两者的行为完全不变，
   * 所以「静默弹回」不会在窗口管理上留下任何差异（它照样开窗、照样在 150ms 后关窗）。
   */
  private springBack(report: boolean): void {
    // Ruling 29：rolledBack 是「回弹率 <3%」验收指标的唯一数据源，
    // 快速连划不得重复上报同一次回弹；但手势仍可继续（不设 animating）。
    const alreadyReported = this.springTimer !== -1;
    if (!alreadyReported && report) {
      // 回弹 = 用户犹豫过（滑了但没过阈值），计入回弹率（每张卡每个回弹窗口只计一次）
      const out: SwipeRollback = { kind: 'rollback' };
      this.onDecide(this.item.photoId, out);
    }
    // 旧窗口先结束、再开新窗口：等价于原来的「有就清掉、然后重设」，防抖语义不变。
    this.endSpringWindow();
    this.springTimer = setTimeout(() => { this.springTimer = -1; }, SPRING_BACK_MS);

    animateTo({ duration: SPRING_BACK_MS, curve: Curve.Friction }, () => {
      this.dx = 0;
      this.dy = 0;
    });
  }
}
