// Node 单测：core/atomicText.ts 的纯逻辑 + 用**内存假文件系统**替换平台层跑完整原子写流程。
//
// 为什么这层能测：core/atomicText.ts 不 import @kit.*，平台动作全部经 AtomicWritePort 注入。
// 这里注入的假端口可以精确制造真机上极难复现的场景（短写 1 字节、ENOSPC、close 失败、
// rename 失败、返回值 NaN），并如实记录 open/close/rename 的调用次数与顺序 ——
// 于是「短写必被检出」「失败时真身一个字节都没动」「每条异常路径都关 fd」都有输出可查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWrite,
  describeWriteFailure,
  tmpPathOf,
  utf8ByteLength,
  writeTextAtomicWithPort
} from './atomicText.ts';
// AtomicWritePort 是**接口**（类型），运行时不存在 —— 必须用 import type，
// 否则 ESM 会在实例化阶段报 "does not provide an export named"。
import type { AtomicWritePort } from './atomicText.ts';

// ── 内存假文件系统端口 ────────────────────────────────────────────────────────
// 存 Buffer（不是 string）：短写的本质是"盘上只有前 n 个**字节**"，用字符串存会掩盖这个事实。
interface FakeFs {
  port: AtomicWritePort;
  files: Map<string, Buffer>;
  textOf: (p: string) => string;
  has: (p: string) => boolean;
  openCount: number;
  closeCount: number;
  renameAttempts: number;
  renameSuccess: number;
  events: string[];
  mode: string;     // 注入的写入行为，见下面 switch 的注释
  shortBy: number;  // mode === 'short' 时少写几字节
}

function makeFakeFs(mode: string, shortBy: number): FakeFs {
  const files: Map<string, Buffer> = new Map();
  const fds: Map<number, string> = new Map();
  const events: string[] = [];
  const self: FakeFs = {
    port: {
      openTrunc(tmpPath: string): number {
        events.push('open');
        if (mode === 'throwOpen') { throw new Error('13900001 Operation not permitted'); }
        self.openCount = self.openCount + 1;
        const fd: number = self.openCount;   // fd 从 1 起（-1 留给"尚未打开"，与真实实现一致）
        fds.set(fd, tmpPath);
        files.set(tmpPath, Buffer.alloc(0));   // TRUNC 打开 = 内容立刻清空（这一点很重要，见最后一条用例）
        return fd;
      },
      write(fd: number, text: string): number {
        events.push('write');
        if (mode === 'throwWrite') { throw new Error('13900025 No space left on device'); }
        const p = fds.get(fd);
        if (p === undefined) { throw new Error('13900008 Bad file descriptor'); }
        const buf: Buffer = Buffer.from(text, 'utf8');
        const total: number = buf.length;
        let n: number = total;
        if (mode === 'short') { n = total - shortBy > 0 ? total - shortBy : 0; }
        files.set(p, buf.subarray(0, n));    // **真的**只落 n 个字节
        if (mode === 'over') { return total + 1; }          // 返回一个不该出现的偏大值
        if (mode === 'returnNaN') { return Number.NaN; }
        if (mode === 'returnNeg') { return -1; }
        return n;
      },
      close(fd: number): void {
        events.push('close');
        self.closeCount = self.closeCount + 1;
        fds.delete(fd);
        if (mode === 'throwClose') { throw new Error('closeSync 模拟失败'); }
      },
      rename(tmpPath: string, finalPath: string): void {
        events.push('rename');
        self.renameAttempts = self.renameAttempts + 1;
        if (mode === 'throwRename') { throw new Error('13900005 I/O error'); }
        const cur = files.get(tmpPath);
        if (cur === undefined) { throw new Error('ENOENT: 没有 .tmp'); }
        files.set(finalPath, cur);
        files.delete(tmpPath);
        self.renameSuccess = self.renameSuccess + 1;
      }
    },
    files: files,
    textOf: (p: string): string => {
      const b = files.get(p);
      return b === undefined ? '<不存在>' : b.toString('utf-8');
    },
    has: (p: string): boolean => files.has(p),
    openCount: 0,
    closeCount: 0,
    renameAttempts: 0,
    renameSuccess: 0,
    events: events,
    mode: mode,
    shortBy: shortBy
  };
  return self;
}

const REAL = '/data/claimed_photos.json';
const TMP = tmpPathOf(REAL);   // '/data/claimed_photos.json.tmp'

// 一份"用户不可再生的数据"：239 张逐张授权来的 URI（这里用 3 条 + 一个真实形状的 batchId）
const GOOD = JSON.stringify({
  photos: [
    { photoId: 'file://media/Photo/1/IMG_20240101_120000.jpg', batchId: 3, claimedAt: 1700000000000, takenAt: 0 },
    { photoId: 'file://media/Photo/2/IMG_20240102_130000.jpg', batchId: 3, claimedAt: 1700000000000, takenAt: 0 },
    { photoId: 'file://media/Photo/3/老家的院子.jpg', batchId: 3, claimedAt: 1700000000000, takenAt: 0 }
  ],
  lastBatchId: 3
});
const NEW = JSON.stringify({
  photos: [
    { photoId: 'file://media/Photo/1/IMG_20240101_120000.jpg', batchId: 3, claimedAt: 1700000000000, takenAt: 0 },
    { photoId: 'file://media/Photo/9/新加的一张😀.jpg', batchId: 4, claimedAt: 1700000009999, takenAt: 0 }
  ],
  lastBatchId: 4
});

function seeded(mode: string, shortBy: number): FakeFs {
  const fs: FakeFs = makeFakeFs(mode, shortBy);
  fs.files.set(REAL, Buffer.from(GOOD, 'utf8'));   // 盘上先有一份**好**文件
  return fs;
}

// ── 1. 纯函数：UTF-8 字节数 ──────────────────────────────────────────────────

test('utf8ByteLength：ASCII 按 1 字节', () => {
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength(''), 0);
});

test('utf8ByteLength：中文按 3 字节（不是 1 个字符算 1）', () => {
  assert.equal(utf8ByteLength('照片'), 6);
  assert.equal('照片'.length, 2);
  assert.notEqual(utf8ByteLength('照片'), '照片'.length);
});

test('utf8ByteLength：emoji（代理对）按 4 字节', () => {
  assert.equal(utf8ByteLength('😀'), 4);
  assert.equal('😀'.length, 2);          // 一个 emoji 是两个 UTF-16 码元
  assert.notEqual(utf8ByteLength('😀'), '😀'.length);
});

test('utf8ByteLength 与平台的 UTF-8 编码器（Buffer.byteLength）逐串相等 —— 含落单代理', () => {
  const cases: string[] = [
    '', 'abc', '照片', '😀', 'a照😀b', 'file://media/Photo/3/老家的院子.jpg',
    '\uD800', '\uDC00', 'a\uD800b', '\uD800\uDC00',            // 落单代理（替换成 U+FFFD = 3 字节）
    JSON.stringify([{ photoId: '媒体😀.jpg' }]),                // 生产路径真实形态
    '\\uD800'                                                   // JSON.stringify 转义后的落单代理（ASCII）
  ];
  for (let i = 0; i < cases.length; i++) {
    assert.equal(utf8ByteLength(cases[i]), Buffer.byteLength(cases[i], 'utf8'), `第 ${i} 个串: ${cases[i]}`);
  }
});

// ── 2. 判别性用例：为什么必须按【字节数】而不是 text.length ────────────────────

test('非 ASCII：用字符数当 want 会**放行**一个被截断的坏文件（这就是缺陷本身）', () => {
  const text: string = JSON.stringify([
    { photoId: 'file://媒体/照片😀.jpg', batchId: 1, claimedAt: 0, takenAt: 0 }
  ]);
  const bytes: number = utf8ByteLength(text);   // 正确口径
  const chars: number = text.length;            // 错误口径（本缺陷族里最容易被写成这样）
  assert.ok(bytes > chars, `字节数(${bytes}) 必须大于字符数(${chars})`);

  // 正确口径：写全 → 放行；少 1 字节 → 检出短写
  assert.equal(classifyWrite(bytes, bytes), 'ok');
  assert.equal(classifyWrite(bytes, bytes - 1), 'short');

  // 错误口径的致命后果：一个**正好被截断在 chars 字节**的文件会被判成"写全了"而放行 rename
  assert.equal(classifyWrite(chars, chars), 'ok');
  // 错误口径的次生后果：正常写入（bytes 字节）反而被永远拒绝 → 非 ASCII 的文件永远存不下去
  assert.equal(classifyWrite(chars, bytes), 'over');
  // 错误口径还漏掉"只写了 1 字节"这种最短的短写
  assert.equal(classifyWrite(chars, 1), 'short');
});

test('classifyWrite：完全相等才算成功，写多/返回值非法都不放行', () => {
  assert.equal(classifyWrite(100, 100), 'ok');
  assert.equal(classifyWrite(100, 99), 'short');
  assert.equal(classifyWrite(100, 101), 'over');
  assert.equal(classifyWrite(100, Number.NaN), 'invalid');
  assert.equal(classifyWrite(100, -1), 'invalid');
  assert.equal(classifyWrite(Number.NaN, 100), 'invalid');
  assert.equal(classifyWrite(-5, -5), 'invalid');
  // 空文本是合法输入：want=0 / got=0 放行，got 非 0 则拒绝
  assert.equal(classifyWrite(0, 0), 'ok');
  assert.equal(classifyWrite(0, 1), 'over');
});

test('describeWriteFailure：三种失败各有可读原因，且带上 want/got 两个数字', () => {
  assert.match(describeWriteFailure('short', 4096, 4000), /短写/);
  assert.match(describeWriteFailure('short', 4096, 4000), /4096/);
  assert.match(describeWriteFailure('short', 4096, 4000), /4000/);
  assert.match(describeWriteFailure('over', 10, 11), /超出/);
  assert.match(describeWriteFailure('invalid', 10, -1), /非法/);
  assert.equal(describeWriteFailure('ok', 10, 10), '');
});

test('tmpPathOf：唯一的 .tmp 命名约定', () => {
  assert.equal(tmpPathOf('/data/claimed_photos.json'), '/data/claimed_photos.json.tmp');
  assert.equal(tmpPathOf('/data/decisions.json'), '/data/decisions.json.tmp');
});

// ── 3. 完整流程（内存文件系统）：正常路径 ────────────────────────────────────

test('正常路径：字节数相等才 rename，真身被换成新内容，且 close 在 rename 之前', () => {
  const fs: FakeFs = seeded('full', 0);
  const r = writeTextAtomicWithPort(fs.port, TMP, REAL, NEW);
  assert.equal(r.ok, true);
  assert.equal(r.renamed, true);
  assert.equal(r.want, Buffer.byteLength(NEW, 'utf8'));
  assert.equal(r.got, r.want);
  assert.equal(fs.textOf(REAL), NEW);
  assert.equal(fs.has(TMP), false);                    // .tmp 已被 rename 走
  assert.deepEqual(fs.events, ['open', 'write', 'close', 'rename']);   // close 必须先于 rename
  assert.equal(fs.openCount, 1);
  assert.equal(fs.closeCount, 1);
  assert.equal(fs.renameSuccess, 1);
});

// ── 4. 短写：必须被检出，且**真身一个字节都没动** ────────────────────────────

test('短写 1 字节：被检出、不 rename、真身未被改动（本题最核心的断言）', () => {
  const fs: FakeFs = seeded('short', 1);
  const r = writeTextAtomicWithPort(fs.port, TMP, REAL, NEW);

  // ① 必须让调用方知道失败
  assert.equal(r.ok, false);
  assert.equal(r.detail.indexOf('短写') >= 0, true, `失败原因里必须出现"短写": ${r.detail}`);

  // ② 真身文件未被改动（逐字节比对，不是"看起来还在"）
  const before: Buffer = Buffer.from(GOOD, 'utf8');
  const after = fs.files.get(REAL);
  assert.notEqual(after, undefined);
  assert.equal(Buffer.compare(after as Buffer, before), 0, '真身必须逐字节未变');
  assert.equal(fs.textOf(REAL), GOOD);

  // ③ 没有 rename，且 fd 已关、只关一次
  assert.equal(r.renamed, false);
  assert.equal(fs.renameAttempts, 0);
  assert.equal(fs.openCount, 1);
  assert.equal(fs.closeCount, 1);

  // ④ 短写的 .tmp 确实是一份**解析不了**的坏文件 —— 证明"若不校验就会毁掉真身"
  const tmp = fs.files.get(TMP);
  assert.notEqual(tmp, undefined);
  assert.equal((tmp as Buffer).length, r.want - 1);
  assert.throws(() => { JSON.parse(fs.textOf(TMP)); }, '截断的 .tmp 必须解析失败（否则本缺陷的危害不成立）');

  console.log(`[证据] want=${r.want} got=${r.got} ok=${r.ok} renamed=${r.renamed}`);
  console.log(`[证据] 真身 ${REAL}：短写前后逐字节相同 = ${Buffer.compare(after as Buffer, before) === 0}`);
  console.log(`[证据] 真身内容仍在（前 40 字符）：${fs.textOf(REAL).slice(0, 40)}`);
  console.log(`[证据] 残留 .tmp 字节数 = ${(tmp as Buffer).length}（解析它会抛，若不校验就会被 rename 上去）`);
});

test('短写 0 字节（盘满时 writeSync 返回 0）：同样被检出，真身未动', () => {
  const fs: FakeFs = seeded('short', 100000);
  const r = writeTextAtomicWithPort(fs.port, TMP, REAL, NEW);
  assert.equal(r.ok, false);
  assert.equal(r.got, 0);
  assert.equal(fs.textOf(REAL), GOOD);
  assert.equal(fs.renameAttempts, 0);
  assert.equal(fs.openCount, fs.closeCount);
});

test('非 ASCII 的 payload 在正常路径上也能落盘（不会因为按字节比对而永远失败）', () => {
  const fs: FakeFs = seeded('full', 0);
  const payload: string = JSON.stringify({ photos: [{ photoId: 'file://媒体/照片😀.jpg' }], lastBatchId: 1 });
  const r = writeTextAtomicWithPort(fs.port, TMP, REAL, payload);
  assert.equal(r.ok, true);
  assert.equal(r.want, Buffer.byteLength(payload, 'utf8'));
  assert.equal(r.want > payload.length, true);
  assert.equal(fs.textOf(REAL), payload);
});

// ── 5. 每条异常路径：都不 rename、都关 fd、都不动真身 ────────────────────────

const FAIL_MODES: string[] = ['throwOpen', 'throwWrite', 'throwClose', 'throwRename', 'short', 'over', 'returnNaN', 'returnNeg'];

test('每条异常路径都不 rename、都不改动真身（8 种注入逐条验证）', () => {
  for (let i = 0; i < FAIL_MODES.length; i++) {
    const mode: string = FAIL_MODES[i];
    const fs: FakeFs = seeded(mode, 1);
    const r = writeTextAtomicWithPort(fs.port, TMP, REAL, NEW);
    assert.equal(r.ok, false, `${mode} 必须失败`);
    assert.equal(r.renamed, false, `${mode} 绝不能 rename`);
    assert.equal(fs.renameSuccess, 0, `${mode} 绝不能真的换掉真身`);
    assert.equal(fs.textOf(REAL), GOOD, `${mode} 真身必须原封不动`);
    assert.equal(r.detail.length > 0, true, `${mode} 失败原因不能为空`);
    if (mode === 'throwRename') {
      assert.equal(fs.renameAttempts, 1, 'rename 失败这一路仍然应该尝试过 rename');
    } else {
      assert.equal(fs.renameAttempts, 0, `${mode} 不该尝试 rename`);
    }
    // open 成功过就必须 close 过（且只关一次）—— 这是"不泄漏 fd"的可机器验证形式
    if (mode === 'throwOpen') {
      assert.equal(fs.openCount, 0, 'open 失败：不该有 fd');
      assert.equal(fs.closeCount, 0, 'open 失败：没有 fd 可关，绝不能去 close(-1)');
    } else {
      assert.equal(fs.openCount, 1, `${mode} 应该打开过 .tmp`);
      assert.equal(fs.closeCount, 1, `${mode} 必须关掉 fd，且只关一次`);
    }
  }
});

test('回归：open 成功 → 后续抛异常 → 提前返回导致 fd 泄漏（本项目出过的真实缺陷）', () => {
  // 历史形态：openSync 成功 → 中间构造/写入抛异常 → catch 里直接 return → fd 没关。
  // 本用例断言"关闭发生在失败返回之前"，而不是"代码里有 finally"。
  const fs: FakeFs = seeded('throwWrite', 0);
  const r = writeTextAtomicWithPort(fs.port, TMP, REAL, NEW);
  assert.equal(r.ok, false);
  assert.equal(fs.openCount, 1);
  assert.equal(fs.closeCount, 1, 'write 抛错这条路径也必须关 fd');
  assert.deepEqual(fs.events, ['open', 'write', 'close']);
  assert.match(r.detail, /No space left on device/);
});

test('close 失败时不 rename（数据可能没刷下去，宁可不换文件）', () => {
  const fs: FakeFs = seeded('throwClose', 0);
  const r = writeTextAtomicWithPort(fs.port, TMP, REAL, NEW);
  assert.equal(r.ok, false);
  assert.equal(r.renamed, false);
  assert.equal(fs.renameAttempts, 0);
  assert.equal(fs.textOf(REAL), GOOD);
  assert.match(r.detail, /closeSync/);
});

test('TRUNC 打开 .tmp：上一次失败残留的 .tmp 会被清掉（残留无害）', () => {
  const fs: FakeFs = seeded('full', 0);
  fs.files.set(TMP, Buffer.from('上一次失败残留的截断内容', 'utf8'));
  const r = writeTextAtomicWithPort(fs.port, TMP, REAL, NEW);
  assert.equal(r.ok, true);
  assert.equal(fs.textOf(REAL), NEW);      // 真身是新内容，不是"旧残留 + 新内容"的拼接
});
