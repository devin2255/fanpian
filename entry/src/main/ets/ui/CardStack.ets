// 刷照片的核心交互：一张可上下滑动的卡片（spec §5.1；M1 交互模型重构后）。
// 四个已验证的设计事实：
//   1. 上滑 = 下一张、下滑 = 上一张（抖音式翻页），翻页本身不产生决策；但下滑回到刚看过的那张时，
//      会把那张的决策从内存与盘上一并撤销，让它重新可决定（见 pages/SwipePage.ets 的 navigate）；
//   2. 三个动作（归档 / 上墙 / 收藏）与「主页面」都是卡片外侧下方的按钮，卡片本体只承载翻页手势。
//      「主页面」只做页面级导航（回首页），不产生任何内容决策 —— 详见 onHome。
//      左右滑手势全部取消 —— 斜着滑时无法判定方向归属，与上下滑直接冲突；
//   3. 阈值必须同时落在「速度」与「位移」两个维度：轻轻一甩能过，拖到位也能过。
//      基准是**阈值基准高**（不再是卡宽），由父组件经 onAreaChange 传入（见 cardHeight）；
//      ⚠️ batch-42 起它与"卡片的可见高度"是**两个不同的数**（卡片填满可用区、基准高仍是 0.62×可用区）——
//      这是"消除上下两条空白带"与"阈值一个都不许动"这两条要求能同时成立的唯一办法，见 build()。
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
// ── 本批（task-21）新增的一件事：动态照片（拍摄的 Live Photo）长按播放 ──────────
//   7. **动态照片**：用户要的是「刷卡时**默认不自动播**，**长按**才播，松手回静态」。
//      实现只有一句话：**播放器组件默认不挂载，只在长按按住期间存在**
//      —— `MovingPhotoView` 是重组件（要解码视频），常驻等于每张卡都替用户预先解码。
//      识别判据（`PhotoSubtype.MOVING_PHOTO`）与"长按该不该起播"的闸门都在
//      `core/movingPhoto.ts`（纯函数 + 单测），平台侧读取在 `data/movingPhotoSource.ets`。
//      与动图（第 5 条）的关系：**两条路互不相干**（动图 = `AnimatedDrawableDescriptor`
//      喂 `Image`；动态照片 = `MovingPhotoView`），一张照片最多走其中一条。
//
//   ⚠️ 本批最大的风险是**手势仲裁**：现在卡片上有四个手势（Pan / Pinch / 双击 Tap / 长按）。
//      逐条分析写在长按手势那一节；核心结论是「长按**不写** gestureId/decidedId，
//      不参与作废体系，它的作废由**换卡即卸载**承担」（与动图的 releaseAnim 同一机制）。
//
// ── 依赖方向（本批新增的两条）──────────────────────────────────────────────
//   `ui/` → `data/animSource`。动图的帧数组是**平台资源**（`fileIo` + `Image` + 一个
//   与 Image 组件 1:1 绑定的 `AnimatedDrawableDescriptor`），它必须由**渲染它的那个组件**
//   持有：把它经 `@Prop` 从页面传下来会有两个问题 ——
//     · `@Prop` 对对象做拷贝，而 descriptor 是原生对象，"拷贝后还指得回同一个组件吗"
//       是框架内部行为，SDK 又明确要求 descriptor 与 Image 是 **1:1**（`drawableDescriptor.d.ts:520`）；
//     · 平移边界还需要这张照片的**固有像素尺寸**（`AnimFrames.srcW/srcH`），
//       拆成"页面传 descriptor + 页面传宽高"就是同一个事实的两处表达，迟早漂移。
//   所以：谁渲染，谁持有，谁释放。
//
//   `ui/` → `data/movingPhotoSource`（本批新增）。同一原则，但理由里多一条**必要性**：
//   `MovingPhoto` **没有 release API**，"放手"只能靠**唯一的持有者**丢掉引用 ——
//   而唯一需要它的地方就是 `MovingPhotoView({ movingPhoto: ... })`，也就是本文件。
//   经 `@Prop` 传到本文件反而会多出一个持有者（唯一的持有者变成两个），
//   那正好把"换卡即放手"这条唯一的释放路径弄坏。
//   ⚠️ 与动图的一条**关键差别**：动态照片的对象是**异步**来的（探针：`requestMovingPhoto`
//   回调），所以"结果还算不算数"要有一整套判定：
//   `motionSeq`（递增序号凭据，留在本文件）、以及**状态机**的三个字段
//   「已下结论 / 有在途探测 / 本次访问的重试次数」。
//   后三个字段分开是**缺陷 D4 的修法**：旧实现把它们合成**一个**字段，
//   于是"这次没探到"与"确定不是动态照片"同形 → 瞬时失败被当成永久结论。
//   它们连同四道闸与三条过期判据一起住在 `core/motionProbeState.ts`（纯逻辑，有 Node 单测）——
//   那是本批唯一的可测边界：平台那一半（本文件）依赖真机 UI 上下文，永远只能真机验。
//   而"结果还算不算数"这一部分在 animSource 里是靠"解帧比换卡慢"这个事实自然覆盖的（那里也有 seq）。
//   另：本文件**没有**给动态数据做"页面级"的预取或缓存 —— 缓存所有权会立刻破坏上面那条唯一性。
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
// `MovingPhotoView` 是 ArkUI 组件，但它由 **MediaLibraryKit** 导出（不在 component/ 下），
// 所以必须显式 import —— 与探针逐字同款（探针报告 §13 的 SDK 原文）。
import { MovingPhotoView, MovingPhotoViewController } from '@kit.MediaLibraryKit';
import { AnimFrames, loadAnimFrames } from '../data/animSource';
import { MotionHandle, MotionProbeResult, loadMotion } from '../data/movingPhotoSource';
import { clampScale, isZoomed, resolveContentSize, clampOffset, SCALE_MIN, ZoomSize, PanOffset } from '../core/zoom';
import { MotionStartGate, shouldStartMotionPlayback, MOTION_LONG_PRESS_MS } from '../core/movingPhoto';
// 动态照片「重试状态机」的**纯逻辑**（缺陷 D4）：闸门 / 迁移 / 过期判据全部在那边，
// 有 Node 单测（core/motionProbeState.test.ts）。本文件只留"平台那一半"：
// `motionSeq`（序号凭据）、`motionOwner`（句柄唯一持有者）、日志、播放器。
import {
  MOTION_PROBE_MAX_ATTEMPTS, MotionProbeArm, MotionProbeBegin, MotionProbeSettle,
  MotionProbeState, MotionProbeTicket, MotionProbeVerdict,
  armMotionProbe, beginMotionProbe, motionAttempts, newMotionProbeState,
  releaseMotionProbe, settleMotionProbe
} from '../core/motionProbeState';
// 设计令牌（**全项目唯一的视觉取值处**）。本文件对令牌的用法有一条额外的硬约束：
// **只改属性值，不新增节点、不新增手势、不动任何动效时序** —— 见 build() 里四个按钮
// 上方那段"视觉层级方案"，以及 `C_PHOTO_MAT` 处"刻意不加阴影、不加描边"的说明
//（那里同时记着 batch-41 的更正：卡片边界改由**填充**承担 —— 仍旧不加阴影、不加描边）。
import {
  BOTTOM_SAFE_INSET,
  C_ACCENT, C_ARCHIVE, C_FAV, C_ON_PHOTO, C_PHOTO_MAT, C_SCRIM, C_SURFACE, C_TEXT_DIM,
  F_CAPTION, F_LABEL, LW_BORDER, R_LG, R_MD, S1, S2
} from '../core/designTokens';

// 与 pages/SwipePage.ets 同款口径（DOMAIN / TAG 在本项目里是全局一致的）。
const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

/** 把 catch 到的值转成一行可打印文本（与 data/animSource.ets 的 errText 同款口径）。 */
function errText(e: Object): string {
  if (e instanceof Error) { return e.message; }
  return JSON.stringify(e);
}

/**
 * 把 vp 数四舍五入到 0.1 —— **只服务于日志可读性**（batch-44 的几何取证用）。
 * 与 `pages/SwipePage.ets` 的 `r1` 是同一个用途、同一个实现，但**刻意各留一份**：
 * 两份代码分属两个编译单元，谁改谁的那份都不会悄悄影响对方；而它的语义只是"打日志时少几位小数"，
 * 判据用的始终是节点量到的原值（`boxW/boxH/cardVis*` 一个都没有被它改写）。
 */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export const NAV_VELOCITY = 800;         // vp/s：轻轻一甩就翻页
export const NAV_DISTANCE_RATIO = 0.28;  // 卡高比例：拖到位也翻页
export const SPRING_BACK_MS = 150;

// 双击复位缩放的动画时长。与 springBack 的 150ms 同一量级：短到"立刻到位"、
// 长到能让人看出"这是复位而不是跳变"。刻意**不**导出：它不是任何判定的依据，纯观感。
const ZOOM_RESET_MS = 150;

// 长按播放期间的卡片描边宽度（vp）。它是**按压反馈**的一半（另一半是角标变成「播放中」）。
// 刻意用描边而不是"卡片轻微缩放"（任务里给的另一个例子）：上一批刚刚把
// `.scale()`/`.offset()`/`clip` 这套渲染管线在真机上验过一遍，再往同一个节点上叠一个
// render 变换，会让"照片的缩放"与"卡片的缩放"变成两个都要读文档才能确定顺序的变换
// （见 photoNode 里那段 offset 与 scale 分属布局/渲染两层、顺序是事实而不是约定的说明）。
// 描边是**布局内**的属性，不动任何变换，与上一批的成果零交互。
// 2vp 的依据：卡片宽度的 0.5% 左右，在 3x 屏上是 6px —— "看得见但不抢戏"。
const MOTION_PRESS_BORDER = 2;

/**
 * **一张卡在一次「访问」里最多发起几次动态照片探测**（缺陷 D4 的重试上界）。
 *
 * 常量本身与它的**全部论证**（为什么必须有上界、3 这个数是怎么来的、
 * 为什么不是"整会话只试一次"、为什么并发上界只作用在"同一张卡"这条轴上）
 * 都搬进了 `core/motionProbeState.ts`：那里是能被单测穷举的一侧，
 * 本文件只把它传给 `beginMotionProbe`。**常量只留一处定义** —— 抄成两份一定会漂。
 */

/**
 * 「这次没探到」的判决（瞬时失败）。
 *
 * `loadMotion` **意外** rejection 时用的就是它 —— 与 data 层那三种瞬时成因
 *（查库 0 条 / 请求超时 / 回传空）走的是**同一条迁移**（纯模块的 `missed` 分支：
 * 不写结论、只解除在途标记）。提成常量而不是在 `.catch` 里现拼一个字面量，理由很具体：
 * 拼错的两种方向各自都是 D4 的死法 —— 写成结论 = 这张卡再也不重试；
 * 忘了解除在途 = 这张卡被"同卡不并发"那道闸永久挡住。
 */
const MISSED_VERDICT: MotionProbeVerdict = { concluded: false, hasHandle: false };

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
  // **阈值基准高**（= 父组件量到的可用区高 × 0.62，见 SwipePage.ets 的 CARD_HEIGHT_RATIO）。
  // 600 只是父组件尚未量出高度时的兜底，不是判定依据。
  // ⚠️ batch-42 起它有三个读者，改名不是文字游戏 —— 它**不再**等于卡片的可见高度：
  //   ① `settle()`   → 位移阈值 = 它 × NAV_DISTANCE_RATIO；
  //   ② `navOut()`   → 翻出距离 = 它 × 1.2；
  //   ③ `build()`    → **照片盒**（Contain 的框）的高度。
  // 三者用同一个数不是巧合：①② 是"整张卡要拖多远/飞多远"的基准，改动前那个基准就是
  // 卡片盒的高度；③ 之所以也用它，是为了让"照片盒 == 阈值基准"这条改动前成立的等式
  // 继续只有**一处定义**（卡片可见盒已经变成"可用区 − 按钮行"，不再是这个数）。
  // 于是"卡片填满"这件事**不会**移动任何一个阈值（报告 §5 有改前/改后的数值对照表）。
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

  // ── 动态照片（本批新增）──────────────────────────────────────────────────
  // 「这张的动态照片对象已经就绪」——**角标与长按闸门用的是同一个布尔**。
  // 刻意不拆成两个（"它是不是动态照片"与"对象取到了没"）：拆开就会出现
  // "角标亮着但长按没反应"的窗口，用户没有任何办法理解那是什么意思。
  // 代价（写进报告）：角标比卡片晚一点点出现（后台取对象的耗时），
  // 好处是"角标可见" ⟺ "长按一定有效"这条契约是**结构**保证的。
  @State motionReady: boolean = false;
  // 「长按按住期间」——它同时是两件事：播放器组件的挂载开关、角标文案的开关。
  // **默认 false**：这就是"刷卡时动态照片默认不自动播"的全部实现（组件根本不挂载）。
  @State motionOn: boolean = false;
  // 动态照片对象的**唯一持有者**（与 animOwner 同一角色）。释放出口见 releaseMotion()。
  private motionOwner: MotionHandle | undefined = undefined;
  // ── 动态照片「重试状态机」的全部状态（缺陷 D4 的修法）────────────────────────
  // 旧实现把「正在取」与「已经有结论（含'不是动态照片'）」塞进**一个** `motionForId`
  // 字段，于是**瞬时**失败（requestMovingPhoto 超时 / 查库命中 0 条 / 取不到宿主 Context）
  // 也被写成了"这张已经探过"，而重新触发的唯一执行者是 `@Watch onItemChanged`，
  // 它第一件事就是按 photoId 去重 → **同一张卡在本会话内再也没有机会**：
  // 角标不亮、长按无反应，用户没有任何恢复动作（静默降级）。
  //
  // 现在那三个字段（结论 / 在途 / 尝试次数）连同**四道闸与三条过期判据**一起搬进了
  // `core/motionProbeState.ts`：纯数据 + 纯函数、零 `@kit.*`、零平台对象，
  // 于是"瞬时失败之后还能不能重试""重试有没有上界""过期结果会不会写脏新状态"
  // 从"只能真机手滑"变成 Node 单测里可以穷举的东西（core/motionProbeState.test.ts）。
  // 本文件保留的只有**平台那一半**：`motionSeq`（序号凭据）、`motionOwner`（句柄唯一持有者）、
  // 日志与播放器 —— 句柄的所有权与释放路径**一个字都没动**。
  private motionState: MotionProbeState = newMotionProbeState();
  // 取对象是异步的，换卡比它快时旧结果必须被丢弃 —— 与 animSeq 同款的递增序号凭据。
  // ⚠️ 它**刻意留在本文件**（不进 core）：递增时机与"放手句柄"是同一件事的两面
  //    （`releaseMotion` 会 +1），拆开就会让"换卡即作废"这条路径出现两个执行者。
  //    纯模块把它当作**调用方注入**的不透明数字（`MotionProbeTicket.seq`），不生成也不递增。
  private motionSeq: number = 0;
  // 播放控制器：**每次起播都新建一个**（探针就是这么做的：每个 trial 全新的
  // MovingPhotoViewController + 全新的组件实例）。复用一个控制器跨多次挂载/卸载会引入
  // "控制器还指着上一棵已销毁的节点吗"这种框架内部行为，不值得赌。
  private motionCtl: MovingPhotoViewController = new MovingPhotoViewController();
  // 「本次 Pan 手势期间起过一次长按播放」——settle() 用它决定**要不要记一次回弹**。
  // 生命周期与 gestureIsZoom 完全同款（写入：长按识别时置真 + Pan 的 update 里补置；
  // 清除：Pan 的 onActionStart / onActionEnd（在 settle 之后）/ onActionCancel，以及换卡复位）。
  // 三个写入点都是"置真"、唯一的清除者是**Pan 自己** —— 这样"手指抬起时两个手势的
  // 回调谁先到"就不影响 settle() 的判据（长按的 onActionEnd 不清它，见 onMotionRelease）。
  private gestureHadMotion: boolean = false;

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

  // ── 本批（batch-44）新增：**可见卡片**的量测（只进 hilog）────────────────────
  // 上面 boxW/boxH 量的是**照片盒**；这两个量的是**可见卡片容器**（外层 Stack）。
  // 两个一起量，才能把"照片盒与卡片各自由什么决定高度"从"读代码推"变成"设备上量"：
  //   照片盒高 = `@Prop cardHeight`（= 父组件量到的可用区高 × 0.62，**一个数**）；
  //   可见卡片高 = 可用区高 − 按钮行 48 − `BOTTOM_SAFE_INSET` 32（由 `layoutWeight(1)` 定）。
  // 它们**不是同一个来源**，这就是"照片尺寸与卡片可见高度解耦"这条不变量的落点。
  // 都是普通字段（不参与渲染，不该触发重渲染），只有 logCardGeometry() 读它们。
  private cardVisW: number = 0;
  private cardVisH: number = 0;
  // 两份日志各自的"上一次内容"：`onAreaChange`/`onComplete` 都可能被重复触发
  //（父组件重渲染、同一张照片重新解码），按内容去重才不会把日志刷成噪音。
  private geoKey: string = '';
  private photoKey: string = '';

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
    // 动态照片与动图**并行**起装载，两者互不影响（一张照片最多是其中一种；
    // 判定成本不同：动图是后缀白名单 + 解帧，动态照片是一次查库 + 一次对象请求）。
    this.ensureMotionForCurrent();
  }

  // 组件卸载（用户 210ms 内返回上一页）后不能再回调 onDecide。
  aboutToDisappear(): void {
    if (this.flyTimer !== -1) { clearTimeout(this.flyTimer); this.flyTimer = -1; }
    // 卸载也是「这张卡的回弹窗口到此为止」：不结束的话，残留 timer 的回调会晚于卸载触发。
    this.endSpringWindow();
    // 卸载 = 这张卡永远消失：动图帧必须在这里放手（见 releaseAnim 的三条出口）。
    this.releaseAnim();
    // 动态照片同理：先停播（组件随后被销毁）再放开句柄（见 releaseMotion 的三条出口）。
    this.resetMotion();
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
    // 动态照片：**先停播再放手**（顺序有意义 —— 播放器组件还挂着的时候让平台先停，
    // 而不是把"停止"这件事交给组件销毁时的析构）。这也正是"换卡 = 长按播放的作废时刻"：
    // 长按不写 decidedId/gestureId（见长按手势那一节），它的作废只能靠这条结构性出口。
    this.resetMotion();
    this.resetZoom();
    this.clearPhotoGeometry();
    this.ensureAnimForCurrent();
    this.ensureMotionForCurrent();
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
    // 本批新增：与 gestureIsZoom 同一条理由（换卡后遗留的"上次手势的定性"必须清掉）。
    // 它的读取者是 settle()：残留 true 只会让**下一张卡**的第一次回弹不上报（指标偏低），
    // 不会锁死任何手势 —— 但既然是同一个事实（"上次手势起过长按播放"），就一起清。
    this.gestureHadMotion = false;
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
    // batch-44：照片尺寸那行日志的**去重键**也必须跟着清 —— 否则「← 返回上一张」回到
    // 同一张时会因为键相同而**不打那一行**，而用户恰恰是拿那几行做"三种比例对照"的。
    // 语义与上面三个数完全一致：它们都是"这张照片长什么样"的度量，按卡（按次访问）重置。
    this.photoKey = '';
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

  /**
   * 卡片/照片盒几何的**设备读数**（batch-44 新增；只在 hilog 里，屏幕上不加任何东西）。
   *
   * ── 它回答的问题 ──────────────────────────────────────────────────────────────
   *   batch-43 把 `BOTTOM_SAFE_INSET = 32` 加在按钮行上，让**可见卡片**矮了 32vp。
   *   控制器质疑：若"可见卡片高"与"照片盒高"同源或相差不多，那么高受限的竖幅照片
   *   （3:4，照片高 = 照片盒高）会被**压小或裁掉** —— 而 batch-43 只举了横幅与方形
   *   （两种都是**宽受限**，照片尺寸只由盒**宽**决定，对盒高的变化天然不敏感）。
   *   本批的回答分两层：
   *     · **算**（离线，逐位对照 `d5cdf2c`）：照片盒是一个**固定数**（`@Prop cardHeight`），
   *       不是"可见卡片的百分比"，所以卡片矮 32vp 动不了它；本机可用区高下二者相差
   *       **200.5vp**，且"盒 < 卡"这条不等式对任意 `H > 210.5` 都成立 —— 不存在"相差不多"。
   *       三种比例的照片显示尺寸因此**逐位不变**（证明脚本 `fix-batch-44-layout.mjs`）。
   *     · **量**（本函数）：上面那句是"读代码 + 算术"，本函数让它在设备上可核 ——
   *       两个数各自量出来，`放得下`那一项直接回答"照片盒会不会被卡片挤到"。
   *   两层的结论必须一致；若真机上不一致（例如卡片高 ≠ 可用区 − 80），
   *   那就说明本页的布局假设在该机型/该窗口模式下不成立 —— 那正是要看见的东西。
   *
   * ── 怎么读（写在这里，报告里也有一份对着真机读的期望值）─────────────────────────
   *   · `照片盒` 应恒等于 `0.62 × 可用区H`（可用区H 见 SwipePage 的 `[标尺]` 那一行），
   *     **与卡片高无关** —— 这就是"解耦"的直接证据；
   *   · `可用卡片` 应恒等于 `可用区H − 80`（按钮行 48 + 净空 32）。若它等于 `可用区H − 48`，
   *     说明那 32vp 的 `margin` 没有被 `layoutWeight(1)` 算进固定高度 ⇒ 按钮行会溢出可用区
   *     （batch-43 的净空**没生效**）—— 这一行日志就是它的哨兵；
   *   · `照片盒/卡片` 应 ≈ **0.6954**（H = 738.14 时）；远小于 1 ⇒ 不存在"相差不多"。
   *
   * ⚠️ 边界：它是**只读**回调，不改任何布局、不进任何算式（`boxW/boxH` 的写入点仍在
   *    照片盒自己的 `onAreaChange` 里，本批只在那里加了一次调用）。
   *    它也**不**看 `@Prop cardHeight` 以外的高度来源 —— 那个数就是"照片盒高"本身。
   */
  private logCardGeometry(): void {
    if (this.cardVisW <= 0 || this.cardVisH <= 0) { return; }
    if (this.boxW <= 0 || this.boxH <= 0) { return; }   // 照片盒还没量到：等它那次回调
    const key: string = `${this.cardVisW}x${this.cardVisH}|${this.boxW}x${this.boxH}`;
    if (key === this.geoKey) { return; }
    this.geoKey = key;
    const slack: number = this.cardVisH - this.boxH;
    const fits: string = slack >= 0 ? '是' : '**否（照片盒比卡片高，会被裁）**';
    hilog.info(DOMAIN, TAG, '%{public}s',
      `[卡片几何] 可见卡片=${round1(this.cardVisW)}×${round1(this.cardVisH)} `
      + `照片盒=${round1(this.boxW)}×${round1(this.boxH)} `
      + `照片盒/卡片=${round1(this.boxH / this.cardVisH)} `
      + `照片盒放得下=${fits} 余量=${round1(slack)} `
      + `(照片盒应=0.62×可用区H；可见卡片应=可用区H−80；可用区H 见 [标尺] 行)`);
    // 与几何同一时刻打"阈值基准"，因为两者读的是**同一个 `@Prop cardHeight`** ——
    // 放在这里而不是另一个回调里，是为了让"照片盒 == 阈值基准"这条等式在同一屏日志里可核。
    this.logCardBasis();
  }

  /**
   * 把 `@Prop cardHeight`（= 照片盒高）**按父组件口径**再打一遍 —— 它同时是三个读者的输入
   * （位移阈值 / 翻出距离 / 照片盒），所以"它在真机上到底是多少"值得留一行。
   * 只读，且只在这一行日志里出现。
   */
  private logCardBasis(): void {
    hilog.info(DOMAIN, TAG, '%{public}s',
      `[阈值基准] cardHeight=照片盒高=${round1(this.cardHeight)} `
      + `⇒ 位移阈值=${round1(this.cardHeight * NAV_DISTANCE_RATIO)} `
      + `翻出距离=${round1(this.cardHeight * 1.2)} 速度阈值=${NAV_VELOCITY}`);
  }

  /**
   * 照片**实际绘制尺寸**的设备读数（batch-44 新增；只在 hilog 里）。
   *
   * 它是待办①"三种比例照片尺寸逐位不变"这条结论在真机上的**正面证据**：
   * 用户滑到一张竖幅照片时，这一行会打出 `内容=<宽>×<高>`，与离线表里的
   * `343.2×457.6`（3:4，H=738.14 时）对得上即为"照片没被改小"。
   * 三种比例在**同一次会话**里各滑一张，就能得到三行可对照的读数。
   *
   * ⚠️ 单位按本仓库既有口径：`源` 是 px（SDK 明说 onComplete 报的是像素），
   *    `内容` 是 vp（与 `resolveContentSize` 的既有用法一致，上一批真机验过）。
   *    **即便这个单位约定在别的机型上不成立**，"内容宽/内容高"的**比值**仍然有效 ——
   *    比值是判"哪一条边受限"的判据，与单位无关。
   * 只在"换了照片或换了尺寸"时打（`photoKey` 去重）：同一张解码两次不重复刷屏。
   */
  private logPhotoDrawn(): void {
    if (this.drawnW <= 0 || this.drawnH <= 0) { return; }
    if (this.boxW <= 0 || this.boxH <= 0) { return; }   // 盒还没量到：这一次先不打（下一次回调会再来）
    const key: string = `${this.item.photoId}|${this.drawnW}x${this.drawnH}`;
    if (key === this.photoKey) { return; }
    this.photoKey = key;
    const boxAspect: number = this.boxW / this.boxH;
    const limited: string = (this.drawnW / this.drawnH >= boxAspect) ? '宽受限' : '高受限';
    hilog.info(DOMAIN, TAG, '%{public}s',
      `[照片尺寸] 源=${this.srcW}×${this.srcH}px 内容=${round1(this.drawnW)}×${round1(this.drawnH)}(vp) `
      + `比例=${round1(this.drawnW / this.drawnH)} ${limited} `
      + `照片盒=${round1(this.boxW)}×${round1(this.boxH)}(盒比例=${round1(boxAspect)}) `
      + `(高受限的照片：内容高应恒等于照片盒高=cardHeight，与可见卡片高无关)`);
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

  // ── 动态照片：装载 / 播放 / 释放（本批新增）──────────────────────────────────

  /**
   * 为**当前这张**取动态照片对象（后台进行，**不阻塞刷卡**）。
   *
   * 三道闸都在 `data/movingPhotoSource.ets` 里（负缓存 → 查库 + subtype 判据 → 请求对象），
   * 这里只负责"触发一次"与"结果回来时还算不算数"。
   *
   * ── 去重拆成**三条**互不相同的判据（缺陷 D4 的修法）──────────────────────────
   *   ① 「已下结论」（是 / 确定不是）→ 不再探。这是"结论"；
   *   ② 「已有一条在途」→ 不并发重发。这是"在途"；
   *   ③ 「重试预算用完了」。
   *   旧实现只有 ① 一个字段，把"在途"与"结论"合在一起，于是**瞬时失败**也落进 ①
   *   → 这张卡再也没有第二次机会。
   *   ⚠️ 三条闸**不再写在这里**：它们连同"这次尝试记不记账"一起搬进了
   *   `core/motionProbeState.ts::beginMotionProbe`（有单测，能穷举上界 0/1/3 的边界）。
   *   本函数只做平台那一半：取宿主 Context → 发 IPC → 把结果交给纯模块结算。
   *
   * ── 触发点（四个，全部是"每卡已有的时刻"，没有新增计时器）───────────────────
   *   · `aboutToAppear`（进这张卡）与 `onItemChanged`（换到这张卡）—— 原有的两个；
   *   · `PanGesture.onActionStart` —— 用户又开始拖这张卡 = 一次明确交互；
   *   · `onMotionPress`（长按识别成功）—— **用户自己的重试入口**：角标没亮时长按本来是
   *     "什么都不发生"，现在它会补一次探测（本次长按来不及，修的是下一次）。
   *   四个触发点都自带上面三条闸，所以"高频交互"不会变成"高频 IPC"。
   */
  private ensureMotionForCurrent(): void {
    const id: string = this.item.photoId;
    // 三道闸 + 空 id。**被拒时也要接住 state**：纯函数的契约是"被拒则状态一字不动"，
    // 接住它让"闸门拒绝 ≠ 状态被改"这件事在代码上无需推理（赋值是幂等的）。
    const b: MotionProbeBegin = beginMotionProbe(this.motionState, id, MOTION_PROBE_MAX_ATTEMPTS);
    this.motionState = b.state;
    if (!b.allowed) { return; }
    // 本次尝试已经记账（**同步失败也算一次**，见 beginMotionProbe 的说明）：
    // `motionState.tries` 此刻就是这次的序号，下面两行日志直接读它。
    // Context 在**调用时**取，而不是构造时存一个字段：
    //   · `getContext(this)` 已 deprecated（本工程其它文件也带着这个告警），
    //     而 `this.getUIContext()` 是本工程已经在用的写法（见 SwipePage 的 toastReading）；
    //   · `getHostContext()` 的返回类型**本来就是** `Context | undefined`，
    //     于是"取不到宿主"成为一个显式分支（下面那行 warn），而不是靠 `as` 断言
    //     把一个 undefined 一路送进 SDK（那会变成一条语焉不详的失败）。
    // try/catch 的理由只有一个、但足够：这个函数会在 `aboutToAppear` 里被调用，
    // 而**任何异常都会打断卡片的构建**（表现为刷卡页白掉），代价远大于"这张没有角标"。
    // 平台若在某个时机不给 UI 上下文，这里退化成"探测不了"，绝不外溢。
    let host: common.Context | undefined = undefined;
    try {
      host = this.getUIContext().getHostContext();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '%{public}s', `取宿主 Context 抛异常，跳过动态照片探测: ${errText(e)}`);
      return;
    }
    if (host === undefined) {
      // 结构上不该发生（本组件必然挂在某个 UIAbility 的页面上）。留着它的意义是：
      // 真机上"全都没有角标"这件事会有一行明确的告警可查。
      // **不写结论** → 这是一次"没探到"，不是"确定不是动态照片"；
      // 下一次与这张卡的交互（拖动 / 长按）会再补一次（上限见 MOTION_PROBE_MAX_ATTEMPTS）。
      hilog.warn(DOMAIN, TAG, '%{public}s',
        `取不到宿主 Context，跳过动态照片探测（第 ${motionAttempts(this.motionState)}/${MOTION_PROBE_MAX_ATTEMPTS} 次，未定论）: ${id}`);
      return;
    }
    this.releaseMotion();
    this.motionSeq = this.motionSeq + 1;
    const seq: number = this.motionSeq;
    // 「这次探测真的发出去了」：置在途标记 + 拿到凭据。它**必须**晚于 releaseMotion()
    //（那一步刚把旧结论/旧在途清掉），也**必须**在取到 host 之后 —— 取不到 host 时置在途
    // 会让这张卡被"同卡不并发"那道闸永久挡住，而结论又没写，那是 D4 的另一种死法。
    const armed: MotionProbeArm = armMotionProbe(this.motionState, id, seq);
    this.motionState = armed.state;
    const ticket: MotionProbeTicket = armed.ticket;
    loadMotion(host, id)
      .then((r: MotionProbeResult): void => { this.onMotionLoaded(ticket, r); })
      .catch((): void => {
        // loadMotion 内部已吞掉全部异常（任何失败都返回一个 result）——
        // 这里只是不让一个意外的 rejection 变成未处理异常。
        // ⚠️ 真出到这一支也必须**解除在途标记**（且只解除自己那一条）：
        // 否则这张卡会被闸② 永久挡住，而闸① 又没写结论 —— 那就成了 D4 的另一种死法。
        // 它走的是**与"瞬时失败"同一条迁移**（`missed`：不写结论、只解在途），
        // 所以这两条路径不可能各写一遍、各漂一次。
        this.motionState = this.settleMotion(ticket, MISSED_VERDICT).state;
      });
  }

  /**
   * 取对象的异步结果回来。**第一件事是判定它还算不算数** —— 用户完全可能在这几百毫秒里
   * 已经翻走（这正是"不阻塞刷卡"的必然代价）。不算数的那一份必须**当场放手**。
   *
   * 判定与迁移全在纯模块里（`settleMotionProbe`，有单测）。它的三条过期判据
   * **一条都没删**（`motionSeq` 的作废机制原样保留），只是第三条读的字段从"已下结论"
   * 换成了"在途"：
   *   · `ticket.seq !== motionSeq` —— 期间又发起了一次探测 / 换过卡（releaseMotion 会 +1）；
   *   · `inFlightId !== id` —— 这条结果对应的那次探测已经不是"当前在途"的那次；
   *   · `item.photoId !== id` —— 这张卡已经被换走。
   * 三条都是"独立充分"的：任一条成立就丢弃并释放。
   * ⚠️ **第三条为什么必须是"在途"而不是"已下结论"**：本函数在"结果被接受"时会**先写结论**，
   *    若过期判据读的是结论字段，那么**一次成功的重试**会在写完结论之后被自己判成过期
   *    → 到手的句柄被当场释放、角标永远不亮。纯模块的注释里有同一条论证。
   */
  private onMotionLoaded(ticket: MotionProbeTicket, r: MotionProbeResult): void {
    const id: string = ticket.id;
    const st: MotionProbeSettle = this.settleMotion(ticket, {
      concluded: r.concluded,
      hasHandle: r.handle !== undefined
    });
    if (st.outcome === 'stale') {
      // 过期的那一份**必须当场放手**（这是 releaseMotion 之外的第三条释放出口）。
      const stale: MotionHandle | undefined = r.handle;
      if (stale !== undefined) {
        hilog.info(DOMAIN, TAG, '%{public}s',
          `动态照片结果已过期，直接放手: ${id}（本次真正放手=${stale.release()}）`);
      }
      return;
    }
    const h: MotionHandle | undefined = r.handle;
    if (h === undefined) {
      if (st.outcome === 'negative') {
        // ── **已下结论**：data 层确定这张不是动态照片（`confirmedNoMotion` 已写）。
        // 结论已经由纯模块写上 —— 此后这张卡不再探测（真正省下查库的那一支）。
        return;
      }
      // ── **没探到**（查库 0 条 / 请求超时 / 回传空 / IPC 抖动 —— 全是瞬时的）：
      // **不写结论**（纯模块的 `missed` 分支），于是下一次与这张卡的交互会再补一次探测。
      // `motionReady` 保持 false：角标不亮、长按无所作为 —— 与"不是动态照片"观感一致，
      // 区别是**它还会自己好起来**（旧实现不会，且没有任何恢复动作）。
      hilog.info(DOMAIN, TAG, '%{public}s',
        `动态照片未探到（第 ${motionAttempts(this.motionState)}/${MOTION_PROBE_MAX_ATTEMPTS} 次，**不是结论**）→ 不写结论，下次交互这张卡会重试: ${id}`);
      return;
    }
    // ── 正结论：句柄到手（结论已由纯模块写上）────────────────────────────────
    // 同一张卡理论上不会再有一个 owner（三道闸去重），但换卡路径可能留下旧的：
    // 释放掉再装，保证"最多只有一个 MotionHandle 活着"这条不变量。
    if (this.motionOwner !== undefined) {
      hilog.info(DOMAIN, TAG, '%{public}s',
        `替换旧的动态照片句柄（真正放手=${this.motionOwner.release()}）: ${id}`);
      this.motionOwner = undefined;
    }
    this.motionOwner = h;
    this.motionReady = true;
    // 真机核验"角标什么时候亮"的唯一直接证据：这行日志必须早于这张卡的第一次长按。
    hilog.info(DOMAIN, TAG, '%{public}s',
      `动态照片角标点亮: ${id}（第 ${motionAttempts(this.motionState)}/${MOTION_PROBE_MAX_ATTEMPTS} 次探测拿到）`);
  }

  /**
   * 把一条结果交给纯模块结算，并把新状态**接住**。
   *
   * 存在的理由有两个，都不是"少写一行"：
   *   · `.then` 与 `.catch` 两条路径**必须**走同一段迁移（否则 `.catch` 那一支很容易
   *     在某次修改里被漏掉，而它的漏法正是"这张卡被永久挡住"）；
   *   · `outcome === 'stale'` 时纯模块返回的状态与入参**逐字段相同**，赋值是幂等的 ——
   *     于是"过期结果不得影响新状态"这条契约在调用点上**不需要**再写一次 if。
   */
  private settleMotion(ticket: MotionProbeTicket, v: MotionProbeVerdict): MotionProbeSettle {
    const st: MotionProbeSettle = settleMotionProbe(
      this.motionState, ticket, this.item.photoId, this.motionSeq, v);
    this.motionState = st.state;
    return st;
  }

  /**
   * 放手当前动态照片句柄。**这是 `MotionHandle` 唯一的释放出口**，三个调用点穷举了所有
   * "这张卡不再需要它"的时刻：
   *   1) `onItemChanged`（换卡，经 resetMotion）；
   *   2) `aboutToDisappear`（页面卸载，经 resetMotion）；
   *   3) `onMotionLoaded` 的过期分支（结果回来时这张卡已经走了）。
   *
   * 与 `releaseAnim` 的差别只有一点、但必须记住：**`MovingPhoto` 没有 `release()` API**
   * （SDK 只给了 `requestContent` / `getUri`），所以这里的"放手"= **唯一的持有者丢掉引用**
   *（详见 data/movingPhotoSource.ets 的 MotionHandle）。正因如此"谁持有"必须唯一 ——
   * 这也是本文件刻意不把句柄经 `@Prop` 传给别的组件的理由（多一个持有者就毁掉这条路径）。
   */
  private releaseMotion(): void {
    // 先让在途的取对象结果作废（它回来时会自己放手自己那一份），再放手当前这份。
    this.motionSeq = this.motionSeq + 1;
    // 在途标记与"已下结论"**必须一起清**（D4：它们是两个字段，只清一个就会挡住下一次探测）：
    // 只清结论 → 闸②（"在途"永远为真）把下一次挡在门外；只清在途 → 闸① 说"这张探过了"。
    // 这一步**刻意不动重试预算**（`tries`），理由见下。
    this.motionState = releaseMotionProbe(this.motionState);
    if (this.motionOwner !== undefined) {
      const ok: boolean = this.motionOwner.release();
      this.motionOwner = undefined;
      // 真机核验"换卡有没有放手"的唯一直接证据（与"换卡释放动图帧"同一手法）：
      // 每换走一张**动态照片**就该看到一行，且真正放手=true。
      hilog.info(DOMAIN, TAG, '%{public}s', `换卡放手动态照片句柄: 真正放手=${ok}`);
    }
    this.motionReady = false;
    // ⚠️ 刻意**不**在这里重置重试预算：`ensureMotionForCurrent` 每次尝试都会先调本函数
    //    （那是"作废在途结果 + 放手旧句柄"），在这里重置等于每次尝试都把重试上界清零。
    //    纯模块的 `releaseMotionProbe` 把这条约定写进了函数契约（并有单测钉住）。
  }

  /**
   * 「这张卡到此为止」：**停播 + 放手**，两条必须成对。只停播不放手会漏一个句柄；
   * 只放手不停播会让一个已经没人持有的对象继续被组件渲染（那是最难查的一种状态）。
   * 换卡与页面卸载都只调它，不分别调两半 —— 这样"成对"是结构保证，不靠调用点自觉。
   *
   * 它同时是**一次「访问」的边界**（D4）：重试预算在这里重置。
   * 换走再滑回来是一次全新的环境（用户可见的动作），与"同一张卡上无限重试"不是一回事。
   * `newMotionProbeState()` 是**唯一**会把 `tries` 归零的地方（纯模块里有单测钉住这一点）。
   */
  private resetMotion(): void {
    this.stopMotionPlayback();
    this.releaseMotion();
    this.motionState = newMotionProbeState();
  }

  /**
   * 停止播放 = **卸载播放器组件**，回到静态图。**幂等**：松手、动效播完、换卡、卸载
   * 四条路径都会调它，重复调用必须无害（`motionOn` 已经是 false 就直接返回）。
   * 顺序：先让平台停（此刻节点还活着），再改 @State 触发卸载 —— 反过来就是
   * "节点已经销毁了再去指挥它的控制器"。
   */
  private stopMotionPlayback(): void {
    if (!this.motionOn) { return; }
    try {
      this.motionCtl.stopPlayback();
    } catch (e) {
      // 控制器还没挂上（组件刚挂载就被松手）等情况会抛。播放必须停，
      // 但**不能**因为停不下来就不卸载 —— 卸载才是"回到静态图"的唯一手段。
      hilog.warn(DOMAIN, TAG, '%{public}s', `stopPlayback 失败（仍然卸载播放器）: ${errText(e)}`);
    }
    this.motionOn = false;
    hilog.info(DOMAIN, TAG, '%{public}s', '动态照片：停止播放 → 回到静态图');
  }

  /**
   * 长按识别成功（按住 `MOTION_LONG_PRESS_MS`）→ 起播。
   *
   * 六个判据全在纯函数 `core/movingPhoto.ts::shouldStartMotionPlayback` 里（有单测），
   * 这里只负责把"当前状态"读成它的入参。这么拆的意义是：判据能被穷举，
   * 而它们的**取值来源**集中在这一处、一眼看得全（漏一个来源在真机上就是"长按没反应"）。
   */
  private onMotionPress(e: GestureEvent): void {
    // ── D4：长按一张**角标没亮**的卡 = "用户以为它是动态照片，但什么都没发生" ──────
    // 旧实现在这里什么都不做（"已下结论"那个字段早被写成这张 → 再也不探），用户没有任何恢复动作。
    // 现在补一次探测：本次长按**来不及**（探测是异步的，长按已经识别完了），
    // 修的是**下一次** —— 用户再按一次就好了。这是工单要的"用户自己的重试入口"。
    // 它自带三条闸（已下结论 / 已有在途 / 预算用尽），所以不会变成"每按一次发一次 IPC"；
    // 位置在闸门之前：`shouldStartMotionPlayback` 的各种拒绝理由都不影响"该补一次探测"这件事。
    if (!this.motionReady) {
      hilog.info(DOMAIN, TAG, '%{public}s',
        `长按但动态照片未就绪 → 补一次探测（本次长按来不及，再按一次即可）: ${this.item.photoId}`);
      this.ensureMotionForCurrent();
    }
    // 读不到 fingerList 时按 0（= 未知）传下去：闸门对"未知"是**放行**的 ——
    // "平台没报手指数"不该让整个功能失灵（见 core/movingPhoto.ts 的取舍说明）。
    let fingers: number = 0;
    if (e !== undefined && e.fingerList !== undefined) { fingers = e.fingerList.length; }
    const g: MotionStartGate = {
      movingPhotoReady: this.motionOwner !== undefined && !this.motionOwner.isReleased(),
      alreadyPlaying: this.motionOn,
      cardAnimating: this.animating,
      gestureVoided: this.isGestureVoided(),
      zoomInProgress: this.pinching || this.gestureIsZoom,
      fingers: fingers
    };
    if (!shouldStartMotionPlayback(g)) { return; }
    // 记下"本次手势期间起过播放"：settle() 据此**不记回弹**（按住看动态不是一次滑动尝试）。
    this.gestureHadMotion = true;
    // 每次都新建控制器：与探针一致（每个 trial 全新的组件实例 + 全新的控制器）。
    this.motionCtl = new MovingPhotoViewController();
    // 挂载播放器。`autoPlay(true)` 会在资源就绪后自己起播 —— 这就是"长按 → 播放动态"。
    this.motionOn = true;
    hilog.info(DOMAIN, TAG, '%{public}s',
      `动态照片：长按起播（fingers=${fingers} 缩放=${this.zoomScale}）: ${this.item.photoId}`);
  }

  /**
   * 松手 / 长按被取消 → 回到静态图。
   *
   * ⚠️ 它**刻意不清** `gestureHadMotion`，理由是一个在真机上无法保证的事实：
   * "手指抬起时 LongPress 的 onActionEnd 与 Pan 的 onActionEnd 谁先到"没有任何文档保证。
   * 若在这里清，先到的那个就会把标记清掉，于是 settle() 把一次"按住看动态"记成一次回弹
   *（回弹率被这类操作污染）。把清除权交给 Pan 自己（且都在 settle() **之后**），
   * 两种回调顺序就得到同一个结果 —— 这是"用一个可枚举的所有者换掉一个不确定的顺序"。
   */
  private onMotionRelease(): void {
    this.stopMotionPlayback();
  }

  /**
   * 一次动效**播完** → 主动回到静态图（不等松手）。
   *
   * 这是本批明确的产品裁决，两个候选都写在这里备查：
   *   (a) 播完停在末帧、等用户松手（`repeatPlay(false)` + 什么都不做）——
   *       用户按住 5s 而片子只有 2.4s 时，后 2.6s 是一张**冻住的画面**：
   *       那读起来像"卡住了"，而不像"播完了"；
   *   (b) 播完即回静态（**本实现**）—— "长按 = 播一次动态"变成一个**有终点**的动作，
   *       而且终点由平台的 `onFinish` 明确给出（不靠计时器猜时长）。
   *       想再看一次的人松手再按，代价是一次按压，收益是没有任何"冻住"的歧义。
   * 想改成 (a)：删掉本方法体里那一行 `stopMotionPlayback()` 即可（日志保留）。
   * ⚠️ 边界：`onFinish` 若在某些设备上不触发，就一直停在末帧 —— 那时用户松手照样回静态
   *（松手路径与它无关），所以这条边界不会造成"停在动态画面上下不来"。
   */
  private onMotionFinished(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', `动态照片：一次动效播完 → 回静态图: ${this.item.photoId}`);
    this.stopMotionPlayback();
  }

  /** 播放器回调的统一日志出口：真机排障靠的是"**哪一步没发生**"（onError 没有错误码可打）。 */
  private motionCb(name: string): void {
    hilog.info(DOMAIN, TAG, '%{public}s',
      `MovingPhotoView.${name}（按住中=${this.motionOn}）: ${this.item.photoId}`);
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
    // batch-44：把"这张照片实际画了多大"打一行 —— 它是待办①（三种比例照片尺寸逐位不变）
    // 在真机上的**正面证据**。**位置在 reclampPan 之后**：日志不得改变上面任何一步的行为
    // （它只读 drawnW/drawnH/boxW/boxH，一个都不写）。
    this.logPhotoDrawn();
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
      // ── 本批修的就是这一行：默认插值让照片比相册里**糊** ────────────────────────
      // `interpolation` 不设时的默认值是 `ImageInterpolation.Low`（SDK 原文见
      // `component/image.d.ts:1076-1077`：「Default value: **ImageInterpolation.Low**」
      // —— 注意后半句「set to **undefined** 当作 `None`（最近邻）」说的是传 undefined 的情形，
      // 而"不调用这个属性方法"用的是默认值 Low，两者不是一回事）。Low = **双线性**。
      //
      // 为什么双线性在这里肉眼可见地发软（算术）：
      //   相册原图约 4000 px 宽 → 卡片显示区约 433 pt → 手机 3× 屏约 1300 物理像素，
      //   缩放比 ≈ 0.325（缩到 1/3）。缩图时每个目标像素要代表约 9 个源像素，
      //   而双线性只读目标点周围 2×2 = 4 个源像素 —— 剩下 5 个像素的信息直接丢掉，
      //   高频细节（头发、树叶、织物纹理）因此糊成一片。相册 App 用的是高质量重采样，
      //   所以同一张照片在两边看起来清晰度不同 —— 这正是用户报的现象。
      //
      // 为什么是 `High` 而不是 SDK 在 `autoResize` 处推荐的 `Medium`（诚实记账）：
      //   · `autoResize` 文档（同文件 989-994 行）按缩放方向给了**两条不同**的建议：
      //       「When the image is scaled down: .autoResize(false) + .interpolation(.Medium)」
      //       「When the image is scaled up:   .interpolation(.High)」
      //     （`autoResize` 默认已是 false，所以前半条里的解码那半我们本来就满足。）
      //   · 默认 1× 看全图时我们落在"缩图"那一档 —— 按 SDK 建议本该是 `Medium`；
      //     但双指放大到 4× 看细节时同一个节点落在"放大"那一档，SDK 建议 `High`。
      //     `interpolation` 是**组件属性**，在**构建期**生效、不是逐帧采样决策
      //     （纹理一旦按属性定下采样方式，`.scale()` 只是把这个结果放大），
      //     所以同一个节点只能有一个档位，"按 zoomScale 动态换档"不是一条可走的路 ——
      //     那需要重建子树（`if` 分支或 key 变化），换来闪烁与一次重解码，代价高于收益。
      //   · 两档取一，本批取 `High`：它的语义是 SDK 明说的
      //     「produces scaled images of the **highest possible quality**」（同文件 High 的注释），
      //     **两个方向都不比现状差**；而选 `Medium` 会在放大那一档低于 `High`，
      //     偏偏"能放大看细节"正是这个页面的能力。真机若实测"1× 下 Medium 更锐"，
      //     改回 `Medium` 是**一行**的事（见本批报告 §4 的对比方法）。
      //   · 代价（不藏）：三次插值单位像素算力高于双线性。这张照片是**静态的**
      //     —— 解码/缩放一次后由 GPU 合成，不在任何每帧重绘的热路径上
      //     （唯一例外是手势拖动时的重合成，那里改的是 `.offset()`/`.scale()`，不是重新采样源图）。
      //
      // ⚠️ 这条属性对**动图**不生效，且这不是本批引入的问题：
      //   `imgSource()` 在解出多帧时返回 `AnimatedDrawableDescriptor`，SDK 明说
      //   「This attribute does not take effect when the parameter type of the component is
      //   AnimatedDrawableDescriptor」（`image.d.ts:1073-1074`）。所以 GIF 那条路的清晰度
      //   不受本行影响 —— 它播的是按像素预算解出的原始分辨率帧，**不经过图片缩放重采样**，
      //   本来就没有这条缺陷。
      .interpolation(ImageInterpolation.High)
      .scale({ x: this.zoomScale, y: this.zoomScale })
      .offset({ x: this.panX, y: this.panY })
      // 本批新增：把"长按被平台拖拽抢走"这条风险显式关掉。
      // 两个 SDK 说法在这里是**冲突**的，所以不赌任何一边：
      //   · `gesture.d.ts:1403-1411` 把 Image 列进"默认支持拖拽"的组件，并规定
      //     长按 ≥500ms 时"拖拽优先于长按"（我们的 duration 正是 500，正好落在边界上）；
      //   · `common.d.ts:20759` 的 `draggable` 却说"By default, the component is not draggable"。
      // 写死 false 的代价是一次属性调用，收益是这条冲突从"要赌"变成"不可能发生"。
      .draggable(false)
      // 静态图加载完成 → 拿到固有尺寸与实际绘制尺寸（动图**不走**这里，SDK 明说不触发）。
      // 只读四个数，不写任何与手势/决策有关的状态，所以不会与手势回调争状态。
      .onComplete((event) => {
        if (event === undefined) { return; }
        this.onPhotoDrawn(event.width, event.height, event.contentWidth, event.contentHeight);
      })
  }

  /**
   * 动态照片的**播放器节点**（只在长按按住期间存在 —— 这就是"默认不自动播"的落点）。
   *
   * 三样东西必须与 `photoNode()` **逐字相同**：盒子尺寸（100%×100%）、`objectFit`、
   * 以及那个几何变换（`.scale()` + `.offset()`）。任何一条不同，长按的那一瞬间就会
   * 看到"照片跳一下"：前两条决定"照片画在框里的哪儿"，第三条决定"框被搬到哪儿、放大几倍"。
   *
   * ⚠️ 这三行是同一个事实的**两处表达**（`Image` 与 `MovingPhotoView` 是两个节点，
   * 没法共用一个 @Builder），所以它们最容易漂移 —— 改动其中一处必须同时改另一处。
   * 想消掉这份重复只有一条路：把变换提到公共父节点（卡片 Stack）上。
   * 本批**不做**：上一批刚在真机上验过那套管线（offset 属布局、scale 属渲染、
   * 父节点还有 `clip(true)` 与 `translate`），把变换搬上去等于重新洗一遍顺序假设，
   * 而收益只是省三行注释。
   *
   * `objectFit(ImageFit.Contain)`：与静态图一致。上一批的 `Cover→Contain` 是产品决策
   *（"看到的就是全图"），播放器必须跟着它 —— 否则"长按看动态"看到的会是**被裁掉**的画面，
   * 那比不播更让人困惑。
   *
   * ── 本批新增的结论：**这条路的画质我们调不了，由系统决定** ──────────────────
   * 上一段刚说"除源以外每个属性都必须一致"，那么静态图新加的 `.interpolation(High)`
   * 是不是也该在这里补一行？**补不了 —— 这条属性在这个组件上不存在。**
   * `@ohos.multimedia.movingphotoview.d.ts` 里 `MovingPhotoViewAttribute` 的**全部**方法只有
   * 13 个：`muted`(113) / `objectFit`(124) / 七个回调(135-201) /
   * `autoPlayPeriod`(214) / `autoPlay`(226) / `repeatPlay`(238) / `enableAnalyzer`(250)。
   * **没有 `interpolation`，也没有 `sourceSize` / `renderMode` / `dynamicRangeMode`** ——
   * 连 `Image` 那套 `autoResize` 都没有（`objectFit` 是唯一沾边的旋钮，
   * 而它管的是"怎么摆"，不是"怎么采样"）。
   * 所以动态照片播放时画面怎么缩放、用什么插值，**由系统播放器自己决定**，
   * 我们这边**没有任何开关**，本批也**不假装**能改（不去瞎调一个不存在的"画质"参数）。
   * 能做的只有"取景范围与静态图逐字一致"——`objectFit(Contain)` 已经做到，
   * 于是长按前后**至少取景不会跳**；至于锐度，若真机上动态照片明显比静态图糊，
   * 那是系统侧的行为，只能作为一条**平台限制**记录（见本批报告 §5），
   * 而不是我们在这个仓库里能修的缺陷。
   */
  @Builder
  motionNode() {
    // 非空判据必须写在**这里**：@Builder 是独立的函数体，调用点那个 `if (this.motionOn)`
    // 的判据不会流进来（`this.motionOwner` 的静态类型仍是 `MotionHandle | undefined`）。
    // 用一个 if 包住而不是靠断言（`as`）：断言在"句柄已被换卡释放"那条路径上会静默渲染
    // 一个已放弃的对象，而 if 只会什么都不画（退化成静态图，正是我们要的退路）。
    if (this.motionOwner !== undefined) {
      MovingPhotoView({ movingPhoto: this.motionOwner.movingPhoto, controller: this.motionCtl })
        // 有声音：动效的一半意义在声音（用户要的是"拍摄的动态图"）。
        // 已知未验：系统静音开关打开时是否仍出声由平台决定（见报告 §8）。
        .muted(false)
        // autoPlay(true)：**"长按即播"的唯一驱动**。它之所以不违反"默认不自动播"，
        // 是因为这个节点只在按住期间存在 —— "自动播放"的作用域被限制在"用户正按着"的
        // 那一段时间里，默认状态下根本没有这个节点（也没有解码）。
        // 不用 `controller.startPlayback()` 手动起播：那要额外依赖一个"就绪"回调，
        // 多一条"回调没来就永远不播"的失败路径，而 autoPlay 是探针实测过的形态之一。
        .autoPlay(true)
        // repeatPlay(false)：见 onMotionFinished 的产品裁决（播完即回静态，不留冻帧）。
        .repeatPlay(false)
        .objectFit(ImageFit.Contain)
        .width('100%').height('100%')
        .scale({ x: this.zoomScale, y: this.zoomScale })
        .offset({ x: this.panX, y: this.panY })
        // 与 photoNode 同款：把"长按被平台拖拽抢走"这条风险显式关掉（理由见那里）。
        .draggable(false)
        // 七个回调全部只做两件事：打一行日志、必要时回静态。
        // ⚠️ `onError` 的签名是 `() => void`（**拿不到错误码**，SDK 限制，见
        // `@ohos.multimedia.movingphotoview.d.ts:92/190`），所以真机排障唯一的线索是
        // "**哪一步没有发生**"（onPrepared 没来？onStart 没来？）—— 这正是七个都打日志的原因。
        .onComplete(() => { this.motionCb('onComplete'); })
        .onPrepared(() => { this.motionCb('onPrepared'); })
        .onStart(() => { this.motionCb('onStart'); })
        .onPause(() => { this.motionCb('onPause'); })
        .onStop(() => { this.motionCb('onStop'); })
        .onFinish(() => { this.motionCb('onFinish'); this.onMotionFinished(); })
        .onError(() => { this.motionCb('onError'); })
    }
  }

  /**
   * 「动态」角标：**默认状态下唯一能说明"这张可以长按"的东西**。
   *
   * 位置 = 卡片右上角（卡片 Stack 的 `alignContent(TopEnd)` + 自身 margin）。
   * 两个状态共用**同一个节点**（只改文案与底色），所以"按住 → 播放中"的变化是原地发生的，
   * 不会因为状态切换而抖动位置。
   * 「播放中」那一版就是本批的按压反馈：它在**按下当帧**就出现，而画面真正动起来还要等
   * 组件准备（几百毫秒）—— 反馈与真实播放解耦，用户不会以为"按了没反应"。
   * 尺寸：字号 11 + 上下 padding 3 ≈ 20vp 高，占卡片高度的 5% 左右 —— 小而清楚。
   */
  @Builder
  motionBadge() {
    Text(this.motionOn ? '● 播放中' : '▶ 动态')
      .fontSize(F_CAPTION)
      .fontColor(C_ON_PHOTO)
      .padding({ left: S2, right: S2, top: S1, bottom: S1 })
      // 两个状态共用同一个节点（只改文案与底色）—— 见本 @Builder 的说明：
      // 「播放中」用**主强调面**（`C_ACCENT` + 白字 4.94:1），待播态用**暖黑遮罩**
      // （`C_SCRIM`：压在**最亮**的照片上、白字仍有 5.72:1，见 designTokens 的推导）。
      // 旧值 `rgba(0,0,0,0.55)` 本身是达标的（4.74:1），改它是为了**余量与同源**
      // —— 纯黑遮罩压在暖纸上会发青；这一条在令牌表里写了完整账，不在这里重复。
      .backgroundColor(this.motionOn ? C_ACCENT : C_SCRIM)
      .borderRadius(R_MD)
      .margin({ top: S2, right: S2 })
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
      // ── 卡片本体（batch-42 重排为**外层容器**）：**填满**「顶部行之下、按钮行之上」─────
      // 用户的原话是「我画出的红色区域 用来养鱼吗？」，红圈画在两条**页面底色**带上
      //（控制器把圈①标为"顶部行到卡片上沿"、圈②标为"按钮行以下"，这个标注与代码吻合）：
      //   圈① = 顶部行下沿(71) → 卡片上沿(187.2)  = 116.2pt
      //   圈② = 按钮行下沿(692.9) → 屏底(809.14)  = 116.2pt（圈的上沿 694 压在按钮行下沿上，差 1.1pt）
      // 两条带**严格相等**：都是 `(可用区高 − 卡高 − 按钮行高)/2`，因为改动前这一列把
      // 「卡片 + 按钮行」**整体居中**，前置空隙与后置空隙是同一个数。这条恒等式是本批修法的
      // 全部依据，也顺带证明它与绝对 y 无关：内缩取 19 还是别的值、页面是否全屏，
      // 那两条带都相等、都由这个式子给出。
      //
      // ── 旧结论（batch-41 写进 `SwipePage.ets` 顶部的那条）以及它被什么推翻 ──────────
      // 旧结论：「照片上沿 = 顶行下沿 + (可用高 − 按钮行 − 照片高)/2，与 `CARD_HEIGHT_RATIO`
      //   **完全无关**；改这个数只能移动卡片的上下边与两个被它读走的量 —— 验算
      //   0.50/0.62/0.78 三档，照片上沿恒为 293.3pt」，所以**不许**动比例、空白也动不了。
      // 本批核实：**算式对、算术也对**（293.3 / 187.2 / 644.9 / 692.9 逐位复现，见报告 §1.2），
      // 但结论带着一个没写出来的条件 ——「照片高与卡高无关」只在**宽受限**时成立，
      // 即照片比例 ≥ 卡宽/卡高 = 353.44/457.65 = 0.772。一张 3:4 竖幅照片是**高受限**
      //（照片高 = 卡高），三档下照片上沿是 231.5 / 187.2 / 180.4 —— **会动**（报告 §2.1）。
      // 而被推翻的是这句的后半截："改比例只能移动卡片上下边"恰恰说明**真正的旋钮不是比例，
      // 而是"那段空白归谁"**：卡片上下边一挪，卡外带与卡内衬纸此消彼长、总空白守恒
      //（batch-41 §6.3 自己也算到了这条守恒）。用户圈的两条带**在卡片之外**，
      // 所以修法不是动比例（那会把位移阈值与翻出距离一起带走），而是让**卡片真的长到**
      // 那两条带的边界上。
      //
      // ── 结构：外层填满，内层"照片盒"逐像素不变 ───────────────────────────────────
      //   · 外层（本节点）：`layoutWeight(1)` = 可用区高 − 按钮行高（738.14 − 48 = **690.14**），
      //     于是它从 71 一直铺到 761.14 —— 死区① 与 死区② **同时归零**（按钮行紧接着贴到屏底）。
      //     衬纸 `C_PHOTO_MAT`、圆角、描边、`.translate`（翻出位移）、四个手势都住在这里：
      //     它现在就是"卡片"这个可见物，也是用户手指拖动的那个东西 —— 所以拖在衬纸上同样有效
      //     （改动前衬纸只存在于卡片盒内，命中的是同一个节点，观感一致）。
      //   · 内层（下面那个 Stack，= **改动前的整个卡片节点**）：高度 = `cardHeight`（= 0.62H，
      //     与改动前 `.height('62%')` 是**同一个数**），在外层里居中 → 它的矩形与改动前的
      //     卡片盒**逐像素相同**（187.245 … 644.895）。照片、动图、动态照片、角标因此一个像素
      //     都不动，`boxW/boxH`（缩放与平移边界的两个输入）也一个都不动。
      // 为什么必须把框钉死：照片盒一旦变高，`Contain` 就会**放大**高受限的照片
      //（3:4 竖幅会从 343.2×457.6 变成 353.4×471.3），那正是任务明令禁止的"放大照片"。
      // 框钉死之后，"照片尺寸不变"成了一条可以逐位证明的不变量（报告 §6）。
      // 按钮**仍然不在**卡片里（它是本 Column 的第二个子节点，与卡片是兄弟，无 margin）：
      // 「手势命中区与按钮命中区互不重叠」这条改动前的结论本批**一条都没推翻**。
      Stack({ alignContent: Alignment.Center }) {
        // 照片盒 = 改动前的卡片盒（Contain 的框）。盒内仍是 TopEnd：角标在右上角，
        // 位置与改动前逐像素相同 —— 它住在**盒**里，而不是住在外层容器里。
        Stack({ alignContent: Alignment.TopEnd }) {
          // 照片本体抽成 @Builder：它有**两个源**（静态 URI / 动图 descriptor），
          // 但除源以外的每一个属性都必须完全一致 —— 分两份写迟早漂移，
          // 而漂移不会报错，只会让动图和静态图的观感不同（例如一个有缩放一个没有）。
          this.photoNode()
          // ── 动态照片的播放器（task-21 新增）──────────────────────────────────
          // **只在长按按住期间挂载**，这就是"刷卡时动态照片默认不自动播"的全部实现：
          // 默认状态下这个节点不存在 —— 不解码、不占内存、不会有任何一帧视频被读出来。
          // 代价（写进报告，不藏）：**首次播放有准备延迟**（组件创建 + 资源就绪），
          // 因为预热过的只有数据（`MotionHandle`，后台已取好），不是播放器。
          // 三个候选的取舍：
          //   (a) 常驻播放器 + `autoPlay(false)`：零延迟，但每张动态照片都要长期占着
          //       解码器/视频轨，几十张就是几十份 —— 任务明确要求"不要常驻"；
          //   (b) 提前一张预挂载（下一张就建好节点）：延迟最低，但"下一张是不是动态照片"
          //       要先探到（异步）、且要在换卡时序里插一脚 —— 收益是几百毫秒，
          //       代价是一条新的换卡竞态路径，本批不引入；
          //   (c) **长按才挂载、松手就卸载（本实现）** —— 延迟由"按住"这个动作自然吸收
          //       （用户本来就要按住 500ms），配合"按下当帧角标就变「播放中」"的即时反馈，
          //       观感上不会像失灵。真机若发现延迟明显，再走 (b)。
          // 它在 `photoNode()` **之后**：同尺寸同变换地盖在静态图上，
          // 于是"静态 → 动态"的切换不会有任何位移或闪烁（底下的静态图始终在）。
          // 条件只看 `motionOn`：句柄是否为空由 motionNode() 自己守（@Builder 是独立函数体，
          // 调用点的非空判据**不会**流进去 —— 那里再写一次 `motionOwner !== undefined`）。
          if (this.motionOn) {
            this.motionNode()
          }
          // 角标必须是**最后一个**子节点（在播放器之上），否则播放器会盖住它。
          if (this.motionReady || this.motionOn) {
            this.motionBadge()
          }
        }
        // 照片盒的高度 = `cardHeight`（父组件量到的可用区高 × `CARD_HEIGHT_RATIO`）。
        // ⚠️ batch-42 起它**不再**是"卡片的可见高度"，而是"照片做 Contain 的那个框"：
        //   · 它与改动前逐像素相同 —— 改动前这一行是 `.height('62%')`（由框架按百分比算），
        //     而百分比基准是整条可用区，数值恒等于 `SwipePage.ets` 里那个
        //     `可用区高 × CARD_HEIGHT_RATIO`，也就是本 @Prop 的值：**同一个事实的两处表达**，
        //     batch-42 把它收敛成**一处**（`.height('62%')` 这个孪生写法已删除）；
        //   · 为什么不继续用百分比：外层容器现在的高是「可用区 − 按钮行」，百分比基准变了，
        //     写 `'62%'` 会得到 0.62 × 690.14 = 427.9（照片会整体缩 6.6%，且竖幅照片被缩小）；
        //   · `@Prop cardHeight` 是**唯一**与父组件同源的数，也是下面 `settle()` / `navOut()`
        //     读的同一个数 —— 于是"照片盒高 == 阈值基准高"这件事仍然只有一处定义。
        //
        // ── batch-44 复核：batch-43 加的 32vp 净空**有没有动到照片**（逐位对照 `d5cdf2c`）──
        // 结论：**没有**。这一行的 `.height(this.cardHeight)` 是"照片盒的基准与卡片可见高度
        // 解耦"这条要求的**落点**，而它上面那一行（可见卡片）= `layoutWeight(1)`
        // = 「可用区 − 按钮行 48 − `BOTTOM_SAFE_INSET` 32」——两者**不同源**：
        //   照片盒高 = `cardHeight` = `0.62 × 可用区H`（一个**乘出来的数**，与卡片高无关）
        //   可见卡片高 = 可用区H − 80（由**布局**定）
        // 本机可用区高（`H = 738.14`，见 SwipePage 的 `[标尺]` 日志）下：**457.65 vs 658.14**，
        // 相差 **200.5vp**；而且"盒 < 卡"对任意 `H > 210.5` 都成立（`0.62H < H − 80`）——
        // 所以控制器担心的那个前提（"卡片容器高与照片盒高同源或相差不多"）**不成立**，
        // 高受限的竖幅照片**不会**被 32vp 挤到（它需要 457.65，卡里有 658.14）。
        // 三种比例的照片显示尺寸（`Contain`，盒 = 353.44 × 457.65，与 `d5cdf2c` **同一个矩形**）：
        //   横幅 1.4396 → 353.44×245.51（宽受限）｜方形 1.0 → 353.44×353.44（宽受限）
        //   **3:4 竖幅 → 343.24×457.65（高受限，唯一真正敏感的一档）**
        // 逐位对照表与证明脚本：`fix-batch-44-layout.mjs`（从两个 revision 的源码各读一次常量，
        // 对每种比例断言"两版照片矩形逐位相同"）。
        // ⚠️ 一处**旧读数的更正**（batch-43 报告 §5.2 的竖幅那一行）：它写的是
        //   "0.62H **见方** ≈ 392~428" —— 方的是**盒**（353.44 × 457.65），不是照片；
        //   3:4 照片是 `0.75×盒高 × 盒高` = **343.24 × 457.65**（高受限时照片高 = 盒高）。
        //   "与改前逐位相同"这条结论**没被推翻**（两个版本的照片盒是同一个矩形），
        //   作废的只是那一行让人误以为"照片也是个方块"的措辞与缺掉的宽度。
        // ⚠️ 另一条边界（只登记、不改动）：这里的"盒 < 卡"是**本机可用区高**下的事实；
        //   首帧尚未量到高度时 `cardHeight` 取兜底 600（见 @Prop 的说明），
        //   而 batch-43 把可用卡片压矮 32vp 之后，`600 < 可用区H − 80` 的成立门槛
        //   从 `H > 648` 抬到 `H > 680`（本机 738.14 仍有余量）。真机上由
        //   `[卡片几何]` 那行的 `照片盒放得下` 直接看着 —— 那正是加这行日志的理由。
        .width('100%').height(this.cardHeight)
        // 放大/平移后必须裁掉溢出（与改动前同一节点、同一语义）：`Contain` + 4× 的照片会
        // 画到照片盒之外。裁在**照片盒**上而不是外层容器上，是为了让"4× 时看得到多少"
        // 与改动前逐像素一致（照片盒 = 改动前的卡片盒）。
        .clip(true)
        // 照片盒尺寸 = 照片做 Contain 的那个"框"，也是平移边界的两个输入之一。
        // 它必须量**照片盒**：量外层容器会拿到 690.14 那个高，`resolveContentSize` 的
        // Contain 换算就会对高受限的照片算出偏大的内容尺寸 → 平移边界错（照片被推出盒外
        // 露底色，或该拖的地方拖不动）—— 这类"数值合法、结果错误"的偏差正是 boxW/boxH
        // 当初被放在卡片节点上量的原因，本批只是把"卡片节点"改名成"照片盒"。
        .onAreaChange((oldVal: Area, newVal: Area) => {
          const w: number = Number(newVal.width);
          const h: number = Number(newVal.height);
          if (w > 0 && h > 0) {
            this.boxW = w;
            this.boxH = h;
            this.reclampPan();
          }
          // batch-44：两个量都到齐时打一行"卡片/照片盒几何"（见 logCardGeometry）。
          // **放在最后**：上面那三行是既有行为（`boxW/boxH` 是平移边界的输入），一个字未动。
          this.logCardGeometry();
        })
      }
      // 外层容器 = 可见的卡片：`layoutWeight(1)` 让它吃满「顶部行之下、按钮行之上」。
      // ⚠️ 这里**不写** `'62%'`：卡片的可见高度与照片盒的高度自 batch-42 起是**两件事**
      //（照片盒 = 0.62H，卡片 = H − 48），把它们写成同一个数正是上一批那条错误结论的源头。
      .width('100%').layoutWeight(1)
      // 卡片底 = **照片衬纸**（`C_PHOTO_MAT`）。旧值是 `#EEE` —— 一块中性冷灰：
      // 在暖纸上它是一块"发灰的斑"，而不是"相纸"。
      // ⚠️ 上一批**刻意不加阴影、不加描边**（虽然任务把"阴影/描边"列为卡片要看的项），
      //    两条理由都是真机上才成立的、不值得赌的东西（**本批仍然有效，一条都没推翻**）：
      //      · 阴影：本节点挂着 `.clip(true)`（放大溢出必须裁掉，见下面的说明）。
      //        "阴影与裁剪谁先谁后"是平台行为 —— 赌错的形态是**裁剪把阴影切成一条黑边**，
      //        那比没有阴影难看。收益（一点深度感）远小于代价。
      //      · 描边：本节点的 borderWidth 已经有一个**语义**（长按播放时的按压反馈，
      //        默认态是 0，注释里写着"与改动前逐像素一致"）。把默认态从 0 改成 1
      //        会改掉那条已验证的事实；更要紧的是 border 会不会**内缩**照片的绘制框
      //        （`Contain` 的换算与平移边界都读 `boxW/boxH`）在文档里没有明确保证 ——
      //        而那是上一批刚在真机上验过的一整套管线。
      //        batch-42 补记（**不推翻、只缩小适用范围**）：`boxW/boxH` 的测量点已挪到
      //        **照片盒**（本容器的子节点），而 `borderWidth` 挂在本容器上 —— 所以
      //        "border 会不会内缩绘制框"这条顾虑对本节点**不再成立**。本批仍然不改它：
      //        默认态逐像素一致这件事不值得为了一个没人要的描边去推翻，且它与本批目标无关。
      //    深度感改由**三档明度**承担：纸 `C_BG` → 衬纸 `C_PHOTO_MAT` → 相纸 `C_SURFACE`。
      //
      // ── 本批（batch-41）的更正：三档明度"都在"，但两两之间**都看不出边界** ──────────
      //    上一批把"可见"这件事整个交给了明度差，却没有核过那三个差值的**量级**：
      //    纸→衬纸 **1.055:1**（通道差和 19）、纸→相纸 **1.099:1**（34）—— 两档都落在
      //    "大面积平色上分不出"的区间里（真机采样：卡内与卡外**差值和 = 0**）。
      //    用户的原始反馈就是「留那么多空白干什么？」：卡片看不见，于是"卡内的留白"
      //    与"卡外的留白"连成一整片，屏幕上只剩"一大块灰底 + 中间一张照片"。
      //    **修法：让边界由"填充"承担，而不是由阴影/描边承担** ——
      //      · `C_PHOTO_MAT` 从 `#EFEAE0` 加深到 `#E5DCC9`（1.055:1 → **1.20:1**，
      //        通道差和 19 → 66）。这是**属性值**改动：不新增节点、不新增手势、
      //        不碰渲染变换，也不进布局 —— `.backgroundColor()` 改的是画什么，
      //        不是画在哪（`boxW/boxH`、Contain 换算、平移边界一个都不动）；
      //      · 阴影仍然**不做**（理由同上：`clip(true)` 与阴影的先后是平台行为）；
      //      · `borderWidth` 仍然**不动**（它被长按反馈占着，且会进盒模型）；
      //      · `.outline()` 一度是候选（SDK 确实有：`common.d.ts:18315` 的
      //        `outline(value: OutlineOptions)`，选项在 `units.d.ts:3014`，
      //        `width/color/radius/style` 四个字段齐全，可传令牌），**但本批不用**：
      //        它相对**子节点**的绘制顺序在本地 SDK 声明里没有写（我们只查到"设置外描边"
      //        这一句），而本卡片的左右两条边**正好压在照片自己的边上** ——
      //        若描边画在子节点之上，照片左右两侧会多出一条 1vp 的 `C_LINE` 细线，
      //        那是"画在照片上的瑕疵"，不是我们要的卡片边界。收益（更硬的一条边）
      //        远小于这条不确定性，而**填充**那条路已经把可测性拿到了
      //        （卡内 `#E5DCC9` vs 卡外 `#F4F0E8`：差值和 66）。
      .backgroundColor(C_PHOTO_MAT)
      .borderRadius(R_LG)
      // 本批新增的按压反馈（另一半是角标变「播放中」）：长按起播期间给卡片一圈细描边。
      // 为什么是描边而不是"卡片轻微缩放"（任务里给的另一个例子）：
      // 描边是**布局内**的属性，不引入任何新的渲染变换；而卡片上已经有照片自身的
      // `.scale()`/`.offset()`（上一批验过的管线），再叠一个"卡片的 scale"会让
      // 两个变换的相对顺序变成需要读文档才能确定的东西 —— 那是本批最不值得冒的风险。
      // 宽度为 0 时描边不画（默认态与改动前逐像素一致 —— 见上面"刻意不加描边"那条）。
      .borderWidth(this.motionOn ? MOTION_PRESS_BORDER : 0)
      .borderColor(C_ACCENT)
      // **放大/平移后必须裁掉溢出**：Contain + 4× 的照片会画到卡片之外，
      // 不裁的话照片会盖住卡片下方的按钮行（那是"看不见的按钮还能点"的形态）。
      // 圆角是否被一并裁掉由平台决定（真机需看一眼），所以照片自身**不再**设 borderRadius：
      // 那会让 4× 时的圆角被一起放大成一个大圆角，比直角更难看。
      // batch-42：真正的裁剪点仍然是**照片盒**（见上面照片盒上那一行 `.clip(true)`），
      // 它保证"4× 时看得到多少"与改动前逐像素一致；外层这一道是**第二重保险**，
      // 挡的是"照片盒比容器还高"的唯一情形 —— 首帧尚未量到高度时 `cardHeight` 取兜底 600
      // （既有行为，见 @Prop 的说明），在比 600 矮的屏幕上照片盒会伸出容器，
      // 那时它绝不允许盖住顶部行或按钮行。
      .clip(true)
      .translate({ x: this.dx, y: this.dy })
      // ── batch-44 新增：**可见卡片**的量测（只读）──────────────────────────────────
      // 这里是"照片盒会不会被卡片挤到"这个问题的另一半输入：照片盒的高由 `@Prop cardHeight`
      // 定（已在上面量到），可见卡片的高由 `layoutWeight(1)` 定 —— 两者**不同源**，
      // 所以需要各自量一次才能在设备上核"它们相不相同"（见 logCardGeometry 的说明）。
      // ⚠️ 只读：不写任何 @State、不改布局、不加节点；`translate` 只改绘制位置、不改
      //    布局区域，而本回调的键只取 w×h —— 拖动卡片不会因此刷日志。
      .onAreaChange((_oldArea: Area, newArea: Area) => {
        const w: number = Number(newArea.width);
        const h: number = Number(newArea.height);
        if (w > 0 && h > 0) {
          this.cardVisW = w;
          this.cardVisH = h;
        }
        this.logCardGeometry();
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
      // ⚠️ batch-42：手势挂在**外层容器**（可见卡片）上，而不再是照片盒上 —— 命中区因此从
      //     457.6 高变成 690.1 高。这是"卡片填满"的配套：衬纸那两条带现在也属于卡片，
      //     拖在衬纸上却不跟手会像"卡片失灵"。**阈值一个都没动**（仍是 cardHeight × 比例，
      //     见 settle/navOut），动的只是"从哪儿开始拖算数"。按钮仍在卡片之外，命中区不重叠。
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
              // 本批新增：新手势开始 = 上一次"长按播放"的定性到此为止。
              // 与 gestureIsZoom 同一位置、同一理由（它们都是"本次 Pan 手势的性质"），
              // 但清除时机**晚一步**：长按播放的那个标记要活到本项目手势的**结束**
              //（settle() 在结束时读它），所以它的清除在 onActionEnd/onActionCancel 里。
              // 这里清的是"上上次手势残留下来的"那一份 —— 没有它，一次"按住看完就松手"
              //（Pan 从未识别）会把标记留到下一张卡上，吞掉下一张的一次真实回弹上报。
              this.gestureHadMotion = false;
              // ── D4：新手势开始 = 用户又明确地碰了这张卡一次 ──────────────────
              // 这是"每卡已有的时刻"里补触发动态照片探测的地方（另一处是长按）。
              // 为什么放在**这些赋值之后**：它只读写 motion* 那三个字段，与上面那些手势基线
              // 互不影响；放最后让"基线必须先刷新"这条既有约束一眼可见 —— 那条约束说的是
              // **本回调内**的顺序，在末尾加一行不会动摇它（加在首行才会）。
              // 它自带三条闸（已下结论 / 已有在途 / 预算用尽），所以连续拖动不会变成连续 IPC。
              this.ensureMotionForCurrent();
            })
            .onActionUpdate((e: GestureEvent) => {
              if (this.animating) { return; }
              // 本批新增（**只置标记、不挡任何东西**）：长按播放正在进行时，本次手势里
              // 已经混进了一次"按住看动态"。用户在长按期间的手指抖动（>5vp 就会让 Pan
              // 识别成功）与"想滑动"在数据上完全一样，所以这一次抬手**不上报回弹**
              //（回弹率自 batch-39（58ff624）起的单位是「一张照片的一次出现」= 尝试组，
              //  它记的是"这一次出现里有没有过手滑"；旧措辞写的是"一次滑动尝试没能产生结果"
              //  —— 单位换了，但这条判据一字未变：按住看动态不是一次尝试，不该给这次出现记一笔
              //  手滑。口径见 core/metrics.ts 的 rollbackRate：它的分母**含「上墙」**，
              //  只有中位数仍排除「上墙」；
              //  与「队首下滑不上报」「缩放不上报」同一口径）。
              // 刻意**不**在这里 return：卡片照常跟手 —— 用户真拖到位就该翻页（那是他的意图），
              // 而且"按住时卡片不动"会让一次误触长按变成"卡片失灵几百毫秒"的观感故障。
              // 放在最前面（animating 之后）：多指/缩放/作废那几条早退路径也照样置标记。
              if (this.motionOn) { this.gestureHadMotion = true; }
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
              // 本批新增：长按播放的定性同理，**且必须在 settle() 之后清** ——
              // settle() 在"没过阈值"那一支要读它来决定"这次算不算一次滑动尝试"。
              // 清除权只在这里（和 onActionCancel）与下一手势的 onActionStart：
              // 长按自己的 onActionEnd 刻意不清（两个回调谁先到没有文档保证，见 onMotionRelease）。
              this.gestureHadMotion = false;
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
              // 本批新增：与 onActionEnd 同一处置（取消同样要清，否则标记会留到下一张卡上）。
              this.gestureHadMotion = false;
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
            .onAction((e: GestureEvent) => { this.onDoubleTap(); }),

          // ── 长按播放动态照片（本批新增，第四个手势）──────────────────────────
          // 用户原话：「刷卡时动态照片默认不自动播，长按默认播放动态」。
          //
          // ⚠️ 四个手势共存（Pan / Pinch / 双击 Tap / 长按）的仲裁是本批最大风险，逐条说明：
          //
          // ① 为什么仍然用 **GestureMode.Parallel**（这一条不是沿用，是重新论证过的）：
          //    `Exclusive` 的语义是"一旦有手势识别成功，其余一律判未识别"。而
          //    `PanGesture({fingers:1, distance:5})` 只要求 5vp 位移 —— 一个"想长按"的手指
          //    只要抖 5vp，Pan 就先识别成功，**长按从此再也不会被识别**（与上一批"捏合被
          //    Pan 吃掉"是同一个陷阱，只是换了个受害者）。Parallel 下四个手势并发识别，
          //    冲突改由回调里的判据处理 —— 那正是可单测、可推理的一层。
          //
          // ② **长按与 Pan 的天然互斥性**（为什么不需要额外的"谁赢"仲裁）：
          //    平台对长按有自己的移动容差："按住 500ms 且基本不动"才识别；
          //    而 Pan 只要动 5vp 就识别。两者在同一根手指上**几乎不可能同时成立**，
          //    真实形态只有两种边界：
          //      (a) 先抖后按住 —— Pan 先识别（dy 已写了几 vp），500ms 时长按也识别
          //          → 卡片跟手、播放也起。本实现**允许**这个并存（见 ③），
          //          并且用 `gestureHadMotion` 把这次手势从回弹率里摘出去；
          //      (b) 按住后再拖 —— 长按先识别（播放已起），Pan 随后识别 → 卡片开始跟手。
          //          这是"按住看了两眼、又想滑走"，翻页照常发生；换卡时 resetMotion()
          //          会把播放停掉（那是"这张卡到此为止"的唯一时刻）。
          //    特意**不**做"长按期间冻结卡片"（不写 dy、settle 早退）：那会让一次误触长按
          //    变成"卡片几百毫秒不跟手"的手感故障，而且"冻结"类标记一旦哪条路径漏清
          //    就是上一批花大力气修掉的那种**不自愈死锁**。这里选择"允许并存 + 只在指标上
          //    摘出去"，代价小得多、可逆得多。
          //
          // ③ **`fingers` 的陷阱这次提前拆掉了**：`LongPressGesture` 的 `fingers` 同样是
          //    **最少**手指数（`gesture.d.ts:1414` 原文 "minimum number of fingers"），
          //    所以 `fingers:1` 在双指按住时**照样会命中**。判据不写在参数里（参数做不到），
          //    而是进闸门：`shouldStartMotionPlayback({... fingers: e.fingerList.length})`
          //    在 `fingers > 1` 时拒绝起播（有单测）。SDK 另有一条提醒（`gesture.d.ts:1389`）：
          //    API 18 起部分设备上**系统级双指长按会抢占**，所以这里的取舍是"少播一次"。
          //
          // ④ 与**双击**的关系：双击要求"两次短按"，长按要求"一次长按" —— 手指抬起的
          //    时机把两者分开了，平台侧不需要我们做任何事。唯一的边界是"第一下按太久"：
          //    那一下会成为长按（起播），双击自然不会完成 —— 这是用户看得懂的结果。
          //
          // ⑤ 与**捏合**的关系：不靠手指数猜，直接把"正在缩放"作为闸门的一条
          //    （`pinching || gestureIsZoom`）—— 一次缩放操作不该变成开始播放。
          //
          // ⑥ **作废体系（decidedId / isGestureVoided）**：长按**只读不写**。
          //    它不产生决策，所以不写 decidedId、不写 decidedDuringGesture；
          //    它也不写 gestureId —— 那个字段的语义是"本次**拖动**手势的起点卡"，
          //    而这套机制的两次历史缺陷都出在"多一个写入者 + 生命周期没对齐"上
          //    （见 isGestureVoided 的注释）。写入者越少，那条不自愈死锁的面越小。
          //    它需要的"作废"由**换卡即卸载**承担（onItemChanged → resetMotion）：
          //    与动图的 releaseAnim() 是同一个结构性出口 —— 卡片换了，播放的东西就没了，
          //    不依赖任何手势回调的顺序。
          //    唯一读的一次是 `isGestureVoided()`（另一根手指刚把这张卡决定掉时不受理），
          //    方向取"宁可少受理一次"，与双击/按钮同一取舍。
          //
          // ⑦ **角标没亮时的长按 = 用户自己的重试动作**（缺陷 D4 新增的唯一行为）。
          //    旧实现里这一按什么都不发生，而且**再按多少次都不会变**：探测失败（超时 /
          //    查库 0 条）被写进了那个两用的"已下结论"字段，重新触发的唯一执行者
          //    `@Watch onItemChanged` 又按 photoId 去重 —— 用户没有任何恢复手段。
          //    现在 `onMotionPress` 在 `!motionReady` 时补一次探测：本次长按来不及
          //    （探测是异步的），**再按一次就好了**。上界见 MOTION_PROBE_MAX_ATTEMPTS，
          //    它保证"一直按"不会变成"一直发 IPC"。
          //    为什么把恢复动作挂在**长按**而不是新加一个按钮：长按本来就是这张卡上
          //    "我想要动态"的唯一表达，用户的意图和恢复动作是同一个动作 —— 不需要教。
          //
          // 顺序：放在最后（其余三个手势的注释与顺序都不动，改动面最小）。
          // Parallel 之下顺序不影响仲裁 —— 判据全在回调里。
          LongPressGesture({ fingers: 1, repeat: false, duration: MOTION_LONG_PRESS_MS })
            .onAction((e: GestureEvent) => { this.onMotionPress(e); })
            // 松手 → 回静态图。`onActionEnd` 的 SDK 定义正是"识别成功后所有手指抬起"
            //（`gesture.d.ts:1466-1467`），与"松手回静态"这条需求一字不差。
            .onActionEnd(() => { this.onMotionRelease(); })
            // 取消（识别成功后收到触摸取消）→ 同上：也必须回静态图，
            // 否则会停在一个"手指早就不在了、画面还在动"的状态。
            .onActionCancel(() => { this.onMotionRelease(); })
        )
      )

      // 四个按钮：卡片外侧、卡片下方一行等分（layoutWeight(1)）。位置取舍见 M1 报告：
      // 塞进卡片内会压住照片主体（违反「不遮挡」），放在卡片外还顺带避开了与卡片
      // PanGesture 的竞争。顺序按使用频率与危险度排：主页面（回首页）/ 归档 / 上墙 / 收藏。
      //
      // ── 视觉层级方案（本批新增；这是"四个按钮一样重"的修法）────────────────────
      // 旧版：四个**都是实心填充**（上墙是蓝的，其余三个是 `#E6E6E6` 的大灰块）——
      // 四个等宽等高的实心块，没有任何一个更抢眼；三个灰块还占了卡片下方一大片面积，
      // 与"照片是主角"直接冲突。
      //
      // 新方案用**两条互相独立的手段**表达"上墙是最重要的那一个"：
      //   ① **面积**：一行里**只有**「上墙」是实心强调块（`C_ACCENT` + 白字 4.94:1），
      //      其余三个是描边胶囊（`C_SURFACE` 底 + 1vp 边框 + 各自的语义墨色）——
      //      实心块在一排描边里天然是唯一的视觉焦点，这条不依赖颜色深浅的判断；
      //   ② **字重**：只有「上墙」的标签用 `FontWeight.Medium`，其余用默认字重。
      //      去掉①或②中任意一条，层级仍然成立（所以它不是"两个弱手段凑一起"）。
      //
      // 三个次按钮**各自有墨色**，而且都不是随手挑的（全部 ≥ 4.5:1，见令牌表）：
      //   · 主页面 = `C_TEXT_DIM`（**无色**）—— 它是导航，不是对这张照片的表态。
      //     刻意让它成为唯一"没有颜色"的那一个，用户扫一眼就知道它不该按得快；
      //   · 归档 = `C_ARCHIVE`（苔绿，与地图陆地同族）；
      //   · 收藏 = `C_FAV`（暖砖红，与地图钉同族）。
      //   （为什么归档不复用"无色"：那会让它与主页面**完全同形**，
      //     用户必须读字才能分清"离开这一页"和"处理掉这张照片" —— 是实打实的误触成本。）
      //
      // 尺寸：四个都是 44vp 高（触摸目标下限），行高 48。改这一行**不影响刷卡手感**：
      // `cardHeight`（位移阈值与翻出距离的基准）是父组件量到**可用区**高度后乘
      // `CARD_HEIGHT_RATIO` 得来的，与这一行无关。
      // batch-42 更正一处**改动前后都写错了**的说法（原标题：「本行只让"卡片 + 按钮"整体在
      // 纵向的居中位置挪了 2vp（Column 是 FlexAlign.Center）」）：那一行本身只挪 2vp 属实，
      // 但它所在的位置不是"居中位置"——本行是 Column 的第二个子节点，卡片填满之后
      // 它被推到**可用区最底**（761.14 … 809.14），与改前的 644.9 … 692.9 相差 116.2pt
      // （正是被消灭的死区② 的高度）。这是死区归零的**必然代价**，不是副作用：
      // 按钮行不在卡片里（手势命中区不重叠这条未变），所以"卡片下方没有空白"只能是
      // "按钮行贴着可用区底"。真机上要验的是它离屏底只剩 2vp（行高 48 − 按钮 44）/2
      // 会不会碰系统手势条 —— 见报告 §9。
      //
      // ── batch-43 更正上面最后一句里的 **2vp**（旧结论 + 推翻它的证据）─────────────
      // 旧结论（上一段）：「按钮行下沿 = 809.14（可用区底 = 屏底）⇒ 按钮下沿距屏底 2vp」。
      // 本批查 SDK 后认定：**"2vp"这个数在"距页面底"这一层上是对的，错的是它被当成了
      // "距屏底"** —— 中间少了一整段"平台避让区"。两句话拆开说：
      //   ① **页面底不是屏底**（这一条推翻旧结论）：本工程 `EntryAbility.ets` 没有调
      //      `setWindowLayoutFullScreen`，而 SDK 写着这两个接口都没调时
      //      `getImmersiveModeEnabledState()` 默认为 **false**（`@ohos.window.d.ts:8404-8407`），
      //      非沉浸式 = "布局避让状态栏与导航栏"（同文件 `:4504-4505`）；
      //      `common.d.ts:17531-17532` 更直接地把系统避让区称为"页面容器的**固有安全区内边距**"。
      //      真机旁证见 `core/designTokens.ts` 的 `BOTTOM_SAFE_INSET`（`WallPage` 量到的
      //      画布高说明页面内容比屏幕**短 66~125vp**）。⇒ onAreaChange 量到的可用区
      //      **不包含**系统手势区，"可用区底"是**安全区底**。
      //   ② **那 2vp 本身没错**（这一条更正的是**本批一开始的误读**，留档以免下次再错）：
      //      我最初以为 `SwipePage` 的根 Column 有 `.padding(S3)`、于是按钮距页面底是 14vp。
      //      复核源码后作废：`.padding(S3)` 挂在**顶部行**上（`SwipePage.ets:300` 收的是那个
      //      `Row`），**根 Column 没有内边距**（`:378` 只有 `.width('100%').height('100%')`）。
      //      所以按钮行下沿就是可用区底，减去行内 (48 − 44)/2 = 2 ⇒ **距页面底 2vp**，与旧读数一致。
      //      （上一批那张表里的 71 / 761.14 / 809.14 仍然作废 —— 它们建立在"页面底 = 屏底"上；
      //      但作废的理由只有这一条，不是我一度以为的"漏了根 Column 内边距"。它真正用到的
      //      "两条死区相等且都归零"是个**关系**，与绝对 y 无关，仍然成立。）
      // ⇒ 本批的结论：按钮**本来就不在**手势条底下，但它距**页面底**只剩 2vp，且那 2vp 不是
      //    设计出来的余量、只是"行高 48 − 按钮 44"的副产品。所以本批仍然把这一行抬起来
      //    （见下面 `.margin` 那一行与 `BOTTOM_SAFE_INSET` 的说明）：
      //    · 它依赖"没人给任何节点加 expandSafeArea / 没人把窗口改成沉浸式"这个**没写下来的前提**；
      //    · 手势热区比导航条本身宽，而导航条高度是设备相关的（手势导航 ≈24vp / 三键 ≈48vp）。
      Row({ space: S2 }) {
        Button('主页面')
          .fontSize(F_LABEL).height(44).layoutWeight(1).borderRadius(R_MD)
          .backgroundColor(C_SURFACE).fontColor(C_TEXT_DIM)
          .border({ width: LW_BORDER, color: C_TEXT_DIM })
          .onClick(() => { this.tapHome(); })
        Button('归档')
          .fontSize(F_LABEL).height(44).layoutWeight(1).borderRadius(R_MD)
          .backgroundColor(C_SURFACE).fontColor(C_ARCHIVE)
          .border({ width: LW_BORDER, color: C_ARCHIVE })
          .onClick(() => { this.tapDecide('archive'); })
        Button('上墙')
          .fontSize(F_LABEL).fontWeight(FontWeight.Medium).height(44).layoutWeight(1).borderRadius(R_MD)
          .backgroundColor(C_ACCENT).fontColor(C_ON_PHOTO)
          .border({ width: LW_BORDER, color: C_ACCENT })
          .onClick(() => { this.tapWall(); })
        Button('收藏')
          .fontSize(F_LABEL).height(44).layoutWeight(1).borderRadius(R_MD)
          .backgroundColor(C_SURFACE).fontColor(C_FAV)
          .border({ width: LW_BORDER, color: C_FAV })
          .onClick(() => { this.tapDecide('fav'); })
      }
      .width('100%').height(48)
      // ── batch-43：把动作行抬离页面底 —— 让「上墙」离开系统手势区 ────────────────────
      // `BOTTOM_SAFE_INSET` 的定义、取值理由（24 手势高度 + 8 余量 = 32）、"为什么不走
      // `getWindowAvoidArea`"、以及**什么情况下要复核这个数**，全部写在 `core/designTokens.ts`
      // 那个常量上 —— 这里只说三件只有本文件才知道的事：
      //
      // ① **为什么用 `margin` 而不是别的**：`.height(48)` 是 task-24 验过的一个尺寸
      //    （按钮 44 = 触摸目标下限、行高 48），不改它；`margin` 在盒外，本行的**行高与
      //    按钮尺寸一个像素都不动**，只是它的 margin 盒向下多占 `BOTTOM_SAFE_INSET`。
      //    （等价写法是本 Column 的 `.padding({bottom: …})`；这里选 `margin` 是因为它贴在
      //    "被抬起来的那个东西"上，下一个人读到这一行就知道谁在留这段空。）
      //
      // ② **为什么这段净空加在 `CardStack` 里，而不是 `SwipePage` 的根 Column 上** ——
      //    这是本批**唯一**需要解释"为什么放在这一层"的地方，因为放错层就会改掉照片：
      //      · `SwipePage` 的根 Column 一加底部 padding，**可用区（Stack）的高 `H` 就会变小**
      //        ⇒ `this.cardH = h * CARD_HEIGHT_RATIO` 变小 ⇒ `@Prop cardHeight` 变小 ⇒
      //        **照片盒（Contain 的框）跟着变小** ⇒ 高受限的竖幅照片会被缩小，
      //        而且 `boxW/boxH`（缩放/平移边界的两个输入）与两个手势阈值**一起**变。
      //      · 加在**本列**里则相反：`SwipePage` 量到的 `H` **一个数都不变**，
      //        于是 `cardHeight`（= 0.62H）、照片盒、`boxW/boxH`、位移阈值
      //        （`cardHeight × NAV_DISTANCE_RATIO`）、翻出距离（`cardHeight × 1.2`）
      //        **逐位不变**；变的只有"可见卡片"的高（`layoutWeight(1)` 让卡片自动矮
      //        `BOTTOM_SAFE_INSET`）与照片在卡内的位置（照片盒仍在卡内居中 ⇒ 上移半个
      //        净空 = 16vp，尺寸不变）。
      //      ⇒ 一句话：**净空是从"可见卡片"里让出来的，不是从"照片"里让出来的。**
      //
      // ③ **照片不会因此变小**（这一点必须能逐位说清，报告 §5 有改前/改后的数值对照）：
      //    照片的尺寸只由**照片盒**（`this.cardHeight`）× `ImageFit.Contain` 决定，
      //    而照片盒 = 0.62 × `H`，`H` 本批一行未动。卡片变矮只影响：
      //      · 卡内衬纸（`C_PHOTO_MAT`）的上下留白各少 16vp —— 那正是"相纸"的读数，
      //        本来就有富余（本机可用区高 `H` 的估算区间 **632~691** ⇒ 照片盒 0.62H ≈ 392~428，
      //        卡片高 H − 80 ≈ 552~611，盒仍稳稳在卡内；`H` 的估算依据见报告 §1.4）；
      //      · 4× 放大时的可裁切范围——裁剪点是**照片盒**（见下面 `.clip(true)` 的说明），
      //        也不受影响。
      .margin({ bottom: BOTTOM_SAFE_INSET })
    }
    // 86% 与 SwipePage.ets 的 CARD_WIDTH_RATIO 曾经是同一个事实的两处表达；横向模型取消后
    // 宽度不再参与任何阈值，那个常量已随之删除，这里的 86% 只是纯布局。
    // ── 本批（batch-41）把它改成 94%：这是**唯一**能真正缩小「照片上方空白」的旋钮 ──────
    // 竖向布局的算术（脚本 fix-batch-41-layout.mjs 现算，报告 §2 有完整表）：
    //   照片上沿 = 顶行下沿 + (可用高 − 按钮行 − 照片高)/2，而横幅照片在 Contain 下
    //   **先按宽度受限**，照片高 = 卡宽 ÷ 照片宽高比。于是：
    //     · 改 `62%` 这个高度比例**根本不动照片** —— 卡片的上下边会跟着挪，照片上沿一动不动
    //       （验算：0.50 / 0.62 / 0.78 三档，照片上沿恒为 293.3pt @376×809.14）。
    //       那条路只会改掉位移阈值（卡高 × NAV_DISTANCE_RATIO）与翻出距离（卡高 × 1.2）
    //       两个真机验过的量，换不到一个像素的空白 —— 所以本批**不碰**它；
    //       ⚠️ **batch-42 更正这条的适用范围**：上面"根本不动照片"只在**宽受限**时成立
    //       （照片比例 ≥ 卡宽/卡高 = 353.44/457.65 = 0.772）。一张 3:4 竖幅照片是高受限
    //       （照片高 = 卡高），三档的照片上沿是 **231.5 / 187.2 / 180.4** —— **会动**。
    //       本批对该比例的禁令**仍然有效**（改它确实会把位移阈值与翻出距离一起带走），
    //       但理由要换成更强的那一条：**用户圈的两条空白带在卡片之外，与照片位置无关** ——
    //       它们是 `(可用区 − 卡高 − 按钮行)/2`，改比例只让它们与卡内衬纸此消彼长。
    //       完整推导、"旧结论错在哪"与本批的修法见报告 §1/§2/§3。
    //     · 真正能缩小空白的只有"让照片变大"，而照片的宽度上限**就是**这一行。
    //   94% 的取值不是随手挑的：它让卡片的左右边距 = (376 − 353.4)/2 = **11.3vp**，
    //   与顶部行的 `padding(S3)` = 12vp 基本重合 —— 卡片与顶部行因此共用同一条左右基准线。
    //   实测效果（376×809.14 屏、1.4396 的横幅照片）：照片 323.4×224.6 → **353.4×245.5**
    //   （面积 +19%），照片上方空白 232.8 → **222.3**，卡内衬纸 116.5 → 106.1。
    //   ⚠️ 一条**已核算**的下游影响（查过才敢改）：动图每帧的解码目标由**像素预算**算
    //   （`core/anim.ts::frameDecodeSize`，上限 1.048 Mpx/帧），与卡宽无关；卡片变宽之后，
    //   一张吃满预算的 4:3 动图在 1× 下从"略有余量"（1182px 目标 / 1132px 显示）变成
    //   "约 4.5% 不足"（/ 1237px 显示）—— 肉眼不可辨，且那两个预算是别的任务用单测钉住的
    //   值（`core/` 本批不许动），故只如实记账、不改。
    .width('94%').height('100%')
    // ── batch-42：这里**删掉**了 `.justifyContent(FlexAlign.Center)` ────────────────
    // 旧行为：「卡片 + 按钮行」作为**整体**在可用区里居中 —— 于是上下各留一条等高的
    // 页面底色带，每条都是 `(可用区 − 卡高 − 按钮行)/2` = **116.2pt**，正是用户红圈画的
    // 那两条（报告 §1.2/§1.3 有与控制器读数的逐项对照）。
    // 现在卡片是 `layoutWeight(1)`：它吃满「顶部行之下、按钮行之上」，本列没有剩余空间，
    // 居中无位移可言 —— 留着那一行只会让下一个人以为"整体还居中"。
    // 两条带的恒等式、以及"为什么不是改 `CARD_HEIGHT_RATIO`"，
    // 见 build() 里外层卡片容器上方那段长注释。
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
      // 但这一次回弹**不上报**（report=false；产品裁决：「不算，静默弹回」）：回弹率自
      // batch-39（58ff624）起的单位是「一张照片的一次出现」= 尝试组，它记的是"这一次出现里
      // 有没有过手滑"（旧措辞是"一次滑动尝试没能产生结果"——单位换了、这条判据没变），
      // 而队首下滑根本不是一次尝试 —— 往前已经没有可翻的下一张，
      // 用户想「回看上一张」的意图在队列边界上不存在。上报它会让指标随用户在队首来回蹭而失真。
      // 注意"不算一次尝试"与"进不进分母"是两件事：这一张随后若被收藏/归档/上墙，它的**尝试组
      // 照旧计入分母**（分母含「上墙」），只是不会被标成"手滑过"（见 core/metrics.ts 的 rollbackRate）。
      if (this.canNav(1)) { this.navOut(1); } else { this.springBack(false); }
    } else {
      // 没过阈值 = 一次真正的「滑了但没结果」：照常上报，这是回弹率分子的唯一来源。
      // 本批新增的第三个 report=false：**本次手势期间起过"长按播放动态"**。
      // 语义与既有两支完全一致（report 的两个取值与"这是不是一次滑动尝试"一一对应）：
      // 用户是按住在看动态，不是想滑走 —— 而"按住"本身就会有 >5vp 的手指抖动，
      // 那会让 Pan 识别成功、抬手时按 dy/velocity 判成一次回弹。
      // 上报它等于"用户每看一次动态就给回弹率记一笔"（指标向坏的方向失真，但同样是失真）。
      // ⚠️ 只影响**上不上报**：归位动画与防抖窗口的行为一字不变（见 springBack 的说明），
      // 所以"静默弹回"与普通回弹在观感上没有任何差别。
      this.springBack(!this.gestureHadMotion);
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
   * report 的两个取值与「这是不是一次滑动尝试」一一对应（batch-39（58ff624）换掉的是回弹率的
   * **单位** —— 改成「一张照片的一次出现」= 尝试组，不再说"一次滑动尝试"；而这条判据问的是
   * "这个手势算不算一次尝试"，与单位无关，故一字未改。口径见 core/metrics.ts 的 rollbackRate：
   * 它的分母**含「上墙」**，只有中位数仍排除「上墙」），调用点共四个出口、三种取值：
   *   - settle() 没过阈值 → `!gestureHadMotion`（本批新增的那条见 settle 的说明）：
   *     普通情况是 true（滑了但没结果，回弹率**分子**的唯一来源 —— 按新单位说：这是把该尝试组
   *     标成"手滑过"的唯一来源，不得变成 false）；
   *     而"本次手势期间起过长按播放"时是 false（按住看动态不是滑动尝试）；
   *   - 队首下滑（canPrev 为假，无法再往前）→ false：不是一次滑动尝试（产品裁决），
   *     只做视觉归位，不进任何指标；
   *   - 手势被取消（onActionCancel）→ false：取消不是滑动尝试。
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
