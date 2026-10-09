import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleSession, isSessionDone, currentPhotoId, advance,
  DEFAULT_SESSION_SIZE, SESSION_SIZE_CHOICES
} from './session.ts';

// 造 id 数组的小工具（测试里不写魔法长数组）
const ids = (prefix: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) { out.push(`${prefix}${i}`); }
  return out;
};

const sorted = (a: string[]): string[] => a.slice().sort();

// ── 1. 确定性 ────────────────────────────────────────────────────────────────

test('同一入参 + 同种子两次抽样结果完全相同（默认 100 张，选项 20/50/100/200）', () => {
  const pool = ids('p', 200);
  const seen = ids('p', 50);            // 前 50 张历史会话里见过
  const a = sampleSession(pool, DEFAULT_SESSION_SIZE, seen, [], 20261008);
  const b = sampleSession(pool, DEFAULT_SESSION_SIZE, seen, [], 20261008);
  assert.deepEqual(a, b, '同种子必须给出同一队列，否则测试不可复现');
  assert.notEqual(a, b, '两次调用必须各自独立，不能返回同一个对象');
  assert.notEqual(a.queue, b.queue, '不能共享 queue 数组');
  assert.equal(a.queue.length, 100);
  // 产品口径：默认 100，可选 20/50/100/200（默认值必须是选项之一）
  assert.equal(DEFAULT_SESSION_SIZE, 100);
  assert.deepEqual(SESSION_SIZE_CHOICES, [20, 50, 100, 200]);
  assert.ok(SESSION_SIZE_CHOICES.indexOf(DEFAULT_SESSION_SIZE) >= 0);
});

// ── 2. 放回语义：已决策照片仍在抽中范围内 ──────────────────────────────────────

test('放回抽样：全池照片都已决策（已归档/已收藏/已上墙）时仍会被再次抽中', () => {
  // 产品原话要的就是这个：上一会话归档/收藏过的照片，本会话还能被抽中再次出现。
  const pool = ['archived-1', 'archived-2', 'faved-1', 'walled-1', 'archived-3'];
  const seen = pool.slice();            // 全部在历史会话里展示过（且已被决策）
  const all = sampleSession(pool, 5, seen, [], 7);
  assert.equal(all.queue.length, 5, '已决策照片不得被排除出抽样范围');
  assert.deepEqual(sorted(all.queue), sorted(pool));
  const some = sampleSession(pool, 2, seen, [], 7);
  assert.equal(some.queue.length, 2, '池子有货就必须抽满，不得因为"都见过"而返回空会话');
});

// ── 3. 同一会话内不重复 ─────────────────────────────────────────────────────

test('同一会话内不重复（size <= pool.length）', () => {
  const pool = ids('p', 30);
  const s = sampleSession(pool, 30, [], [], 42);
  assert.equal(s.queue.length, 30);
  assert.equal(new Set(s.queue).size, 30, '同一张照片在一次会话里只能出现一次');
  assert.deepEqual(sorted(s.queue), sorted(pool), '队列内容必须是池子的一个排列');
});

// ── 4/5. 优先级：未见过的优先 ────────────────────────────────────────────────

test('未见过的照片优先：池 10 张、其中 3 张未见过、抽 3 张 → 恰好是那 3 张', () => {
  const fresh = ['new-1', 'new-2', 'new-3'];
  const known = ids('old', 7);
  const pool = known.concat(fresh);
  const s = sampleSession(pool, 3, known, [], 12345);
  assert.deepEqual(sorted(s.queue), ['new-1', 'new-2', 'new-3']);
});

test('未见过的照片优先：新照片排满后才用已见过的补足，且补足的排在新照片之后', () => {
  const fresh = ['new-1', 'new-2', 'new-3'];
  const known = ids('old', 7);
  const pool = known.concat(fresh);
  const s = sampleSession(pool, 5, known, [], 999);
  assert.equal(s.queue.length, 5);
  assert.deepEqual(sorted(s.queue.slice(0, 3)), ['new-1', 'new-2', 'new-3'],
    '队首 3 张必须全是未见过的');
  const tail = s.queue.slice(3);
  for (let i = 0; i < tail.length; i++) {
    assert.ok(known.indexOf(tail[i]) >= 0, '补足位只能来自已见过的照片');
  }
  assert.equal(new Set(s.queue).size, 5, '补足后仍不得重复');
});

// ── 5'. 抽不满 ──────────────────────────────────────────────────────────────

test('size > pool.length 时抽全部（队列长度 = 去重后的池子大小）', () => {
  const pool = ['a', 'b', 'c'];
  const s = sampleSession(pool, 100, [], [], 5);
  assert.equal(s.queue.length, 3);
  assert.deepEqual(sorted(s.queue), ['a', 'b', 'c']);
  assert.equal(s.size, 100, 'size 保留请求值（实际张数以 queue.length 为准）');
  assert.equal(s.cursor, 0);
});

// ── 6. 边界 ─────────────────────────────────────────────────────────────────

test('size <= 0（含 NaN）返回空会话', () => {
  assert.deepEqual(sampleSession(['a', 'b'], 0, [], [], 1), { size: 0, queue: [], cursor: 0 });
  assert.deepEqual(sampleSession(['a', 'b'], -5, [], [], 1), { size: 0, queue: [], cursor: 0 });
  assert.deepEqual(sampleSession(['a', 'b'], NaN, [], [], 1), { size: 0, queue: [], cursor: 0 });
});

test('pool 为空时返回空队列并保留请求的 size（便于 UI 显示"池子空了"）', () => {
  const s = sampleSession([], 100, ['a'], [], 1);
  assert.equal(s.size, 100);
  assert.deepEqual(s.queue, []);
  assert.equal(s.cursor, 0);
  assert.equal(isSessionDone(s), true);
  assert.equal(currentPhotoId(s), '');
});

test('pool 内有重复 photoId 时先去重再抽（不把重复当两张）', () => {
  const pool = ['a', 'b', 'a', 'c', 'b', 'a'];
  const s = sampleSession(pool, 10, [], [], 3);
  assert.equal(s.queue.length, 3, '去重后池子只有 3 张');
  assert.deepEqual(sorted(s.queue), ['a', 'b', 'c']);
  const exact = sampleSession(pool, 3, [], [], 3);
  assert.equal(new Set(exact.queue).size, 3);
  assert.deepEqual(sorted(exact.queue), ['a', 'b', 'c']);
});

// ── 7. advance / currentPhotoId / isSessionDone ──────────────────────────────

test('按队列顺序前进，刷完前 isSessionDone 一直为 false', () => {
  const s0 = sampleSession(['a', 'b', 'c'], 3, [], [], 77);
  assert.equal(s0.cursor, 0);
  assert.equal(isSessionDone(s0), false);
  assert.equal(currentPhotoId(s0), s0.queue[0]);
  const s1 = advance(s0);
  assert.equal(s1.cursor, 1);
  assert.equal(currentPhotoId(s1), s0.queue[1]);
  assert.equal(isSessionDone(s1), false);
  const s2 = advance(s1);
  assert.equal(currentPhotoId(s2), s0.queue[2]);
  assert.equal(isSessionDone(s2), false, '刷最后一张时还没刷完');
  const s3 = advance(s2);
  assert.equal(s3.cursor, 3);
  assert.equal(isSessionDone(s3), true);
});

test('刷完后 currentPhotoId 返回空串', () => {
  let s = sampleSession(['a'], 1, [], [], 9);
  s = advance(s);
  assert.equal(isSessionDone(s), true);
  assert.equal(currentPhotoId(s), '', '刷完后没有"当前这张"');
});

test('刷完后再 advance 幂等（内容原样，但仍返回新对象）', () => {
  let s = sampleSession(['a', 'b'], 2, [], [], 11);
  s = advance(advance(s));
  assert.equal(isSessionDone(s), true);
  const again = advance(s);
  assert.deepEqual(again, s, '幂等：内容不得变化');
  assert.notEqual(again, s, '仍须返回新对象，不原地改');
  const third = advance(again);
  assert.deepEqual(third, again);
});

// ── 8. 不改入参 / 不共享数组 ─────────────────────────────────────────────────

test('不改入参与原状态：pool/seenIds 原样，advance 返回的新会话不共享 queue', () => {
  const pool = ['a', 'b', 'c', 'a'];
  const seen = ['a'];
  const poolCopy = pool.slice();
  const seenCopy = seen.slice();
  const s = sampleSession(pool, 2, seen, [], 42);
  assert.deepEqual(pool, poolCopy, 'pool 被原地改了');
  assert.deepEqual(seen, seenCopy, 'seenIds 被原地改了');

  const q = s.queue.slice();
  const n = advance(s);
  assert.equal(s.cursor, 0, 'advance 不得改动原会话');
  assert.deepEqual(s.queue, q, 'advance 不得改动原会话的队列');
  n.queue.push('zzz');
  assert.equal(s.queue.length, q.length, 'advance 返回的会话与原会话共享了 queue 数组');
});

// ══ 9. 三层优先级：优先避开上一批（prevQueue）══════════════════════════════════
//
// 这一批用例针对的缺陷：池子大小 ≈ 会话张数时，"没见过的优先"这一层恒为空，
// 抽样退化成"每轮从同一个已见过的集合里抽满"，用户点「继续刷」看到的是**完全相同的一批**。
// 修法 = 在三层里加"见过但不在上一批"这一层。下面的用例全部锁死这条语义。

test('避开上一批：池 10 张全部见过、上一批 = 前 5 张、抽 5 张 → 恰好是另外 5 张', () => {
  const pool = ids('p', 10);
  const prev = pool.slice(0, 5);          // p0..p4 是上一批
  const rest = pool.slice(5);             // p5..p9 只在更早的会话里见过
  // 换 20 个种子都必须落在"另外 5 张"上：避开上一批是**语义**，不是某个种子的巧合
  for (let i = 0; i < 20; i++) {
    const s = sampleSession(pool, 5, pool, prev, 1000 + i);
    assert.equal(s.queue.length, 5);
    assert.equal(new Set(s.queue).size, 5, '同一会话内不得重复');
    assert.deepEqual(sorted(s.queue), sorted(rest),
      `seed=${1000 + i}：本批必须全部来自上一批之外，否则「继续刷」会看到同一批照片`);
    for (let k = 0; k < s.queue.length; k++) {
      assert.equal(prev.indexOf(s.queue[k]), -1, '上一批的照片不得出现在本批');
    }
  }
});

test('层内仍按 seed 打散：分桶不变、种子不同 → 队列顺序不同（不是固定顺序）', () => {
  const pool = ids('p', 10);
  const prev = pool.slice(0, 5);
  const seqs: string[] = [];
  for (let i = 0; i < 12; i++) {
    const s = sampleSession(pool, 5, pool, prev, 2000 + i);
    // 每一轮的分桶完全相同（都是"另外 5 张"），所以这里比的是**层内顺序**
    assert.deepEqual(sorted(s.queue), sorted(pool.slice(5)));
    seqs.push(s.queue.join(','));
  }
  const distinct = new Set(seqs);
  assert.ok(distinct.size >= 3,
    `分了层也必须保留随机性：12 个种子只给出 ${distinct.size} 种顺序，说明层内是固定顺序`);
});

test('池子不够时允许重叠：池 6 张全部见过、上一批 = 其中 4 张、抽 6 张 → 抽满且不重复', () => {
  const pool = ids('p', 6);
  const prev = pool.slice(0, 4);          // p0..p3 是上一批；p4/p5 在上一批之外
  const s = sampleSession(pool, 6, pool, prev, 777);
  assert.equal(s.queue.length, 6, 'size == 池子大小时必须抽满（重叠不可避免，但不能少给）');
  assert.equal(new Set(s.queue).size, 6, '同一会话内仍不得重复');
  assert.deepEqual(sorted(s.queue), sorted(pool), '抽满 = 池子的一个排列');
  // 重叠只发生在"补足"上：上一批之外的那 2 张必须先被用完，且排在队首
  assert.deepEqual(sorted(s.queue.slice(0, 2)), ['p4', 'p5'],
    '上一批之外的照片必须先被用完（它们才是"循环回来"的第一顺位）');
  // 部分重叠：只要 5 张时，缺口 3 张才由上一批的照片补
  const five = sampleSession(pool, 5, pool, prev, 777);
  assert.equal(five.queue.length, 5);
  assert.equal(new Set(five.queue).size, 5);
  assert.deepEqual(sorted(five.queue.slice(0, 2)), ['p4', 'p5']);
  for (let i = 2; i < five.queue.length; i++) {
    assert.ok(prev.indexOf(five.queue[i]) >= 0, '第 3 张起才允许用上一批的照片补足');
  }
});

test('产品场景：池 200 张、每批 100 张 → 连续两批不重叠（能连着看到 200 张不同的）', () => {
  // 这就是产品负责人的裁决要的效果：不是"每次同一批"，而是"循环回来"。
  const pool = ids('p', 200);
  const b1 = sampleSession(pool, 100, [], [], 1001);
  assert.equal(b1.queue.length, 100);
  // 第 1 批刷完：这 100 张全部变成"看过"，并且它就是"上一批"
  const seen = b1.queue.slice();
  const b2 = sampleSession(pool, 100, seen, b1.queue, 1002);
  assert.equal(b2.queue.length, 100);
  assert.equal(new Set(b2.queue).size, 100);
  let overlap = 0;
  for (let i = 0; i < b2.queue.length; i++) {
    if (b1.queue.indexOf(b2.queue[i]) >= 0) { overlap = overlap + 1; }
  }
  assert.equal(overlap, 0, '第 2 批必须避开第 1 批的 100 张，用户才能连着看到 200 张不同的');
  // 第 3 批：前两批都已看过，第 2 批是"上一批" → 它优先抽第 1 批那 100 张（循环回来）
  const seen2 = seen.concat(b2.queue);
  const b3 = sampleSession(pool, 100, seen2, b2.queue, 1003);
  assert.equal(b3.queue.length, 100);
  assert.deepEqual(sorted(b3.queue), sorted(b1.queue),
    '池子耗尽后必须循环回第 1 批（放回抽样：老照片仍然在抽样范围里）');
});

test('确定性不受影响：同一 (pool, size, seenIds, prevQueue, seed) 两次调用完全相同', () => {
  const pool = ids('p', 40);
  const seen = ids('p', 30);
  const prev = ids('p', 20);
  const a = sampleSession(pool, 15, seen, prev, 20261008);
  const b = sampleSession(pool, 15, seen, prev, 20261008);
  assert.deepEqual(a, b, '同入参同种子必须逐位相同（加了 prevQueue 也不例外）');
  assert.notEqual(a, b, '两次调用仍须各自独立');
  assert.notEqual(a.queue, b.queue, '不能共享 queue 数组');
  const c = sampleSession(pool, 15, seen, prev, 20261009);
  assert.notDeepEqual(a.queue, c.queue, '换种子必须换队列（否则"避开上一批"会变成固定顺序）');
});

test('prevQueue 只用于分桶：池外 id / 重复 id 不干扰，且不改任何入参', () => {
  const pool = ids('p', 8);
  const seen = ids('p', 8);
  const prev = ['p0', 'p1', 'p0', 'not-in-pool', 'p2', 'p3'];   // 重复 + 池外 id
  const poolCopy = pool.slice();
  const seenCopy = seen.slice();
  const prevCopy = prev.slice();
  const s = sampleSession(pool, 4, seen, prev, 321);
  assert.deepEqual(pool, poolCopy, 'pool 被原地改了');
  assert.deepEqual(seen, seenCopy, 'seenIds 被原地改了');
  assert.deepEqual(prev, prevCopy, 'prevQueue 被原地改了');
  assert.deepEqual(sorted(s.queue), ['p4', 'p5', 'p6', 'p7'],
    '上一批之外的 4 张必须先被用完；池外 id 与重复 id 都不得改变分桶');
  // 放回语义不因分层而丢失：prevQueue 传空时全池 8 张仍然都在抽样范围里
  const all = sampleSession(pool, 8, seen, [], 321);
  assert.equal(all.queue.length, 8);
  assert.deepEqual(sorted(all.queue), sorted(pool));
});

// ── 10. 向后兼容：prevQueue 为空 == 旧的两层行为 ───────────────────────────────
//
// 旧行为如何确立：下面的 legacySampleSession 是 6163d7e（fix 之前那个 commit）里
// sampleSession 的**逐字转写**——同样的 xorshift32、同样的部分 Fisher-Yates、
// 同样的分桶遍历顺序与 pickRandom 调用顺序。这里对它做差分对照，
// 逐位（含队列顺序）证明 prevQueue=[] 时新实现没有改变任何既有行为。
// 除本用例外，上面 13 个既有用例全部改传 []，它们的期望值**原样保留**，
// 同时也充当"旧行为未被改变"的功能回归。
const LEGACY_FALLBACK_SEED = 0x9e3779b9;

function legacyRng(seed: number): () => number {
  let s = (Math.floor(seed) | 0) >>> 0;
  if (s === 0) { s = LEGACY_FALLBACK_SEED; }
  return () => {
    let x = s;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    s = x;
    return x;
  };
}

function legacyBelow(rnd: () => number, n: number): number {
  return Math.floor((rnd() / 4294967296) * n);
}

function legacyPick(items: string[], k: number, rnd: () => number): string[] {
  const arr = items.slice();
  const out: string[] = [];
  const n = Math.min(k, arr.length);
  for (let i = 0; i < n; i++) {
    const j = i + legacyBelow(rnd, arr.length - i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
    out.push(arr[i]);
  }
  return out;
}

function legacyDedupe(pool: string[]): string[] {
  const seen: Set<string> = new Set();
  const out: string[] = [];
  for (let i = 0; i < pool.length; i++) {
    const id = pool[i];
    if (seen.has(id)) { continue; }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 旧签名 sampleSession(pool, size, seenIds, seed)：只有"没见过 / 见过"两层 */
function legacySampleSession(pool: string[], size: number, seenIds: string[], seed: number) {
  if (!(size > 0)) { return { size: 0, queue: [], cursor: 0 }; }
  const uniq = legacyDedupe(pool);
  if (uniq.length === 0) { return { size: size, queue: [], cursor: 0 }; }
  const seen: Set<string> = new Set();
  for (let i = 0; i < seenIds.length; i++) { seen.add(seenIds[i]); }
  const fresh: string[] = [];
  const known: string[] = [];
  for (let i = 0; i < uniq.length; i++) {
    const id = uniq[i];
    if (seen.has(id)) { known.push(id); } else { fresh.push(id); }
  }
  const want = Math.min(Math.floor(size), uniq.length);
  const rnd = legacyRng(seed);
  const fromFresh = legacyPick(fresh, want, rnd);
  const queue = fromFresh.concat(legacyPick(known, want - fromFresh.length, rnd));
  return { size: size, queue: queue, cursor: 0 };
}

test('prevQueue 为空 == 旧行为：与 6163d7e 的两层实现在多组入参下逐位一致', () => {
  const pools: string[][] = [
    ids('p', 200), ids('p', 30), ids('p', 10), ids('p', 6),
    ['a', 'b', 'a', 'c', 'b', 'a'], [], ['only']
  ];
  const seens: string[][] = [[], ids('p', 5), ids('p', 50), ids('p', 10), ['a'], ['not-in-pool']];
  const sizes: number[] = [0, -3, NaN, 1, 3, 10, 30, 100, 200, 2.5];
  const seeds: number[] = [0, 1, 42, 999, 20261008, -7];
  let compared = 0;
  for (let pi = 0; pi < pools.length; pi++) {
    for (let si = 0; si < seens.length; si++) {
      for (let zi = 0; zi < sizes.length; zi++) {
        for (let di = 0; di < seeds.length; di++) {
          const pool = pools[pi];
          const seen = seens[si];
          const size = sizes[zi];
          const seed = seeds[di];
          const next = sampleSession(pool, size, seen, [], seed);
          const old = legacySampleSession(pool, size, seen, seed);
          assert.deepEqual(next, old,
            `prevQueue=[] 的行为被改变了：pool=${pool.length} seen=${seen.length} size=${size} seed=${seed}`);
          compared = compared + 1;
        }
      }
    }
  }
  assert.equal(compared, 7 * 6 * 10 * 6, '差分对照的样本数必须与配置组数一致');
});

test('prevQueue 里的 id 全在池外时，与传空数组逐位一致（分桶结果相同）', () => {
  const pool = ids('p', 20);
  const seen = ids('p', 12);
  const seeds: number[] = [3, 77, 20261008];
  for (let i = 0; i < seeds.length; i++) {
    const withEmpty = sampleSession(pool, 10, seen, [], seeds[i]);
    const withForeign = sampleSession(pool, 10, seen, ['ghost-1', 'ghost-2'], seeds[i]);
    assert.deepEqual(withForeign, withEmpty,
      '池外的 prevQueue 条目不该影响分桶：它们既不在 fresh/rest 里，也不在 last 里');
  }
});
