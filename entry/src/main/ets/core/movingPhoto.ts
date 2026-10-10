/**
 * 动态照片（拍摄的 Live Photo / 动态图）的**纯逻辑**：识别判据 + 长按起播的闸门。
 *
 * ── 为什么要有这个模块（本任务的三件事，判定与平台调用分开）──────────────────
 *   1) **「这张是不是动态照片」**（决定角标、决定长按有没有东西可播）——
 *      平台给的是两个不同枚举域的**原始成员值**（`number | string | boolean`），
 *      归一与判据必须与 `getAssets` / `requestMovingPhoto` 分开，才能被单测锁住；
 *   2) **「这次长按该不该起播」**——6 个条件（数据是否就绪、是否已在播、卡片是否在飞、
 *      手势是否已作废、是否在缩放中、按了几根手指）全部是布尔/计数的组合，
 *      写在手势回调里就只能靠真机手试，抽出来就能穷举；
 *   3) 常量镜像：core **不得 import 任何 `@kit.*`**（那条路径会让 Node 单测跑不起来），
 *      所以两个枚举值只能以数字常量 + 注释的方式镜像（`core/anim.ts` 同款处理）。
 *
 * ── 平台事实（来自真机探针，不是文档推断）──────────────────────────────────
 *   · `PhotoSelectResult.movingPhotoBadgeStates` 与 `photoUris` **同序同长**，
 *     `MOVING_PHOTO_ENABLED(1)` / `MOVING_PHOTO_DISABLED(2)` 都表示"这是动态照片"
 *     （2 只是"动效在系统图库里被关掉"，媒体文件本身**仍然是**动态照片）；
 *   · `PhotoAsset.get(PhotoKeys.PHOTO_SUBTYPE)` 回传 `PhotoSubtype.MOVING_PHOTO(3)`，
 *     与上面的角标状态**逐张一致**（探针 C-5/C-6 交叉验证）；
 *     且 `subtype` 是文档明说"不必写进 fetchColumns 也能取"的四个成员之一。
 *   · 两个判据分别落在两个枚举域（subtype=3 / badge∈{1,2}），**不能混用同一个函数**：
 *     把 1 当成 subtype 会把"动态照片"判成普通照片（少播），把 3 当成 badge 则相反（多播）。
 *
 * ── 本文件不 import 任何 `@kit.*`，Node 单测直接跑 ──────────────────────────
 *   `node --experimental-strip-types --test entry/src/main/ets/core/movingPhoto.test.ts`
 */

/**
 * 平台回传的"成员值"的**结构镜像**（`photoAccessHelper.MemberType` = `number | string | boolean`）。
 *
 * 额外带上 `undefined | null`：`PhotoAsset.get()` 的声明类型不含它们，但探针里
 * `get()` 的实际返回值**必须**判一次空（探针 2 的 `subtypeOf` 就是这么写的：
 * `if (v === undefined || v === null) return -1`）。与其在调用点各写一次，
 * 不如让判据自己吃下这个形态 —— 那样"空值算不算动态照片"这件事也进了单测。
 */
export type MotionRawValue = number | string | boolean | undefined | null;

/**
 * `photoAccessHelper.PhotoSubtype.MOVING_PHOTO` 的镜像值。
 * 镜像而不是 import：core 不许 import `@kit.*`（见文件头）。
 * 单测把这个数钉死 —— 它变了，说明平台改了枚举，必须回来一起改。
 */
export const MOVING_PHOTO_SUBTYPE: number = 3;

/** `photoAccessHelper.MovingPhotoBadgeStateType.MOVING_PHOTO_ENABLED` 的镜像值。 */
export const MOVING_PHOTO_BADGE_ENABLED: number = 1;

/**
 * `photoAccessHelper.MovingPhotoBadgeStateType.MOVING_PHOTO_DISABLED` 的镜像值。
 * **它同样算"这是动态照片"**：SDK 原文写的是"the moving photo effect is disabled"，
 * 关掉的是**动效**（系统图库里那张照片长按不播），不是把文件变成静态图。
 * 探针的 C-3 也是按"ENABLED 或 DISABLED 都算动态照片"统计的。
 */
export const MOVING_PHOTO_BADGE_DISABLED: number = 2;

/**
 * 长按判定时长（ms）。取 SDK 默认值 500，理由两条：
 *   · 500 是 `LongPressGesture` 的默认 `duration`，也是系统图库里"长按看动态"的手感基准；
 *   · `gesture.d.ts:1407-1411` 写明：在**默认支持拖拽**的组件（Image 就在这个名单里）上，
 *     长按与拖拽冲突时以 500ms 为分界 —— <500ms 优先长按、≥500ms 优先拖拽。
 *     取 500（不取更短的值）是**刻意**的：更短的时长会让"想慢慢滑走"的手指被误判成长按，
 *     而本项目的核心交互是刷卡，宁可长按稍钝一点，也不能吃掉翻页。
 *     那头"≥500ms 优先拖拽"的风险由 `photoNode()` 上的 `.draggable(false)` 消除（见 ui/CardStack.ets）。
 */
export const MOTION_LONG_PRESS_MS: number = 500;

/**
 * 把原始成员值归一到数字；**无法当成数字的一律 NaN**。
 *
 * 三条刻意的取舍（都由单测钉住）：
 *   · `boolean` → NaN（**不是** `Number(true) = 1`）：这两个枚举域里都没有布尔取值，
 *     平台若在这一列回传布尔，说明这一列不是我们问的那一列 —— 按"不是动态照片"处理，
 *     而不是把 `true` 恰好读成 `MOVING_PHOTO_BADGE_ENABLED(1)` 这种"看起来对"的巧合；
 *   · `undefined` / `null` → NaN（没有值 ≠ 0 = `NOT_MOVING_PHOTO`，两者必须区分得开：
 *     前者是"问不出来"，后者是"明确不是"，只是本任务对二者的处置恰好相同）；
 *   · 数字字符串（`'3'`、`' 3 '`）→ 数字：SQLite/DataShare 回传的列**经常**是字符串形态，
 *     探针自己也是 `Number(v)`。不认字符串会把所有动态照片都判成静态图。
 */
function rawToNumber(raw: MotionRawValue): number {
  if (raw === undefined || raw === null) { return Number.NaN; }
  if (typeof raw === 'boolean') { return Number.NaN; }
  const n: number = Number(raw);
  if (!Number.isFinite(n)) { return Number.NaN; }
  return n;
}

/**
 * `PhotoSubtype` 域的判据：**这张照片是动态照片吗**（本 App 的**主判据**）。
 *
 * 用在 `data/movingPhotoSource.ets` 的第一步：`getAssets(uri)` 拿到 `PhotoAsset` 之后
 * `asset.get(PhotoKeys.PHOTO_SUBTYPE)` → 本函数。它**不解码、不请求视频**，
 * 是这条路上最便宜的一道闸 —— 绝大多数照片（静态图）在这里就被排除，
 * 不会走到 `requestMovingPhoto`（那一步才是真正有代价的）。
 *
 * 契约：只有"确实等于 `MOVING_PHOTO(3)`"才是动态照片。`DEFAULT(0)` / `BURST(4)` /
 * 越界值 / 非数字 / 空值一律 `false`（宁可当静态图，也不要角标亮着却没有东西可播）。
 */
export function isMovingPhotoSubtype(raw: MotionRawValue): boolean {
  return rawToNumber(raw) === MOVING_PHOTO_SUBTYPE;
}

/**
 * `MovingPhotoBadgeStateType` 域的判据：**选图器回传的角标状态是不是动态照片**。
 *
 * ⚠ **本 App 的运行时路径目前不经过它**，这一点如实写明，不留"看起来在用"的假象：
 *   它是 SDK 文档指定的那条路（`PhotoSelectOptions.isMovingPhotoBadgeShown = true`
 *   → `PhotoSelectResult.movingPhotoBadgeStates`），而**开启它的调用点在
 *   `data/claimStore.ets` 的 `pickPhotos()`** —— 那个文件在本任务里是**冻结的**
 *   （见任务约束"不要改动 data/ 既有文件"），所以本 App 拿不到角标数组。
 *   识别主路径改用 `PhotoSubtype`（同一个探针已逐张交叉验证两者一致，见文件头）。
 *
 * 保留它的理由有两条，都不是"以防万一"：
 *   1) 一旦 `pickPhotos` 解冻（加一个 `opt.isMovingPhotoBadgeShown = true`），
 *      这条路径立刻可用，而**判据的契约已经在这里被单测钉死**（1 和 2 都算、0 不算）；
 *   2) 它把"`MOVING_PHOTO_DISABLED(2)` 算不算动态照片"这个**容易搞反**的判定
 *      写在一个有测试的地方 —— 搞反的后果是"用户在系统图库里关过动效的照片永远不播"，
 *      而这种照片在真机上看起来完全正常，属于最难发现的一类缺陷。
 */
export function isMovingPhotoBadgeState(raw: MotionRawValue): boolean {
  const n: number = rawToNumber(raw);
  return n === MOVING_PHOTO_BADGE_ENABLED || n === MOVING_PHOTO_BADGE_DISABLED;
}

/**
 * 一次长按起播的闸门输入。6 个字段各自对应一条**已经被真机/既有缺陷教育过**的理由，
 * 见 `shouldStartMotionPlayback` 的逐条说明。
 */
export interface MotionStartGate {
  /** 这张卡的 `MovingPhoto` 对象是否已经就绪（= 长按真的能播）。 */
  movingPhotoReady: boolean;
  /** 是否已经在播（长按 `repeat` 或平台的重复 `onAction` 都会二次触发本判定）。 */
  alreadyPlaying: boolean;
  /** 翻出动画期间（`animating`）：卡片视觉上已经飞走，此时起播没有意义。 */
  cardAnimating: boolean;
  /** 手势已作废（`isGestureVoided()`）：这张卡正在被换掉，"这次长按属于哪张"不确定。 */
  gestureVoided: boolean;
  /** 正在缩放（`pinching` 或本次手势已被定性为缩放）：一次缩放操作不该开始播放。 */
  zoomInProgress: boolean;
  /** 本次长按事件报告的手指根数（`GestureEvent.fingerList.length`）。 */
  fingers: number;
}

/**
 * 这次长按该不该起播？**全部条件为真才起播**，任何一条不满足都静默忽略。
 *
 * 六条判据的理由（前五条与卡片上四个按钮 / 双击的闸门口径**刻意保持一致**）：
 *   1) `movingPhotoReady`：数据是**后台异步**取的（卡片先显示静态图）。
 *      就绪之前长按必须什么都不做 —— 否则会出现"按了、动画动了、但没东西可播"的假响应。
 *      角标与它是**同一个布尔**："角标亮着" ⟺ "长按有效"，不给用户第二种解释。
 *   2) `alreadyPlaying`：`LongPressGesture({repeat:false})` 只触发一次 `onAction`，
 *      但平台在特定形态下（多指先后落下/抬起）可能重复识别；`repeat:true` 更是持续触发。
 *      没有这条，重复触发会一次次重建播放器组件 = 画面反复从头开始。
 *   3) `cardAnimating`：`navOut()` 已经把卡片移出视野、210ms 后才换卡。这段窗口里
 *      起播会得到一个"飞在半路的卡片上突然开始播视频"的观感，而且它 210ms 后就被换掉了。
 *   4) `gestureVoided`：读而**不写**（长按不产生决策，见 ui/CardStack.ets 的说明）。
 *      另一根手指刚把这张卡决定掉时，这次长按属于哪一张是不确定的 —— 与双击复位同一取舍。
 *   5) `zoomInProgress`：捏合中（或本次手势已被定性为缩放）时长按**不**起播。
 *      一次缩放操作不该变成"开始播放"：那会让"想放大看细节"的手指多按住一会儿就触发播放。
 *   6) `fingers > 1` → 不起播。**`fingers` 是最少手指数，不是精确手指数**
 *      （`gesture.d.ts:1414` 原文："minimum number of fingers to trigger a long press gesture"）
 *      —— 与上一批在 `PanGesture({fingers:1})` 上踩到的陷阱**是同一个**：
 *      两指按住会照样命中"单指长按"。SDK 还额外提醒（`gesture.d.ts:1389-1392`）：
 *      API 18 起部分设备上**系统级双指长按会抢占**，所以这里的方向取"少播一次"，
 *      而不是"两指也能播"。
 *      ⚠ 读不到手指数（`fingerList` 为空 → 0、或 NaN）时**仍然放行**：
 *      "平台没报手指数"不该让整个功能失灵 —— 与 `isGestureVoided()` 的
 *      "宁可少作废也不误作废"同一取舍方向。
 */
export function shouldStartMotionPlayback(g: MotionStartGate): boolean {
  if (!g.movingPhotoReady) { return false; }
  if (g.alreadyPlaying) { return false; }
  if (g.cardAnimating) { return false; }
  if (g.gestureVoided) { return false; }
  if (g.zoomInProgress) { return false; }
  if (Number.isFinite(g.fingers) && g.fingers > 1) { return false; }
  return true;
}
