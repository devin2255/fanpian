/**
 * movingPhoto 单测：动态照片的**两个识别判据**（subtype 域 / badge 域）+ **长按起播闸门**。
 *
 * 为什么这三件事必须在这里钉死：
 *   · 识别判据判错的两个方向都是"真机上看起来正常、但功能少一半"的形态 ——
 *     把动态照片判成静态图（角标不亮、长按无反应），或把静态图判成动态图
 *     （角标亮着却没有东西可播）。而它们在电脑上**完全可以穷举**；
 *   · 起播闸门是 6 个条件的布尔组合，其中"`fingers` 是最少手指数"这一条
 *     正是上一批在 `PanGesture` 上踩过的陷阱（两指捏合照样命中单指手势），
 *     只靠真机手试一定会漏。
 * 平台侧（`getAssets` / `requestMovingPhoto` / `MovingPhotoView`）**不在**这里测 ——
 * 它们只能真机验，那部分写在报告的"真机需验"与"本机验不了"两节。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMovingPhotoSubtype, isMovingPhotoBadgeState, shouldStartMotionPlayback,
  MOVING_PHOTO_SUBTYPE, MOVING_PHOTO_BADGE_ENABLED, MOVING_PHOTO_BADGE_DISABLED,
  MOTION_LONG_PRESS_MS
} from './movingPhoto.ts';
import type { MotionStartGate } from './movingPhoto.ts';

/** 六条件全绿的基准闸门；每个用例只改它要测的那一个维度。 */
function good(): MotionStartGate {
  const g: MotionStartGate = {
    movingPhotoReady: true,
    alreadyPlaying: false,
    cardAnimating: false,
    gestureVoided: false,
    zoomInProgress: false,
    fingers: 1
  };
  return g;
}

// ── 1. 常量镜像（改了平台枚举就必须回来改这里）─────────────────────────────

test('常量镜像：subtype=3、badge=1/2、长按 500ms（与 SDK 枚举逐一对齐）', () => {
  assert.equal(MOVING_PHOTO_SUBTYPE, 3);
  assert.equal(MOVING_PHOTO_BADGE_ENABLED, 1);
  assert.equal(MOVING_PHOTO_BADGE_DISABLED, 2);
  assert.equal(MOTION_LONG_PRESS_MS, 500);
});

// ── 2. subtype 域：PhotoSubtype.MOVING_PHOTO(3) ────────────────────────────

test('subtype 判据：只有 3 算动态照片（数字与数字字符串都认）', () => {
  assert.equal(isMovingPhotoSubtype(3), true);
  assert.equal(isMovingPhotoSubtype('3'), true);
  // DataShare 回传的列经常带空格，探针自己也是 Number(v)
  assert.equal(isMovingPhotoSubtype(' 3 '), true);
});

test('subtype 判据：同域的其他取值一律不算（DEFAULT=0 / BURST=4 / 越界 / 小数）', () => {
  assert.equal(isMovingPhotoSubtype(0), false);
  assert.equal(isMovingPhotoSubtype(1), false);
  assert.equal(isMovingPhotoSubtype(2), false);
  assert.equal(isMovingPhotoSubtype(4), false);
  assert.equal(isMovingPhotoSubtype(-1), false);
  assert.equal(isMovingPhotoSubtype(3.5), false);
  assert.equal(isMovingPhotoSubtype(30), false);
  // 数字字符串的"另一种写法"仍等于 3：它是**同一个数**，不是同一个字面量
  assert.equal(isMovingPhotoSubtype('3.0'), true);
});

test('subtype 判据：空值 / 非数字 / 非有限值一律不算（"问不出来"按"不是"处理）', () => {
  assert.equal(isMovingPhotoSubtype(undefined), false);
  assert.equal(isMovingPhotoSubtype(null), false);
  assert.equal(isMovingPhotoSubtype(''), false);
  assert.equal(isMovingPhotoSubtype('abc'), false);
  assert.equal(isMovingPhotoSubtype('3px'), false);
  assert.equal(isMovingPhotoSubtype(Number.NaN), false);
  assert.equal(isMovingPhotoSubtype(Number.POSITIVE_INFINITY), false);
  assert.equal(isMovingPhotoSubtype(Number.NEGATIVE_INFINITY), false);
});

test('subtype 判据：布尔值一律不算（**不是** Number(true)=1 那种巧合命中）', () => {
  assert.equal(isMovingPhotoSubtype(true), false);
  assert.equal(isMovingPhotoSubtype(false), false);
});

// ── 3. badge 域：MovingPhotoBadgeStateType ────────────────────────────────

test('badge 判据：ENABLED(1) 与 DISABLED(2) **都算**动态照片', () => {
  assert.equal(isMovingPhotoBadgeState(1), true);
  assert.equal(isMovingPhotoBadgeState(2), true);
  assert.equal(isMovingPhotoBadgeState(MOVING_PHOTO_BADGE_ENABLED), true);
  assert.equal(isMovingPhotoBadgeState(MOVING_PHOTO_BADGE_DISABLED), true);
  // 字符串形态（DataShare 列表）
  assert.equal(isMovingPhotoBadgeState('1'), true);
  assert.equal(isMovingPhotoBadgeState('2'), true);
});

test('badge 判据：NOT_MOVING_PHOTO(0) 与越界值不算', () => {
  assert.equal(isMovingPhotoBadgeState(0), false);
  assert.equal(isMovingPhotoBadgeState(3), false);
  assert.equal(isMovingPhotoBadgeState(4), false);
  assert.equal(isMovingPhotoBadgeState(-1), false);
  assert.equal(isMovingPhotoBadgeState(1.5), false);
});

test('badge 判据：空值 / 非数字 / 布尔值不算', () => {
  assert.equal(isMovingPhotoBadgeState(undefined), false);
  assert.equal(isMovingPhotoBadgeState(null), false);
  assert.equal(isMovingPhotoBadgeState(''), false);
  assert.equal(isMovingPhotoBadgeState('moving'), false);
  assert.equal(isMovingPhotoBadgeState(Number.NaN), false);
  assert.equal(isMovingPhotoBadgeState(Number.POSITIVE_INFINITY), false);
  // 布尔 true 若被 Number() 吞掉就会等于 1（= ENABLED）→ 这里明确挡掉
  assert.equal(isMovingPhotoBadgeState(true), false);
  assert.equal(isMovingPhotoBadgeState(false), false);
});

test('两个判据分属两个域，不能互相代替（3 不是 badge，1 不是 subtype）', () => {
  // subtype 的"是动图"值在 badge 域里是"越界"
  assert.equal(isMovingPhotoSubtype(3), true);
  assert.equal(isMovingPhotoBadgeState(3), false);
  // badge 的"是动图"值在 subtype 域里是"不是动图"
  assert.equal(isMovingPhotoBadgeState(1), true);
  assert.equal(isMovingPhotoSubtype(1), false);
  // 唯一的交集是 0 = "不是"，两边都必须为 false
  assert.equal(isMovingPhotoSubtype(0), false);
  assert.equal(isMovingPhotoBadgeState(0), false);
});

// ── 4. 长按起播闸门 ───────────────────────────────────────────────────────

test('闸门：六个条件全绿 → 起播；手指数为 1 是正常形态', () => {
  assert.equal(shouldStartMotionPlayback(good()), true);
});

test('闸门：动态数据没就绪 → 不起播（卡片先显示静态图，后台取数据）', () => {
  const g: MotionStartGate = good();
  g.movingPhotoReady = false;
  assert.equal(shouldStartMotionPlayback(g), false);
});

test('闸门：已经在播 → 不起播（重复识别不得重建播放器组件）', () => {
  const g: MotionStartGate = good();
  g.alreadyPlaying = true;
  assert.equal(shouldStartMotionPlayback(g), false);
});

test('闸门：翻出动画期间 → 不起播（卡片已经飞走，210ms 后就换卡）', () => {
  const g: MotionStartGate = good();
  g.cardAnimating = true;
  assert.equal(shouldStartMotionPlayback(g), false);
});

test('闸门：手势已作废 → 不起播（另一根手指刚把这张卡决定掉）', () => {
  const g: MotionStartGate = good();
  g.gestureVoided = true;
  assert.equal(shouldStartMotionPlayback(g), false);
});

test('闸门：缩放中 → 不起播（一次缩放操作不该变成开始播放）', () => {
  const g: MotionStartGate = good();
  g.zoomInProgress = true;
  assert.equal(shouldStartMotionPlayback(g), false);
});

test('闸门：两根及以上手指按住 → 不起播（fingers 是**最少**手指数，两指也会命中单指长按）', () => {
  const g2: MotionStartGate = good();
  g2.fingers = 2;
  assert.equal(shouldStartMotionPlayback(g2), false);
  const g3: MotionStartGate = good();
  g3.fingers = 3;
  assert.equal(shouldStartMotionPlayback(g3), false);
  const g10: MotionStartGate = good();
  g10.fingers = 10;
  assert.equal(shouldStartMotionPlayback(g10), false);
});

test('闸门：读不到手指数（0 / 负数 / NaN / Infinity）→ **仍然放行**（不许因读不到就把功能整段失灵）', () => {
  const g0: MotionStartGate = good();
  g0.fingers = 0;
  assert.equal(shouldStartMotionPlayback(g0), true);
  const gn: MotionStartGate = good();
  gn.fingers = -1;
  assert.equal(shouldStartMotionPlayback(gn), true);
  const gnan: MotionStartGate = good();
  gnan.fingers = Number.NaN;
  assert.equal(shouldStartMotionPlayback(gnan), true);
  const ginf: MotionStartGate = good();
  ginf.fingers = Number.POSITIVE_INFINITY;
  assert.equal(shouldStartMotionPlayback(ginf), true);
});

test('闸门：多条不满足时仍然是不起播（判据之间是"与"，没有优先级可言）', () => {
  const g: MotionStartGate = {
    movingPhotoReady: false,
    alreadyPlaying: true,
    cardAnimating: true,
    gestureVoided: true,
    zoomInProgress: true,
    fingers: 2
  };
  assert.equal(shouldStartMotionPlayback(g), false);
  const g2: MotionStartGate = {
    movingPhotoReady: true, alreadyPlaying: false, cardAnimating: false,
    gestureVoided: true, zoomInProgress: false, fingers: 3
  };
  assert.equal(shouldStartMotionPlayback(g2), false);
});
