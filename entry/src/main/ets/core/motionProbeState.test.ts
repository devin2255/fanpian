/**
 * motionProbeState 单测：动态照片「为当前卡取对象」的**重试状态机**（缺陷 D4）。
 *
 * 为什么这一条必须在这里钉死：fix-batch-37 修好 D4 之后自己登记了诚实边界 ——
 * 「D4 的刷卡页状态机**没有单测**」。它的三个关键性质（瞬时失败必须留着重试的机会、
 * 重试必须有上界、过期结果必须被丢弃且不写脏新状态）全都只能在真机上靠"手滑几次看看"验证，
 * 而其中两条的**错误方向都是静默的**：
 *   · 瞬时失败被写成结论 → 同一张卡本会话内再也没有机会（角标不亮、长按无反应、无恢复动作）；
 *   · 取消上界 → 用户每拖一次就发一次 `getAssets` 查库 + 最长 5s 的 `requestMovingPhoto` 等待。
 * 两者在电脑上完全可以穷举 —— 这就是本文件的全部理由。
 *
 * 平台侧（`getUIContext` / `getAssets` / `requestMovingPhoto` / `MovingPhotoView`）**不在**这里测：
 * 它们只能真机验（见报告"真机需验"一节）。本模块零 `@kit.*`，所以 Node 直接跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOTION_PROBE_MAX_ATTEMPTS,
  newMotionProbeState, beginMotionProbe, armMotionProbe, settleMotionProbe, releaseMotionProbe,
  isMotionConcluded, isMotionInFlight, motionAttempts, motionAttemptsLeft
} from './motionProbeState.ts';
import type {
  MotionProbeState, MotionProbeTicket, MotionProbeVerdict, MotionProbeArm
} from './motionProbeState.ts';

// ── 三个"真相"构造器（避免每个用例手写内联字面量，也就避免了抄错字段）─────────
/** data 层给"这次没探到"（查库 0 条 / 超时 / 回传空）：**瞬时失败**。 */
function missedVerdict(): MotionProbeVerdict {
  return { concluded: false, hasHandle: false };
}
/** data 层给"确定不是动态照片"（`confirmedNoMotion` 已写）：**确定性负结论**。 */
function negativeVerdict(): MotionProbeVerdict {
  return { concluded: true, hasHandle: false };
}
/** data 层给"对象到手"：**确定性正结论**。 */
function readyVerdict(): MotionProbeVerdict {
  return { concluded: true, hasHandle: true };
}

/** 断言状态逐字段等于给定值（比深比较的失败信息更可读）。 */
function assertState(s: MotionProbeState, concludedId: string, inFlightId: string, tries: number, msg: string): void {
  assert.equal(s.concludedId, concludedId, `${msg}｜concludedId`);
  assert.equal(s.inFlightId, inFlightId, `${msg}｜inFlightId`);
  assert.equal(s.tries, tries, `${msg}｜tries`);
}

/**
 * 把"一次完整的探测"走完（begin → arm → settle），返回迁移后的状态。
 * 它模拟的是 `CardStack.ensureMotionForCurrent` + `onMotionLoaded` 的调用序列：
 * `seq` 由调用方每次递增注入（与 `CardStack.motionSeq` 同款）。
 */
function probeOnce(s: MotionProbeState, id: string, seq: number, max: number, v: MotionProbeVerdict): MotionProbeState {
  const b = beginMotionProbe(s, id, max);
  assert.equal(b.allowed, true, `probeOnce 前提不成立：begin 被拒（${b.deny}）`);
  const armed: MotionProbeArm = armMotionProbe(b.state, id, seq);
  const st = settleMotionProbe(armed.state, armed.ticket, id, seq, v);
  assert.notEqual(st.outcome, 'stale', 'probeOnce 前提不成立：结果被判过期');
  return st.state;
}

// ── 1. 常量与初始状态 ───────────────────────────────────────────────────────

test('上界常量 = 3，且初始状态是"没结论、没在途、预算满格"', () => {
  assert.equal(MOTION_PROBE_MAX_ATTEMPTS, 3);
  const s = newMotionProbeState();
  assertState(s, '', '', 0, '初始状态');
  assert.equal(isMotionConcluded(s, 'A'), false);
  assert.equal(isMotionInFlight(s, 'A'), false);
  assert.equal(motionAttempts(s), 0);
  assert.equal(motionAttemptsLeft(s, MOTION_PROBE_MAX_ATTEMPTS), 3);
});

// ── 2. 四道闸（拒绝原因互不相同，因为真机上的修法完全不同）───────────────────

test('闸①：没有 photoId 时不允许探测，且这次尝试**没有被用掉**', () => {
  const s = newMotionProbeState();
  const b = beginMotionProbe(s, '', MOTION_PROBE_MAX_ATTEMPTS);
  assert.equal(b.allowed, false);
  assert.equal(b.deny, 'empty-id');
  assertState(b.state, '', '', 0, '空 id 被拒后');
});

test('闸① 优先于闸④：上界 = 0 且 id 为空时，拒绝原因是 empty-id（不是 budget）', () => {
  const b = beginMotionProbe(newMotionProbeState(), '', 0);
  assert.equal(b.allowed, false);
  assert.equal(b.deny, 'empty-id');
});

test('闸③：**同卡不并发** —— 在途时再请求被拒（deny = in-flight）', () => {
  const b1 = beginMotionProbe(newMotionProbeState(), 'A', MOTION_PROBE_MAX_ATTEMPTS);
  const a1 = armMotionProbe(b1.state, 'A', 1);
  assert.equal(isMotionInFlight(a1.state, 'A'), true);
  const b2 = beginMotionProbe(a1.state, 'A', MOTION_PROBE_MAX_ATTEMPTS);
  assert.equal(b2.allowed, false);
  assert.equal(b2.deny, 'in-flight');
  // 被拒**不消耗**预算：只有第一次尝试记在了账上。
  assertState(b2.state, '', 'A', 1, '在途被拒后');
});

test('在途标记的语义闭环：任意非空 inFlightId 都让"同 id 再 begin"被拒', () => {
  let s = newMotionProbeState();
  const ids: string[] = ['A', 'B', 'C'];
  for (let i = 0; i < ids.length; i++) {
    const b = beginMotionProbe(s, ids[i], MOTION_PROBE_MAX_ATTEMPTS);
    assert.equal(b.allowed, true);
    const a = armMotionProbe(b.state, ids[i], i + 1);
    s = a.state;
    assert.equal(s.inFlightId, ids[i]);
    assert.equal(beginMotionProbe(s, ids[i], MOTION_PROBE_MAX_ATTEMPTS).deny, 'in-flight');
  }
});

// ── 3. 瞬时失败 → 可以重试；重试有上界 ──────────────────────────────────────

test('D4 回归【瞬时失败可重试】：missed 之后**不写结论**，同一张卡还能再探一次', () => {
  const id = 'A';
  const s1 = probeOnce(newMotionProbeState(), id, 1, MOTION_PROBE_MAX_ATTEMPTS, missedVerdict());
  // 这是 D4 的核心：瞬时失败**不是**结论。
  assert.equal(isMotionConcluded(s1, id), false, '瞬时失败被写成了"已下结论" —— D4 复活');
  assert.equal(isMotionInFlight(s1, id), false, '在途标记没有解除 —— 这张卡会被永久挡住');
  assertState(s1, '', '', 1, '一次瞬时失败之后');
  // 于是下一次交互（拖动 / 长按）**能**再发起一次。
  const b2 = beginMotionProbe(s1, id, MOTION_PROBE_MAX_ATTEMPTS);
  assert.equal(b2.allowed, true, '瞬时失败之后不允许重试 —— 这正是 D4');
  assert.equal(b2.deny, 'none');
});

test('【重试有上界】上界 = 3 时：第 1~3 次允许、第 4 次被 budget 拒（且被拒不吃预算）', () => {
  const id = 'A';
  let s = newMotionProbeState();
  const allowed: boolean[] = [];
  const denies: string[] = [];
  // 走 4 轮"begin → arm → 瞬时失败"，第 4 轮的 begin 必须被拒。
  for (let round = 1; round <= 4; round++) {
    const b = beginMotionProbe(s, id, MOTION_PROBE_MAX_ATTEMPTS);
    allowed.push(b.allowed);
    denies.push(b.deny);
    s = b.state;
    if (!b.allowed) { break; }
    const a = armMotionProbe(s, id, round);
    s = settleMotionProbe(a.state, a.ticket, id, round, missedVerdict()).state;
  }
  assert.equal(allowed.length, 4, '第 4 轮没有发生 —— 循环写错了');
  assert.equal(allowed[0], true);
  assert.equal(allowed[1], true);
  assert.equal(allowed[2], true);
  assert.equal(allowed[3], false, '第 4 次仍然被允许 —— 重试没有上界');
  assert.equal(denies[3], 'budget');
  assert.equal(motionAttempts(s), 3, '被拒的那一次不该被计入预算');
  assert.equal(motionAttemptsLeft(s, MOTION_PROBE_MAX_ATTEMPTS), 0);
});

test('【上界边界】上界 = 0 / 1 / 3 各断言一次', () => {
  const id = 'A';

  // 上界 = 0：一次都不许探（"这次访问没有预算"这个状态是可达的，必须明确定义）。
  const b0 = beginMotionProbe(newMotionProbeState(), id, 0);
  assert.equal(b0.allowed, false, '上界 0 竟然允许了探测');
  assert.equal(b0.deny, 'budget');
  assertState(b0.state, '', '', 0, '上界 0 被拒后');

  // 上界 = 1：只允许一次。
  const b1 = beginMotionProbe(newMotionProbeState(), id, 1);
  assert.equal(b1.allowed, true);
  assert.equal(b1.state.tries, 1);
  const a1 = armMotionProbe(b1.state, id, 1);
  const after1 = settleMotionProbe(a1.state, a1.ticket, id, 1, missedVerdict()).state;
  const b1b = beginMotionProbe(after1, id, 1);
  assert.equal(b1b.allowed, false, '上界 1 竟然允许了第二次');
  assert.equal(b1b.deny, 'budget');

  // 上界 = 3（生产值）：恰好三次。
  let s = newMotionProbeState();
  let ok = 0;
  for (let i = 1; i <= 4; i++) {
    const b = beginMotionProbe(s, id, 3);
    if (!b.allowed) { break; }
    ok = ok + 1;
    const a = armMotionProbe(b.state, id, i);
    s = settleMotionProbe(a.state, a.ticket, id, i, missedVerdict()).state;
  }
  assert.equal(ok, 3, '上界 3 实际允许了 ' + ok + ' 次');
  assert.equal(s.tries, 3);
});

test('预算算的是**尝试**而不是"发出去的 IPC"：begin 允许后没 arm（取不到宿主 Context）也照样记账', () => {
  const id = 'A';
  let s = newMotionProbeState();
  // 路径 A（D4 的另一半）：闸门放行 → 取宿主 Context 失败 → 探测根本没发出去。
  const b1 = beginMotionProbe(s, id, MOTION_PROBE_MAX_ATTEMPTS);
  assert.equal(b1.allowed, true);
  s = b1.state;                     // 调用点在这里 return，既不 arm 也不 settle
  assertState(s, '', '', 1, '同步失败一次之后');
  assert.equal(isMotionInFlight(s, id), false, '同步失败**绝不能**置在途 —— 那会把这张卡永久挡住');
  assert.equal(isMotionConcluded(s, id), false, '同步失败更不是结论');
  // 于是还能重试，直到预算用尽。
  const b2 = beginMotionProbe(s, id, MOTION_PROBE_MAX_ATTEMPTS);
  assert.equal(b2.allowed, true);
  s = b2.state;
  const b3 = beginMotionProbe(s, id, MOTION_PROBE_MAX_ATTEMPTS);
  assert.equal(b3.allowed, true);
  s = b3.state;
  const b4 = beginMotionProbe(s, id, MOTION_PROBE_MAX_ATTEMPTS);
  assert.equal(b4.allowed, false);
  assert.equal(b4.deny, 'budget');
  assert.equal(motionAttempts(s), 3);
});

test('arm **不清空预算**（放这里清零 = 每次尝试都把上界清掉）', () => {
  const id = 'A';
  const b1 = beginMotionProbe(newMotionProbeState(), id, MOTION_PROBE_MAX_ATTEMPTS);
  const a1 = armMotionProbe(b1.state, id, 1);
  assert.equal(a1.state.tries, 1, 'arm 把 tries 清了 —— 上界会被无限重置');
  const a2 = armMotionProbe(a1.state, id, 2);
  assert.equal(a2.state.tries, 1, 'arm 第二次调用改了 tries');
});

test('release **清结论 + 清在途但保留预算**（放这里清零 = 每次尝试都把上界清掉）', () => {
  const id = 'A';
  // 先攒下一次尝试与一条在途。
  const b1 = beginMotionProbe(newMotionProbeState(), id, MOTION_PROBE_MAX_ATTEMPTS);
  const a1 = armMotionProbe(b1.state, id, 1);
  assertState(releaseMotionProbe(a1.state), '', '', 1, 'release 在途状态之后');
  // 结论也被清（否则闸② 会把下一次探测挡在门外）。
  const concluded = probeOnce(newMotionProbeState(), id, 1, MOTION_PROBE_MAX_ATTEMPTS, negativeVerdict());
  assert.equal(isMotionConcluded(concluded, id), true);
  const afterRelease = releaseMotionProbe(concluded);
  assert.equal(isMotionConcluded(afterRelease, id), false, 'release 没有清结论 —— 下一次探测会被闸② 挡住');
  assert.equal(beginMotionProbe(afterRelease, id, MOTION_PROBE_MAX_ATTEMPTS).allowed, true);
  // 预算保留：release 之后本来就该还在（它只服务于"腾位置"，不是"新的一次访问"）。
  assert.equal(motionAttempts(afterRelease), 1);
});

// ── 4. 确定性结论 → 不再重试（换卡才重置）────────────────────────────────────

test('【确定性结论后不再重试】负结论（concluded=true）写结论 → 闸② 拒绝，且**不是** budget', () => {
  const id = 'A';
  const s1 = probeOnce(newMotionProbeState(), id, 1, MOTION_PROBE_MAX_ATTEMPTS, negativeVerdict());
  assert.equal(isMotionConcluded(s1, id), true, '确定性负结论没有被记成结论');
  assertState(s1, id, '', 1, '一次负结论之后');
  const b2 = beginMotionProbe(s1, id, MOTION_PROBE_MAX_ATTEMPTS);
  assert.equal(b2.allowed, false);
  assert.equal(b2.deny, 'concluded', '拒绝原因不是 concluded —— 说明它在靠预算兜底，预算一放大就会重试');
  // 预算还剩 2 次，仍然不探 —— 这条把"结论"与"预算用尽"彻底分开。
  assert.equal(motionAttemptsLeft(s1, MOTION_PROBE_MAX_ATTEMPTS), 2);
});

test('【确定性结论后不再重试】正结论（对象到手）同样定案，不再探测', () => {
  const id = 'A';
  const s1 = probeOnce(newMotionProbeState(), id, 1, MOTION_PROBE_MAX_ATTEMPTS, readyVerdict());
  assert.equal(isMotionConcluded(s1, id), true);
  assert.equal(isMotionInFlight(s1, id), false, '正结论没有解除在途标记');
  assert.equal(beginMotionProbe(s1, id, MOTION_PROBE_MAX_ATTEMPTS).deny, 'concluded');
});

test('【换卡才重置】newMotionProbeState() 清空结论 / 在途 / 预算 —— 换走再滑回来是一张新卡', () => {
  const id = 'A';
  let s = probeOnce(newMotionProbeState(), id, 1, MOTION_PROBE_MAX_ATTEMPTS, missedVerdict());
  s = probeOnce(s, id, 2, MOTION_PROBE_MAX_ATTEMPTS, negativeVerdict());
  assert.equal(motionAttempts(s), 2);
  assert.equal(isMotionConcluded(s, id), true);
  // 换卡（CardStack.onItemChanged / aboutToDisappear → resetMotion）
  const fresh = newMotionProbeState();
  assertState(fresh, '', '', 0, '换卡重置后');
  assert.equal(isMotionConcluded(fresh, id), false);
  assert.equal(beginMotionProbe(fresh, id, MOTION_PROBE_MAX_ATTEMPTS).allowed, true);
});

// ── 5. `.catch` 必须解除在途标记（一次 rejection 不能永久挡住该卡）─────────────

test('【.catch 解除在途】一次 rejection 之后同一张卡**还能**再探（不会被闸③ 永久挡住）', () => {
  const id = 'A';
  const b1 = beginMotionProbe(newMotionProbeState(), id, MOTION_PROBE_MAX_ATTEMPTS);
  const a1 = armMotionProbe(b1.state, id, 1);
  assert.equal(isMotionInFlight(a1.state, id), true, '前提不成立：arm 之后应当有在途');
  // `CardStack` 的 `.catch` 分支：loadMotion 意外 rejection → 按"瞬时失败"结算（没有 result）。
  const st = settleMotionProbe(a1.state, a1.ticket, id, 1, missedVerdict());
  assert.equal(st.outcome, 'missed');
  assert.equal(isMotionInFlight(st.state, id), false, 'rejection 没有解除在途标记 —— 这张卡被永久挡住了');
  assert.equal(isMotionConcluded(st.state, id), false, 'rejection 不该写成结论');
  const b2 = beginMotionProbe(st.state, id, MOTION_PROBE_MAX_ATTEMPTS);
  assert.equal(b2.allowed, true, 'rejection 之后不允许重试 —— 这就是"永久挡住"');
  assert.equal(b2.deny, 'none');
});

test('在途标记只解除"自己那一条"：结算 A 的探测不会动 B 的在途标记', () => {
  // 不变量：inFlightId 只有一个槽。A 的结果过期与否，都不该让"当前在途的 B"失去标记。
  const bA = beginMotionProbe(newMotionProbeState(), 'A', MOTION_PROBE_MAX_ATTEMPTS);
  const aA = armMotionProbe(bA.state, 'A', 1);
  // 换卡：reset 之后为新卡 B 起一次探测（真实顺序见 CardStack.onItemChanged）。
  const bB = beginMotionProbe(newMotionProbeState(), 'B', MOTION_PROBE_MAX_ATTEMPTS);
  const aB = armMotionProbe(bB.state, 'B', 2);
  // A 的结果回来了（带句柄）→ 必须过期，且**不得**动 B 的在途标记。
  const st = settleMotionProbe(aB.state, aA.ticket, 'B', 2, readyVerdict());
  assert.equal(st.outcome, 'stale');
  assertState(st.state, '', 'B', 1, 'A 的过期结果结算之后');
  assert.equal(isMotionInFlight(st.state, 'B'), true, '过期结果把 B 的在途标记清掉了');
  assert.equal(isMotionConcluded(st.state, 'A'), false, '过期结果写了结论');
});

// ── 6. 过期结果：三条判据各单独生效，且一律"状态一字不动" ─────────────────────

test('【过期①：序号】同一张卡换走又滑回来（id 相同）时，只有 seq 能分辨新旧 —— 旧结果必须被丢弃', () => {
  // 场景：A 的探测在途（seq=1）→ 用户滑走再滑回 A（resetMotion 会 motionSeq+1）→
  // 重新为 A 起一次探测（seq=2）→ 此时**第一次**的结果才回来。
  // 判据②（inFlightId === 'A' 成立）与判据③（currentId === 'A' 成立）**都为假**（都为真=不算过期），
  // 只有判据①（seq 1 !== 2）能救 —— 这条专门钉住"seq 判据不能删"。
  const b1 = beginMotionProbe(newMotionProbeState(), 'A', MOTION_PROBE_MAX_ATTEMPTS);
  const a1 = armMotionProbe(b1.state, 'A', 1);
  // 换走（reset）再滑回：状态回到初始，但 seq 已经走到 2。
  const b2 = beginMotionProbe(newMotionProbeState(), 'A', MOTION_PROBE_MAX_ATTEMPTS);
  const a2 = armMotionProbe(b2.state, 'A', 2);
  assert.equal(a2.state.inFlightId, 'A', '前提：新那次探测确实在途');
  assert.equal(a2.state.concludedId, '', '前提：新那次探测还没有结论');
  // 旧结果（带**负结论**）回来 —— 若被接受，就会把 A 写死成"确定不是动态照片"。
  const st = settleMotionProbe(a2.state, a1.ticket, 'A', 2, negativeVerdict());
  assert.equal(st.outcome, 'stale', '旧序号的结果被当成了当前结果');
  assertState(st.state, '', 'A', 1, '过期① 之后');
  assert.equal(st.state.inFlightId, 'A', '过期结果把新那次探测的在途标记清掉了');
});

test('【过期②：在途】在途标记已被解除（如 .catch 先到）时，迟到的结果一律丢弃', () => {
  const id = 'A';
  const b1 = beginMotionProbe(newMotionProbeState(), id, MOTION_PROBE_MAX_ATTEMPTS);
  const a1 = armMotionProbe(b1.state, id, 1);
  // 先来一次 rejection（.catch）→ 在途标记解除，但 seq 没有变（没有新探测）。
  const afterCatch = settleMotionProbe(a1.state, a1.ticket, id, 1, missedVerdict()).state;
  assert.equal(afterCatch.inFlightId, '');
  // 随后那条"迟到的"成功结果回来了（同一个 seq、同一个 id）—— 在途标记已空 → 过期。
  const st = settleMotionProbe(afterCatch, a1.ticket, id, 1, readyVerdict());
  assert.equal(st.outcome, 'stale', '结果对应的探测已经不是"当前在途"的那次，却仍被接受');
  assertState(st.state, '', '', 1, '过期② 之后');
});

test('【过期③：换卡】旧卡的结果回来时当前卡已换走 —— 丢弃，且**不误写结论**', () => {
  const bA = beginMotionProbe(newMotionProbeState(), 'A', MOTION_PROBE_MAX_ATTEMPTS);
  const aA = armMotionProbe(bA.state, 'A', 1);
  // 换到 B：状态被重置，currentId 变成 B，seq 递增到 2，并起了 B 的第一次探测。
  const bB = beginMotionProbe(newMotionProbeState(), 'B', MOTION_PROBE_MAX_ATTEMPTS);
  const aB = armMotionProbe(bB.state, 'B', 2);
  const before: MotionProbeState = aB.state;
  // A 的结果（带句柄）回来：调用点必须据此**当场放手**那个句柄，且状态一字不动。
  const st = settleMotionProbe(before, aA.ticket, 'B', 2, readyVerdict());
  assert.equal(st.outcome, 'stale');
  assertState(st.state, before.concludedId, before.inFlightId, before.tries, '过期③ 之后');
  assert.equal(isMotionConcluded(st.state, 'A'), false, '旧卡的结果写进了结论');
  assert.equal(isMotionConcluded(st.state, 'B'), false, '旧卡的结果写脏了新卡');
});

test('【过期结果不误释放】非过期的结果必须被**接受**（否则到手的句柄会被无谓丢弃）', () => {
  // 反方向：三条判据全部不成立时，结果一定要被接受 —— 句柄该被接管，而不是被"当过期放手"。
  const b = beginMotionProbe(newMotionProbeState(), 'A', MOTION_PROBE_MAX_ATTEMPTS);
  const a = armMotionProbe(b.state, 'A', 7);
  const st = settleMotionProbe(a.state, a.ticket, 'A', 7, readyVerdict());
  assert.notEqual(st.outcome, 'stale', '当前在途的结果被误判过期 —— 句柄会被当场释放，角标永远不亮');
  assert.equal(st.outcome, 'ready');
  assert.equal(isMotionConcluded(st.state, 'A'), true);
});

test('【最关键的一条】过期判据读的是**在途**字段，不是"已下结论"字段', () => {
  // fix-batch-37 的关键推理：第三个条件（旧实现读的是"已下结论"那个字段 → 当时的 motionForId）
  // 必须换成 inFlightId。若换回去，就会出现这个死法：
  //   一次**成功的重试**在 settle 里先写下"已结论"，同一个 settle 之后再读"已下结论"字段，
  //   就会认为"这条结果对应的探测已经不是当前那次" → 结果被误判过期 → **到手的句柄被当场释放**。
  // 用一条确定性的断言把这个行为钉住：**同一次 settle 内，写完结论之后仍然算"当前那次"**。
  const id = 'A';
  // 先耗尽一部分预算，模拟"重试之后才成功"。
  let s = probeOnce(newMotionProbeState(), id, 1, MOTION_PROBE_MAX_ATTEMPTS, missedVerdict());
  s = probeOnce(s, id, 2, MOTION_PROBE_MAX_ATTEMPTS, missedVerdict());
  assert.equal(motionAttempts(s), 2);
  // 第 3 次（最后一次预算）成功。
  const b3 = beginMotionProbe(s, id, MOTION_PROBE_MAX_ATTEMPTS);
  assert.equal(b3.allowed, true);
  const a3 = armMotionProbe(b3.state, id, 3);
  const st = settleMotionProbe(a3.state, a3.ticket, id, 3, readyVerdict());
  assert.equal(st.outcome, 'ready', '成功重试的结果被误判 —— 句柄会被当场释放（这正是要防的死法）');
  // 写结论之后的**状态**里，inFlightId 已经是 ''，而 concludedId 是这张 ——
  // 用"已下结论"当过期判据的实现会在这里把 st.outcome 变成 'stale'（见报告 §5 的变异 M3）。
  assertState(st.state, id, '', 3, '第 3 次成功之后');
  assert.equal(isMotionConcluded(st.state, id), true);
});

// ── 7. 上界用尽之后，结果照样可以被接受（"用满预算"≠"永远不可能成功"）─────────

test('【上界到达后 motionReady 仍可为真】第 N 次（最后一次）探测成功时结果照样被接受', () => {
  const id = 'A';
  const max = MOTION_PROBE_MAX_ATTEMPTS;
  let s = newMotionProbeState();
  // 前两次瞬时失败。
  s = probeOnce(s, id, 1, max, missedVerdict());
  s = probeOnce(s, id, 2, max, missedVerdict());
  // 第三次：闸门仍然允许（预算正好还剩 1），并且**成功**。
  const b3 = beginMotionProbe(s, id, max);
  assert.equal(b3.allowed, true, '最后一次预算不可用 —— 上界算错了一格');
  assert.equal(b3.state.tries, max, '第 N 次的序号不是 N');
  const a3 = armMotionProbe(b3.state, id, 3);
  const st = settleMotionProbe(a3.state, a3.ticket, id, 3, readyVerdict());
  assert.equal(st.outcome, 'ready', '预算用尽的状态让成功结果失效了');
  assert.equal(isMotionConcluded(st.state, id), true, 'motionReady 的依据（已下结论）没有为真');
  assert.equal(motionAttemptsLeft(st.state, max), 0, '前提：预算确确实实已经用尽');
  // 而且此后不再探测（结论已定）。
  assert.equal(beginMotionProbe(st.state, id, max).deny, 'concluded');
});

test('上界**只挡 begin，从不挡 settle**：预算已满时把最后一条结果交上来照样生效', () => {
  const id = 'A';
  const max = 1;
  const b1 = beginMotionProbe(newMotionProbeState(), id, max);
  const a1 = armMotionProbe(b1.state, id, 1);
  // 此刻 tries 已经 == max（预算用尽），但这次探测的结果还没回来。
  assert.equal(motionAttemptsLeft(a1.state, max), 0);
  const st = settleMotionProbe(a1.state, a1.ticket, id, 1, negativeVerdict());
  assert.equal(st.outcome, 'negative', '预算用尽让在途结果无法结算 —— 这张卡会永远停在"在途"');
  assert.equal(isMotionConcluded(st.state, id), true);
});

// ── 8. hasHandle 优先于 concluded（与 CardStack 的 `if (h === undefined)` 同款）──

test('对象到手就是正结论：hasHandle=true 时不再看 concluded（与调用点逐字同款）', () => {
  const id = 'A';
  const b = beginMotionProbe(newMotionProbeState(), id, MOTION_PROBE_MAX_ATTEMPTS);
  const a = armMotionProbe(b.state, id, 1);
  // 这种组合 data 层不会给出（probeReady 恒 concluded=true），但判据顺序必须与调用点一致：
  // 调用点先判 `handle === undefined`，所以"有对象"这一支永远走正结论。
  const contradictory: MotionProbeVerdict = { concluded: false, hasHandle: true };
  const st = settleMotionProbe(a.state, a.ticket, id, 1, contradictory);
  assert.equal(st.outcome, 'ready');
  assert.equal(isMotionConcluded(st.state, id), true);
});

// ── 9. 查询函数的边界 ───────────────────────────────────────────────────────

test('查询边界：空 id 恒为「没有结论 / 没有在途」（空串不是一张卡）', () => {
  const s = newMotionProbeState();
  assert.equal(isMotionConcluded(s, ''), false, '空串被当成了「已下结论的卡」');
  assert.equal(isMotionInFlight(s, ''), false, '空串被当成了「在途的卡」');
  // 即使状态里真的存了空串（初始态就是这样），也不得把"空"判成一张卡。
  assert.equal(isMotionConcluded({ concludedId: '', inFlightId: '', tries: 0 }, ''), false);
});

test('查询边界：motionAttemptsLeft 饱和在 0（上界被调小时不会返回负数）', () => {
  const s = newMotionProbeState();
  assert.equal(motionAttemptsLeft(s, 0), 0);
  assert.equal(motionAttemptsLeft({ concludedId: '', inFlightId: '', tries: 3 }, 1), 0);
  assert.equal(motionAttemptsLeft({ concludedId: '', inFlightId: '', tries: 3 }, 3), 0);
  assert.equal(motionAttemptsLeft({ concludedId: '', inFlightId: '', tries: 3 }, 5), 2);
});

test('查询函数不区分结论的正负：正负都算"已下结论"（角标与长按闸门只看这一位）', () => {
  // 注意：角标与长按真正读的是 CardStack 的 motionReady（= 拿到句柄），本函数表达的是
  // "这张探明白了、不用再探"。两者刻意不同：negatively-concluded 的卡也不会再被探测。
  const neg = probeOnce(newMotionProbeState(), 'A', 1, MOTION_PROBE_MAX_ATTEMPTS, negativeVerdict());
  const pos = probeOnce(newMotionProbeState(), 'A', 1, MOTION_PROBE_MAX_ATTEMPTS, readyVerdict());
  assert.equal(isMotionConcluded(neg, 'A'), true);
  assert.equal(isMotionConcluded(pos, 'A'), true);
});

// ── 10. 不变式：把所有迁移走一遍，沿途每一站都必须成立 ────────────────────────

test('不变式：任何可达状态都满足"结论与在途不可能同时指着同一张卡"', () => {
  const id = 'A';
  const max = MOTION_PROBE_MAX_ATTEMPTS;
  const seen: MotionProbeState[] = [];
  const check = (s: MotionProbeState, where: string): void => {
    seen.push(s);
    // 不变量 1：inFlightId 非空 ⟹ 它绝不是"已下结论"的那张。
    //   （arm 会清 concludedId；settle 写结论时会清 inFlightId —— 两者不可能同时指着同一张。）
    assert.equal(s.concludedId === '' || s.concludedId !== s.inFlightId, true,
      `${where}：结论与在途同时指着 ${s.concludedId}`);
    // 不变量 2：在途非空 ⟹ 同 id 的 begin 必须被拒（闸③ 的语义）。
    if (s.inFlightId !== '') {
      assert.equal(beginMotionProbe(s, s.inFlightId, max).deny, 'in-flight', `${where}：在途未被闸③ 拦住`);
    }
    // 不变量 3：tries 在 [0, max] 内（begin 从不越界记账）。
    assert.equal(s.tries >= 0 && s.tries <= max, true, `${where}：tries=${s.tries} 越界`);
  };

  let s = newMotionProbeState();
  check(s, '初始');
  const b1 = beginMotionProbe(s, id, max); check(b1.state, 'begin#1'); s = b1.state;
  const a1 = armMotionProbe(s, id, 1);     check(a1.state, 'arm#1');   s = a1.state;
  s = settleMotionProbe(s, a1.ticket, id, 1, missedVerdict()).state;   check(s, 'settle missed');
  const b2 = beginMotionProbe(s, id, max); check(b2.state, 'begin#2'); s = b2.state;
  const a2 = armMotionProbe(s, id, 2);     check(a2.state, 'arm#2');   s = a2.state;
  s = settleMotionProbe(s, a2.ticket, id, 2, negativeVerdict()).state; check(s, 'settle negative');
  const b3 = beginMotionProbe(s, id, max); check(b3.state, 'begin#3（应被 concluded 拒）');
  assert.equal(b3.deny, 'concluded');
  s = newMotionProbeState();               check(s, '换卡重置');
  const b4 = beginMotionProbe(s, id, max); check(b4.state, 'begin#4'); s = b4.state;
  const a4 = armMotionProbe(s, id, 4);     check(a4.state, 'arm#4');   s = a4.state;
  s = settleMotionProbe(s, a4.ticket, id, 4, readyVerdict()).state;    check(s, 'settle ready');
  s = settleMotionProbe(s, a4.ticket, id, 4, readyVerdict()).state;    check(s, '同一条结果再来一次（应过期）');

  assert.equal(seen.length, 13, '走过的站点数变了 —— 说明这条不变式扫描的范围被改动了');
});
