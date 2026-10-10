// 「产物取证」守卫单测：把**protoBin 的取证规范**变成可执行的东西。
//
// ── 为什么需要它（batch-38 的实测教训）──────────────────────────────────────
//   `protoBin` 是 ArkTS 编译器为每个**进入编译图的模块**生成的符号/原型表。
//   batch-38 改了 `pages/ClaimPage.ets` 与 `data/metricsStore.ets`，重建之后
//   `ClaimPage.protoBin` = 80391 字节、`metricsStore.protoBin` = 18770 字节 ——
//   **与改动前一字不差**。也就是说：
//     · 「文件存在 + mtime 新」只能证明**有人重新生成过**，不能证明它来自改后的源码；
//     · 「大小变了」**不是**可靠判据 —— 大小相同既不蕴含"没重新生成"，也不蕴含"重新生成了"。
//   ⇒ 唯一可靠的判据是**字节内容**（新符号在不在、删掉的符号还在不在）。
//   本文件把这个判据写成**代码**，于是"下次又只比大小"会在这里报红，而不是靠谁记得。
//
// ── 为什么"只比大小"能被真的抓到（不是喊口号）───────────────────────────────
//   §1 用两条并排的实现把两种判据放在一起跑：`bytesEqual`（逐字节）与
//   `lengthOnlyWouldSaySame`（只比长度）。喂给它们一对**长度相同、内容不同**的缓冲区
//   —— 这正是 batch-38 真机上发生过的形态 —— 两者结论必须**相反**。
//   谁把取证判据实现成 size-only，这条立刻红。
//
// ── 另一条**本来就写在仓库里**的规范（ClaimPage.ets:9-15）也在这里落成检查 ──────
//   那段注释写着：「必须出现在「值位置」——只当类型用会被 ArkTS 擦成 type-only import，
//   那些模块就不会被编译，而构建照样 BUILD SUCCESSFUL（假绿）。判定真伪：编译后检查
//   entry/build/.../ets/core/<name>.protoBin 是否存在。」
//   §2 把前半句（源码侧）与 §4 把后半句（产物侧）都变成每次跑单测都会重跑的断言；
//   §3 把"哪些文件本来**不该**有 protoBin"（`*.test.ts`）也钉住。
//
// ⚠️ 诚实边界：§4 需要 `entry/build` 存在。单测可以在**没有构建过**的机器上跑，
//    所以那一节在产物缺失时**显式 skip 并说明原因**（而不是伪造一个永远绿的断言）。
//    §1/§2/§3 不依赖产物，永远跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── §1 两种判据并排 ─────────────────────────────────────────────────────────

/**
 * **正确**的判据：两份产物是否**逐字节**相同。
 * 逐字节比较而不是"长度相等" —— 见文件头：长度相同而内容不同是**实测发生过**的形态。
 */
function bytesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

/**
 * **错误**的判据（只比大小）。它在这里的唯一用途是**证明它错**：
 * 在"长度相同、内容不同"的输入上它会说"没变" —— 那正是假绿。
 * ⚠️ 它**不是**给生产/取证用的实现，只是一份被钉住的"错误答案"。
 */
function lengthOnlyWouldSaySame(a: Buffer, b: Buffer): boolean {
  return a.length === b.length;
}

/** 造一个 n 字节、指定填充模式的缓冲区（不依赖随机数，失败可复现）。 */
function fill(n: number, byte: number): Buffer {
  const buf: Buffer = Buffer.alloc(n, byte);
  return buf;
}

test('判据：长度相同 ≠ 内容相同 —— batch-38 的真实长度 80391 上两种判据结论必须相反', () => {
  // 80391 是 batch-38 实测的 ClaimPage.protoBin 字节数：**改动前后完全相同**，
  // 而内容确实变了（里面多了 failureMsg）。这两个数就是那个假绿的现场。
  const before: Buffer = fill(80391, 0x41);
  const after: Buffer = fill(80391, 0x41);
  after[80390] = 0x42;   // 只改最后一个字节 —— 长度一点没动
  assert.equal(before.length, after.length, '前提：两个缓冲区的长度必须相同');
  // 内容判据：变了。
  assert.equal(bytesEqual(before, after), false, '逐字节判据说"没变" —— 判据实现错了');
  // 大小判据：说"没变" —— 这就是假绿。两者结论**必须**相反，否则这条守卫没有意义。
  assert.equal(lengthOnlyWouldSaySame(before, after), true, '只比大小的判据竟然发现了变化 —— 说明它不是只比大小');
  assert.notEqual(bytesEqual(before, after), lengthOnlyWouldSaySame(before, after),
    '两种判据在这对输入上给出了相同结论 —— 本守卫抓不到"只比大小"这种做法');
});

test('判据：内容真的一样时两种判据都为真（不要为了抓假绿把判据改成"永远报变化"）', () => {
  const a: Buffer = fill(64, 0x7a);
  const b: Buffer = fill(64, 0x7a);
  assert.equal(bytesEqual(a, b), true);
  assert.equal(lengthOnlyWouldSaySame(a, b), true);
});

test('判据：长度不同必然不同（这一侧两种判据一致，不是它们的分界）', () => {
  assert.equal(bytesEqual(fill(10, 1), fill(11, 1)), false);
  assert.equal(lengthOnlyWouldSaySame(fill(10, 1), fill(11, 1)), false);
});

test('判据：空缓冲区也走逐字节比较（不要用"长度为 0 就当相同"的短路）', () => {
  assert.equal(bytesEqual(Buffer.alloc(0), Buffer.alloc(0)), true);
  assert.equal(bytesEqual(Buffer.alloc(0), fill(1, 0)), false);
});

// ── §2 源码侧：每个 core 模块必须留在 ArkTS 编译图里（值位置引入）─────────────

const ETS_ROOT: string = fileURLToPath(new URL('..', import.meta.url)).split('\\').join('/');

/** 递归列出 `entry/src/main/ets/` 下所有 `.ets`（路径统一成 `/`，Windows 上也稳定）。 */
function listEtsSources(): string[] {
  const rel: string[] = readdirSync(ETS_ROOT, { recursive: true }) as string[];
  const out: string[] = [];
  for (let i = 0; i < rel.length; i++) {
    const p: string = rel[i].split('\\').join('/');
    if (p.endsWith('.ets')) { out.push(ETS_ROOT + '/' + p); }
  }
  return out;
}

/** `core/` 下的**生产**模块名（`*.test.ts` 不进 ArkTS 编译，不在此列）。 */
function listCoreModules(): string[] {
  const names: string[] = readdirSync(ETS_ROOT + '/core');
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const n: string = names[i];
    if (!n.endsWith('.ts')) { continue; }
    if (n.endsWith('.test.ts')) { continue; }
    out.push(n.substring(0, n.length - 3));
  }
  return out;
}

/** 去掉整行注释与 import 行之后剩下"真正的代码"。 */
function codeLinesOnly(src: string): string {
  const out: string[] = [];
  const lines: string[] = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l: string = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) { continue; }
    if (/^\s*import\s/.test(l) || /^\s*\}\s*from\s/.test(l)) { continue; }
    out.push(l);
  }
  return out.join('\n');
}

/** 从 `import { A, B } from '../core/<mod>'` 里取出具名绑定（不含没有花括号的默认导入）。 */
function namedBindingsFor(src: string, mod: string): string[] {
  const out: string[] = [];
  const re: RegExp = new RegExp("import\\s*\\{([^}]*)\\}\\s*from\\s*'[^']*core/" + mod + "'", 'g');
  let m: RegExpExecArray | null = re.exec(src);
  while (m !== null) {
    const parts: string[] = m[1].split(',');
    for (let i = 0; i < parts.length; i++) {
      const name: string = parts[i].split(' as ')[0].trim();
      if (name !== '') { out.push(name); }
    }
    m = re.exec(src);
  }
  return out;
}

test('ArkTS 编译图：每个 core/*.ts（非 test）都被某个 .ets 以**值位置**引入', () => {
  const ets: string[] = listEtsSources();
  // 假绿判据：扫描失效时必须报红，而不是"一个文件都没扫到 → 循环没跑 → 通过"。
  assert.equal(ets.length > 10, true, `只扫到 ${ets.length} 个 .ets 文件，扫描本身失效了`);
  const mods: string[] = listCoreModules();
  assert.equal(mods.length > 10, true, `只扫到 ${mods.length} 个 core 模块，扫描本身失效了`);

  const missing: string[] = [];
  for (let i = 0; i < mods.length; i++) {
    const mod: string = mods[i];
    let inGraph = false;
    for (let j = 0; j < ets.length && !inGraph; j++) {
      const src: string = readFileSync(ets[j], 'utf-8');
      if (src.indexOf("core/" + mod + "'") < 0) { continue; }
      // 类型位置会被 ArkTS 擦成 type-only import → 模块不进编译图 → 没有 protoBin，
      // 而构建照样 BUILD SUCCESSFUL（ClaimPage.ets:9-15 记录的假绿）。
      // 所以必须至少有一个具名绑定出现在**非 import、非注释**的代码行上。
      const code: string = codeLinesOnly(src);
      const bindings: string[] = namedBindingsFor(src, mod);
      for (let k = 0; k < bindings.length; k++) {
        const b: string = bindings[k];
        // 函数/常量当值时一定以标识符形态出现；这里只要求"在代码行里出现过"。
        if (new RegExp('\\b' + b + '\\b').test(code)) { inGraph = true; break; }
      }
    }
    if (!inGraph) { missing.push(mod); }
  }
  assert.equal(missing.length, 0,
    `这些 core 模块没有任何 .ets 以值位置引入 → 它们不在 ArkTS 编译图里、不会有 protoBin：${missing.join(', ')}`);
});

test('ArkTS 编译图：本批新增的 core/motionProbeState.ts 在图中，且确实是**调用**它在用', () => {
  const src: string = readFileSync(ETS_ROOT + '/ui/CardStack.ets', 'utf-8');
  const bindings: string[] = namedBindingsFor(src, 'motionProbeState');
  assert.equal(bindings.length > 5, true, `CardStack 从纯模块引入的绑定太少（${bindings.length} 个）—— 接线可能被删掉了`);
  // 最强的"值位置"证据：调用它导出的函数（只当类型用时不可能出现 `beginMotionProbe(`）。
  assert.equal(src.indexOf('beginMotionProbe(') >= 0, true, '没有调用 beginMotionProbe —— 纯模块没被真正使用');
  assert.equal(src.indexOf('settleMotionProbe(') >= 0, true, '没有调用 settleMotionProbe');
  assert.equal(src.indexOf('armMotionProbe(') >= 0, true, '没有调用 armMotionProbe');
  assert.equal(src.indexOf('newMotionProbeState()') >= 0, true, '没有调用 newMotionProbeState');
  assert.equal(src.indexOf('releaseMotionProbe(') >= 0, true, '没有调用 releaseMotionProbe');
});

// ── §3 假绿判据：`*.test.ts` 本来就不该有 protoBin ───────────────────────────

test('假绿判据：没有任何 .ets 引入 core/*.test.ts（否则 node:test 会被拖进 ArkTS 编译）', () => {
  const ets: string[] = listEtsSources();
  assert.equal(ets.length > 10, true, '扫描失效');
  const offenders: string[] = [];
  for (let i = 0; i < ets.length; i++) {
    const src: string = readFileSync(ets[i], 'utf-8');
    if (/from\s*'[^']*\.test'/.test(src) || /from\s*'[^']*\.test\.ts'/.test(src)) {
      offenders.push(ets[i]);
    }
  }
  assert.equal(offenders.length, 0, `这些 .ets 引入了单测文件：${offenders.join(', ')}`);
});

// ── §4 产物侧（需要 entry/build；缺失时显式 skip，不伪造绿）───────────────────

const ARTIFACT_ROOT: string = fileURLToPath(
  new URL('../../../../../entry/build/default/cache/default/default@CompileArkTS/esmodule/debug/entry/src/main/ets',
    import.meta.url)).split('\\').join('/');

/** 把 protoBin 当**字节**读进来做符号检索（latin1 = 1 字节 1 字符，不丢字节、不误解码）。 */
function readArtifactText(p: string): string {
  return readFileSync(p, 'latin1');
}

test('产物取证【内容而非大小】：CardStack / motionProbeState 的 protoBin 必须含**新符号**', (t) => {
  if (!existsSync(ARTIFACT_ROOT)) {
    // 诚实 skip：单测允许在没有构建过的机器上跑。真正的取证在"删 entry/build → 全量重建"之后做。
    t.skip(`entry/build 不存在（未构建），跳过产物取证：${ARTIFACT_ROOT}`);
    return;
  }
  const modBin: string = ARTIFACT_ROOT + '/core/motionProbeState.protoBin';
  const cardBin: string = ARTIFACT_ROOT + '/ui/CardStack.protoBin';
  const cardTs: string = ARTIFACT_ROOT + '/ui/CardStack.ts';
  assert.equal(existsSync(modBin), true, '新增模块没有 protoBin —— 它没进 ArkTS 编译图');
  assert.equal(existsSync(cardBin), true, 'CardStack 没有 protoBin');
  assert.equal(existsSync(cardTs), true, 'CardStack 没有转换产物 .ts');

  // ① 新模块的 protoBin 里必须出现**只存在于新代码**的符号。
  const modText: string = readArtifactText(modBin);
  assert.equal(modText.indexOf('settleMotionProbe') >= 0, true, `motionProbeState.protoBin 里没有 settleMotionProbe（大小=${modText.length} 字节，**不看大小**）`);
  assert.equal(modText.indexOf('armMotionProbe') >= 0, true, 'motionProbeState.protoBin 里没有 armMotionProbe');
  assert.equal(modText.indexOf('MotionProbeTicket') >= 0, true, 'motionProbeState.protoBin 里没有 MotionProbeTicket');

  // ② CardStack 的产物里必须出现纯模块的符号（证明"接线"真的发生了，而不是源码里写了没编译）。
  const cardText: string = readArtifactText(cardBin);
  assert.equal(cardText.indexOf('beginMotionProbe') >= 0, true, 'CardStack.protoBin 里没有 beginMotionProbe —— 接线没有进产物');
  assert.equal(cardText.indexOf('motionProbeState') >= 0, true, 'CardStack.protoBin 里没有 motionProbeState');

  // ③ 被**删掉**的字段不得再出现在转换产物的**代码**里（"删掉的符号还在"= 产物是旧的）。
  //    ⚠️ 必须**先去注释**再判 —— 这不是洁癖，是实测踩到的：
  //    ArkTS→TS 的转换会**保留注释**，而 CardStack 里刻意留着一段讲述旧实现的历史注释
  //    （"旧实现把两件事塞进一个 `motionForId` 字段"）。直接对整份产物做子串匹配，
  //    会把这段**说明文字**当成"字段还在"，从而在**完全正确**的产物上报红。
  //    顺带一个反面对照：`protoBin` 是**符号表**，它不含注释 —— 所以上面那两条
  //    对 protoBin 的 `indexOf` 不需要去注释（`motionForId` 在它里面确实是 False）。
  const tsText: string = readFileSync(cardTs, 'utf-8');
  assert.equal(tsText.indexOf('beginMotionProbe(') >= 0, true, 'CardStack.ts 里没有 beginMotionProbe( 调用');
  assert.equal(tsText.indexOf('this.motionState') >= 0, true, 'CardStack.ts 里没有 this.motionState —— 状态没有被搬到纯模块');
  assert.equal(codeLinesOnly(tsText).indexOf('motionForId') < 0, true,
    'CardStack.ts 的**代码行**里仍然有 motionForId —— 产物来自改动前的源码（或回退了）');
  // 假绿判据：先去注释这一步不能把整份产物也删空（否则上面那条断言恒真）。
  assert.equal(codeLinesOnly(tsText).length > tsText.length / 4, true,
    '去注释之后产物只剩下不足 1/4 —— 说明去注释规则写错了，上一条断言是假绿');
});

test('产物取证：每个 core 生产模块都必须有 protoBin，且**没有任何 test 的 protoBin**', (t) => {
  if (!existsSync(ARTIFACT_ROOT)) {
    t.skip(`entry/build 不存在（未构建），跳过产物取证：${ARTIFACT_ROOT}`);
    return;
  }
  const mods: string[] = listCoreModules();
  assert.equal(mods.length > 10, true, '扫描失效');
  for (let i = 0; i < mods.length; i++) {
    const p: string = ARTIFACT_ROOT + '/core/' + mods[i] + '.protoBin';
    assert.equal(existsSync(p), true, `core/${mods[i]}.ts 没有 protoBin —— 它没进 ArkTS 编译图（构建却会 SUCCESSFUL，这是假绿）`);
  }
  const all: string[] = readdirSync(ARTIFACT_ROOT, { recursive: true }) as string[];
  const testBins: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const n: string = all[i];
    if (n.endsWith('.protoBin') && n.indexOf('test') >= 0) { testBins.push(n); }
  }
  assert.equal(testBins.length, 0, `出现了 test 的 protoBin（单测被拖进了 ArkTS 编译）：${testBins.join(', ')}`);
});
