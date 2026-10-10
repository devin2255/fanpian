// 「接线守卫」单测：**不测行为**，只证明四个 store 真的被接到了同一个原子写上。
//
// 为什么需要它：本缺陷族的成因不是"逻辑写错"，而是"某一份实现漏改了"（claimStore 的旧 save
// 既没有 .tmp 也没有短写校验；decisionStore / sessionStore 有 .tmp 但不校验返回值）。
// 单测能证明 core/atomicText.ts 是对的，却证明不了"四个 store 都在用它" ——
// 那正是本文件的职责：把 store 源码读进来，断言每一处写盘都只经 writeTextAtomic。
//
// 它读的是源码而不是 import：data/*.ets 依赖 @kit.*，Node 加载不了（本项目既有约束）。
// 因此断言刻意保持**语义级**（有没有调用、有没有绕过），不比对格式/行号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readEtc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
}

/**
 * 去掉**整行**注释后再做"有没有绕过原子写"的判断。
 *
 * 为什么需要它：本批刻意在 decisionStore / sessionStore 里写了注释说明旧形态长什么样
 *（`fileIo.writeSync(...)` 的返回值被丢弃），那几行注释不该被当成"代码里还在直接调"。
 * 只删整行注释（`//` / `*` / `/*` 开头）而**不动**代码行 —— 保守的一侧：
 * 代码行尾部若出现同样的字样仍会报红，那正是需要人来确认的情形。
 */
function stripCommentLines(src: string): string {
  const out: string[] = [];
  const lines: string[] = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l: string = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) { continue; }
    out.push(l);
  }
  return out.join('\n');
}

// 本文件在 core/ 下，store 在 ../data/ 下；用 import.meta.url 定位，与运行时的工作目录无关。
const STORES: string[] = [
  '../data/claimStore.ets',
  '../data/decisionStore.ets',
  '../data/sessionStore.ets',
  '../data/locationIndex.ets'
];

test('四个 store 都不再直接调 fileIo.writeSync（写盘只剩 writeTextAtomic 一条路）', () => {
  for (let i = 0; i < STORES.length; i++) {
    const src: string = stripCommentLines(readEtc(STORES[i]));
    assert.equal(src.indexOf('fileIo.writeSync(') < 0, true,
      `${STORES[i]} 仍然直接调 fileIo.writeSync —— 短写校验会被绕过去`);
    assert.equal(src.indexOf('writeTextAtomic(') >= 0, true,
      `${STORES[i]} 没有调用 writeTextAtomic`);
  }
});

test('四个 store 都从 data/atomicWrite 引入 writeTextAtomic（不是各写一份）', () => {
  for (let i = 0; i < STORES.length; i++) {
    const src: string = readEtc(STORES[i]);
    assert.match(src, /import \{[^}]*writeTextAtomic[^}]*\} from '\.\/atomicWrite'/, `${STORES[i]} 的 import 不对`);
  }
});

test('data/atomicWrite.ets 把平台层与纯逻辑接起来（端口 + 字节数交叉校验 + 失败必抛）', () => {
  const src: string = readEtc('../data/atomicWrite.ets');
  assert.match(src, /class FileIoPort implements AtomicWritePort/);
  assert.match(src, /fileIo\.writeSync\(/);            // 平台写盘只允许出现在这一处
  assert.match(src, /utf8ByteLength\(/);               // 纯函数的字节数
  assert.match(src, /buffer\.from\(text\)\.length/);   // 平台的字节数（交叉比对）
  assert.match(src, /wantPure !== wantPlatform/);
  assert.match(src, /throw new Error/);                // 失败必须让调用方知道
  // rename 只能出现在端口里（port.rename），且调用点只能在 core/atomicText.ts
  assert.equal(src.indexOf('renameSync') >= 0, true);
});

test('claimStore 的 load 不再有裸 return emptyClaimState()（D1 最坏路径必须留痕）', () => {
  const src: string = readEtc('../data/claimStore.ets');
  // 旧形态（就是本批要修的缺陷）：catch 里什么都不做，直接退空状态 —— 真机上完全不可见
  assert.equal(/catch\s*\(e\)\s*\{\s*return emptyClaimState\(\);\s*\}/.test(src), false,
    'claimStore 的 catch 又变回裸 return emptyClaimState() 了');
  // 解析失败必须带 e（四种成因只能靠 e.message 分开），且必须有一条可搜的告警文本
  assert.match(src, /认领文件存在但读取\/解析失败/);
  assert.match(src, /errText\(e\)/);
  // 结构校验失败（photos 不是数组）也必须有告警 —— 这条路径的后果与解析失败完全一样（photos: []）
  assert.match(src, /认领文件顶层结构非法/);
  // 单条记录被跳过要计数告警（丢的是"用户逐张授权来的 URI"）
  assert.match(src, /条非法记录，已跳过/);
});

test('claimStore 的 load 用 statSync 区分「文件不存在（首次运行）」与「解析失败」', () => {
  const src: string = readEtc('../data/claimStore.ets');
  // 两者混在同一级别的话，首次运行会刷一堆假告警；所以文件不存在那一支必须**静默**
  assert.match(src, /let exists = false;/);
  assert.match(src, /if \(!exists\) \{ return emptyClaimState\(\); \}/);
});

test('locationIndex 的 save 迁到共用实现后，注释里的「为什么」没有丢（搬到 core）', () => {
  const idx: string = readEtc('../data/locationIndex.ets');
  const core: string = readEtc('./atomicText.ts');
  // 范本注释（"短写若不检出，截断的 .tmp 会覆盖掉一份好索引"）必须仍然可搜到 —— 要么在原地，
  // 要么在 core/atomicText.ts（本批搬到那里，因为它现在描述的是**所有** store 的行为）
  assert.equal(idx.indexOf('短写') >= 0 || core.indexOf('短写') >= 0, true);
  assert.equal(core.indexOf('覆盖') >= 0, true);
  assert.match(idx, /writeTextAtomic\(/);
});
