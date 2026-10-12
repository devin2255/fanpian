// 设计令牌的守卫单测。
//
// ── 为什么视觉改动也需要单测（而不是"纯视觉无可测逻辑，如实说明"）──────────────
//   本次唯一**可测且值得测**的东西不是"好不好看"，而是三条**能被算出来的**约束：
//     ① 每个令牌色值是合法的 `#RRGGBB`（一个手滑的 `#F4FOE8`（字母 O）会让
//        `.backgroundColor()` 静默失效 —— 页面还是渲出来，只是那块底色没了）；
//     ② 正文/次要文字/强调色对底色的对比度**达标**（≥ 4.5:1）。这条是本批最直接的
//        可读性收益：旧代码里的 `#999999` 压 `#FAFAFA` 只有 2.85:1，是真机上"发虚"的成因；
//     ③ `pages/` 与 `ui/` 里**零硬编码**色值/字号/圆角 —— 也就是把工单要求的
//        "grep 证据"变成一条**每次跑测试都会重跑**的守卫，而不是一张一次性的截图。
//   ① ② 的价值在于"下次有人改一个令牌，跌破阈值会当场报红"；
//   ③ 的价值在于"下次有人顺手在页面里写一个 `#1F6FEB`，会当场报红"。
//   这三条都不是为凑数写的：它们各自钉住一个**已经真实发生过**的形态（见每节的注释）。
//
// ── 假绿判据（与本仓库既有的 protoBinEvidence.test.ts 同一口径）───────────────
//   凡是"扫描型"的断言，都必须先断言**扫描本身有效**（扫到的文件数、令牌数、
//   规则数大于某个下界）。否则一次路径写错就会得到"零命中 = 全绿"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  C_ACCENT, C_ACCENT_TEXT, C_ARCHIVE, C_BG, C_DANGER, C_FAV, C_LINE, C_MAP_BG, C_MAP_INK,
  C_MAP_LAND, C_MAP_LINE, C_MAP_MARKER, C_MAP_PIN, C_MAP_TRACK, C_NOTICE, C_OK, C_ON_PHOTO,
  C_PHOTO_MAT, C_SCRIM, C_SCRIM_ALPHA, C_SURFACE, C_TEXT, C_TEXT_DIM, C_WALL,
  COLOR_TOKENS, CONTRAST_RULES,
  F_BODY, F_CAPTION, F_DISPLAY, F_LABEL, F_MICRO, F_TITLE,
  LW_MAP_BORDER, R_LG, R_MD, R_SM,
  channelLuminance, compositeOver, contrastRatio, hexToRgb, isHexColor, rgbToHex, scrimOver,
  srgbLuminance
} from './designTokens.ts';
// 两个类型必须走 `import type`：本仓库的单测跑在 `--experimental-strip-types` 下，
// 而**不是**类型擦除之后还能解析"只存在于类型空间"的具名导入 —— 写成值导入会在
// 运行期报 `does not provide an export named 'ColorToken'`（本轮实测踩到）。
import type { ColorToken, ContrastRule } from './designTokens.ts';
import {
  BLOCK_FILL, MARKER_COLOR, PIN_COLOR, PROVINCE_STROKE, PROVINCE_WIDTH, TRACK_COLOR
} from './render.ts';

const ETS_ROOT: string = fileURLToPath(new URL('..', import.meta.url)).split('\\').join('/');

// ── §0 去注释器：先把它自己测掉（否则 §3 的"零硬编码"是假绿）─────────────────

/**
 * 去掉 `//` 行注释与块注释，**保留字符串字面量里的内容**。
 *
 * 为什么需要它（不是洁癖，是实测形态）：本仓库的注释密度是**有意**的，而且注释里
 * **大量出现色值**（例如 `pages/WallPage.ets` 的文件头写着"旧版卡片底色 `#EEE`"、
 * `ui/CardStack.ets` 里记着 `#EEE` 的取舍）。若直接对整份源码做 `#RRGGBB` 匹配，
 * 这些**说明文字**会被当成硬编码色值 —— 于是 §3 会在**完全正确**的代码上报红，
 * 而"修"它的办法居然是删掉历史注释（那是本仓库明令禁止的）。
 * 所以 §3 的判据必须是"**代码行**里的硬编码为零"，这就必须先有本函数。
 */
function stripComments(src: string): string {
  const out: string[] = [];
  let i: number = 0;
  let inBlock: boolean = false;
  let inLine: boolean = false;
  let quote: string = '';
  while (i < src.length) {
    const c: string = src.charAt(i);
    const n: string = i + 1 < src.length ? src.charAt(i + 1) : '';
    if (inLine) {
      if (c === '\n') { inLine = false; out.push(c); }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i += 2; continue; }
      if (c === '\n') { out.push(c); }   // 保留换行，行号才对得上
      i++;
      continue;
    }
    if (quote !== '') {
      // 字符串内：只有同种引号（且未被转义）才结束它。注释符在字符串里是普通字符。
      if (c === '\\') { out.push(c); out.push(n); i += 2; continue; }
      if (c === quote) { quote = ''; }
      out.push(c);
      i++;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out.push(c); i++; continue; }
    out.push(c);
    i++;
  }
  return out.join('');
}

test('去注释器：注释里的色值被去掉，字符串里的色值被保留（否则 §3 是假绿）', () => {
  const src: string = [
    '// 卡片底色 #EEE 是旧的',
    '/* 这一整块 #1F6FEB 也是注释',
    '   仍然在注释里 #FFFFFF */',
    "const a: string = '#A85D20';   // 尾注释里的 #D08A46 必须消失",
    'const b: string = "#F4F0E8";'
  ].join('\n');
  const code: string = stripComments(src);
  const hits: string[] = code.match(/#[0-9A-Fa-f]{6}/g) || [];
  assert.deepEqual(hits, ['#A85D20', '#F4F0E8'],
    `去注释之后应当只剩两个字符串里的色值，实际=${JSON.stringify(hits)}`);
  // 换行必须保留（否则"第几行"这类信息全丢）
  assert.equal(code.split('\n').length, src.split('\n').length, '去注释改变了行数');
});

test('去注释器：字符串里的 // 不被当成注释（URL / 路径形态）', () => {
  const src: string = "const u: string = 'file://media/Photo/1';  // 这一条是注释";
  const code: string = stripComments(src);
  assert.equal(code.indexOf('file://media/Photo/1') >= 0, true, '字符串里的 // 被误当注释');
  assert.equal(code.indexOf('这一条是注释') < 0, true, '真正的注释没有被去掉');
});

// ── §1 令牌清单：每个色值都是合法 #RRGGBB，且与同名常量一致 ───────────────────

test('令牌清单：合法 #RRGGBB、无重复、清单值 === 同名常量的值', () => {
  assert.equal(COLOR_TOKENS.length >= 20, true, `令牌清单只有 ${COLOR_TOKENS.length} 条，扫描/维护失效`);
  const seen: Map<string, string> = new Map<string, string>();
  for (let i = 0; i < COLOR_TOKENS.length; i++) {
    const t: ColorToken = COLOR_TOKENS[i];
    assert.equal(isHexColor(t.value), true,
      `${t.name}（${t.role}）的色值不是合法 #RRGGBB：'${t.value}' —— 字母 O 与数字 0 这类手滑会让属性静默失效`);
    assert.equal(t.role.length > 0, true, `${t.name} 没有写用途`);
    assert.equal(seen.has(t.name), false, `令牌 ${t.name} 在清单里出现了两次`);
    seen.set(t.name, t.value);
  }
  // 清单是**纯数据**，必须与上面那些真正被页面引用的常量一一对应 —— 否则会出现
  // "测试全绿、页面用的是另一个值"这种最坏的形态。
  const pairs: string[][] = [
    ['C_BG', C_BG], ['C_SURFACE', C_SURFACE], ['C_NOTICE', C_NOTICE], ['C_TEXT', C_TEXT],
    ['C_PHOTO_MAT', C_PHOTO_MAT],
    ['C_TEXT_DIM', C_TEXT_DIM], ['C_LINE', C_LINE], ['C_ACCENT', C_ACCENT],
    ['C_ACCENT_TEXT', C_ACCENT_TEXT], ['C_FAV', C_FAV], ['C_WALL', C_WALL],
    ['C_ARCHIVE', C_ARCHIVE], ['C_DANGER', C_DANGER], ['C_OK', C_OK],
    ['C_ON_PHOTO', C_ON_PHOTO], ['C_MAP_BG', C_MAP_BG], ['C_MAP_LAND', C_MAP_LAND],
    ['C_MAP_LINE', C_MAP_LINE], ['C_MAP_TRACK', C_MAP_TRACK], ['C_MAP_PIN', C_MAP_PIN],
    ['C_MAP_MARKER', C_MAP_MARKER], ['C_MAP_INK', C_MAP_INK]
  ];
  for (let i = 0; i < pairs.length; i++) {
    const name: string = pairs[i][0];
    const actual: string = pairs[i][1];
    const fromList: string | undefined = seen.get(name);
    assert.equal(fromList, actual, `清单里的 ${name} 与常量不一致：清单=${fromList} 常量=${actual}`);
  }
});

test('遮罩令牌：C_SCRIM 由数字常量生成（改一处即可，不会与 rgba 字符串漂开）', () => {
  assert.equal(C_SCRIM, 'rgba(46,42,36,0.72)', `C_SCRIM 的实际值是 '${C_SCRIM}'`);
  assert.equal(C_SCRIM_ALPHA, 0.72);
  assert.equal(hexToRgb(C_TEXT).join(','), '46,42,36', 'C_SCRIM 的基色必须仍是 C_TEXT 的暖黑');
});

// ── §2 对比度：按公式核，不按感觉 ─────────────────────────────────────────────

test('对比度函数本身：已知值必须精确（黑/白 21:1、同色 1:1、顺序无关）', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF') * 100) / 100, 21);
  assert.equal(contrastRatio('#2E2A24', '#2E2A24'), 1);
  assert.equal(contrastRatio('#FFFFFF', '#000000'), contrastRatio('#000000', '#FFFFFF'));
  // 伽马展开的两段：0.03928 是线性段与幂函数段的分界（写错就等于换了一套公式）
  assert.equal(Math.round(channelLuminance(0.03928) * 100000) / 100000,
    Math.round((0.03928 / 12.92) * 100000) / 100000);
  assert.equal(channelLuminance(1), 1);
  assert.equal(channelLuminance(0), 0);
  // 非法输入不得返回 NaN（NaN 会让所有比较静默为 false = 守卫失效但看起来是绿的）
  assert.equal(srgbLuminance('not-a-color'), 0);
  assert.equal(hexToRgb('#12345').length, 0, '#RGB / 位数不足必须判非法');
  assert.equal(hexToRgb('#11223344').length, 0, '#RRGGBBAA 必须判非法');
  assert.equal(isHexColor('F4F0E8'), false, '缺 # 必须判非法');
  // 往返：rgbToHex 与 hexToRgb 必须互逆
  assert.equal(rgbToHex(hexToRgb('#A85D20')[0], hexToRgb('#A85D20')[1], hexToRgb('#A85D20')[2]), '#A85D20');
  assert.equal(rgbToHex(-5, 300, 12), '#00FF0C', '越界通道必须被夹住，而不是产出 3 位/负数字符');
});

test('对比度：每一条要求都达标（正文 ≥ 4.5:1 —— 这是本批可读性收益的硬证据）', () => {
  assert.equal(CONTRAST_RULES.length >= 15, true, `只有 ${CONTRAST_RULES.length} 条要求，规则表被删空了`);
  const bad: string[] = [];
  const table: string[] = [];
  for (let i = 0; i < CONTRAST_RULES.length; i++) {
    const r: ContrastRule = CONTRAST_RULES[i];
    const got: number = Math.round(contrastRatio(r.fg, r.bg) * 100) / 100;
    table.push(`${r.fg} on ${r.bg} = ${got}:1（下限 ${r.min}，${r.why}）`);
    if (got < r.min) { bad.push(table[table.length - 1]); }
  }
  assert.equal(bad.length, 0,
    `这些组合没有达到它自己声明的下限：\n  ${bad.join('\n  ')}\n（完整表：\n  ${table.join('\n  ')}）`);
});

test('对比度：正文对底色必须有**余量**（不是刚好 4.5 —— 刚好就是下次微调就破）', () => {
  const body: number = contrastRatio(C_TEXT, C_BG);
  const dim: number = contrastRatio(C_TEXT_DIM, C_BG);
  assert.equal(body >= 7, true, `正文对底色只有 ${body.toFixed(2)}:1 —— 太紧，标题立不住`);
  assert.equal(dim >= 4.5, true, `次要文字对底色只有 ${dim.toFixed(2)}:1`);
  // 旧实现的对照（写进断言，免得将来有人"改回去"）：#999999 压 #FAFAFA 只有 2.73:1
  // —— 连大字的 3:1 都不到。这就是"次要文字发虚"的成因，也是本批要修的东西。
  const legacyDim: number = contrastRatio('#999999', '#FAFAFA');
  assert.equal(Math.round(legacyDim * 100) / 100, 2.73,
    `旧次要文字色的实测值变了（${legacyDim.toFixed(2)}）—— 本批要修的就是它，别把它算错`);
  assert.equal(dim > legacyDim, true, '新的次要文字色必须比旧的更可读');
  assert.equal(legacyDim < 3, true, '旧值必须**确实**不达标（否则"本批的可读性收益"这句话是假的）');
});

test('照片之上：遮罩浓度按**最坏情况（纯白照片）**反推，白字仍 ≥ 4.5:1', () => {
  const overWhite: string = scrimOver('#FFFFFF');
  const overBlack: string = scrimOver('#000000');
  const worst: number = contrastRatio(C_ON_PHOTO, overWhite);
  assert.equal(worst >= 4.5, true,
    `遮罩压在纯白照片上只剩 ${worst.toFixed(2)}:1（合成底 ${overWhite}）—— 浓度不够`);
  assert.equal(contrastRatio(C_ON_PHOTO, overBlack) >= 4.5, true, '压黑照片也必须达标');
  // 旧值对照 —— ⚠️ 这里是本批**实测纠正**过的一条：`rgba(0,0,0,0.55)` 在白照片上是
  // **4.74:1**，它是**达标**的。所以"改成暖黑 72%"的理由**不是**"旧的不达标"，
  // 而是 (a) 同源（纯黑遮罩在暖纸上发青）、(b) 4.74 只有 5% 余量、新值把它提到 5.74。
  // 把旧值也算错（例如顺手写成 4.2）就会让"为什么要改"这句话变成编的 —— 所以钉住它。
  const legacy: number = contrastRatio('#FFFFFF', compositeOver(0, 0, 0, 0.55, '#FFFFFF'));
  assert.equal(Math.round(legacy * 100) / 100, 4.74,
    `旧遮罩的实测值变了（${legacy.toFixed(2)}）—— 它**是达标的**，别把它说成缺陷`);
  assert.equal(legacy >= 4.5, true, '旧遮罩确实达标 —— 本批改它是为了余量与同源，不是为了救它');
  assert.equal(worst > legacy, true, '新遮罩的**最坏情况**必须比旧值更好（哪怕旧值本来就达标）');
});

// ── §2′ 旧色对照：把"为什么要改"也变成算出来的数 ─────────────────────────────
//
// 这一节的存在理由：如果报告里说"旧界面可读性不达标"，那必须是**算出来的**，
// 不能是"看着虚"。本节把那批旧硬编码色值逐个算一遍并钉住 —— 于是：
//   · 谁要是说"其实旧的也还行"，会在这里看到具体数字；
//   · 谁要是把某个新令牌改回旧值，§2 与本节会同时报红。

test('旧色对照（本批实测）：被替换掉的硬编码色里有 7 处压在 4.5:1 之下', () => {
  // 旧界面的底是 #FAFAFA，卡片/面板是 #FFFFFF（见改动前的 pages/*.ets）。
  const legacy: string[][] = [
    ['#999999', '#FAFAFA'],   // 次要文字（最常见的那一档）
    ['#AAAAAA', '#FAFAFA'],   // 「已铺满」/ 页脚提示
    ['#888888', '#FAFAFA'],   // 统计页的目标值 / 口径说明
    ['#1F6FEB', '#FAFAFA'],   // 「‹ 返回」「关闭」「重置视野」—— 所有像链接的字
    ['#8A8A8A', '#E8F0E4'],   // 地图上的「＋N」
    ['#1F9D55', '#FFFFFF'],   // 「达标」判定
    ['#B26A00', '#FFF6E5']    // 空数据横幅
  ];
  const below: string[] = [];
  const all: string[] = [];
  for (let i = 0; i < legacy.length; i++) {
    const got: number = Math.round(contrastRatio(legacy[i][0], legacy[i][1]) * 100) / 100;
    all.push(`${legacy[i][0]} on ${legacy[i][1]} = ${got}:1`);
    if (got < 4.5) { below.push(all[all.length - 1]); }
  }
  assert.equal(below.length, 7,
    `本批声称"修掉 7 处不达标"，实际算出 ${below.length} 处：\n  ${all.join('\n  ')}`);
  // 另外两条**是**达标的旧值 —— 一并钉住，免得把"改过"说成"全都坏了"（诚实记账）：
  assert.equal(Math.round(contrastRatio('#666666', '#FAFAFA') * 100) / 100, 5.5, '旧的 #666 是达标的');
  assert.equal(Math.round(contrastRatio('#FFFFFF', '#1F6FEB') * 100) / 100, 4.63, '旧按钮上的白字是达标的');
  // 最有说服力的一条：旧的「达标」绿比旧的「未达标」红**更难读**（3.49 vs 4.76）——
  // 一个会误导的颠倒。新令牌把这个关系摆正（6.17 vs 7.88，且都达标）。
  assert.equal(contrastRatio('#1F9D55', '#FFFFFF') < contrastRatio('#D33A2C', '#FFFFFF'), true,
    '旧值的"达标/未达标"可读性颠倒关系变了 —— 那是本节最要紧的一条观察，别把它算错');
});

// ── §3 零硬编码：把工单要的 grep 变成一条每次都会重跑的守卫 ───────────────────

/** 递归列出 `pages/` 与 `ui/` 下所有 `.ets`（路径统一成 `/`，Windows 上也稳定）。 */
function listUiSources(): string[] {
  const roots: string[] = [ETS_ROOT + '/pages', ETS_ROOT + '/ui'];
  const out: string[] = [];
  for (let i = 0; i < roots.length; i++) {
    const rel: string[] = readdirSync(roots[i], { recursive: true }) as string[];
    for (let j = 0; j < rel.length; j++) {
      const p: string = rel[j].split('\\').join('/');
      if (p.endsWith('.ets')) { out.push(roots[i] + '/' + p); }
    }
  }
  return out;
}

/** 一行里出现的硬编码形态（只查**代码**，注释里出现历史色值是允许的，见 §0）。 */
interface HardcodeHit { file: string; line: number; text: string; kind: string }

function findHardcodes(): HardcodeHit[] {
  const files: string[] = listUiSources();
  const hits: HardcodeHit[] = [];
  for (let i = 0; i < files.length; i++) {
    const raw: string = readFileSync(files[i], 'utf-8');
    const lines: string[] = stripComments(raw).split('\n');
    for (let k = 0; k < lines.length; k++) {
      const l: string = lines[k];
      const checks: string[][] = [
        ['色值', '#[0-9A-Fa-f]{6}\\b'],
        ['字号', '\\.fontSize\\(\\s*[0-9]'],
        ['圆角', '\\.borderRadius\\(\\s*[0-9]']
      ];
      for (let c = 0; c < checks.length; c++) {
        if (new RegExp(checks[c][1]).test(l)) {
          hits.push({ file: files[i].substring(ETS_ROOT.length + 1), line: k + 1, text: l.trim(), kind: checks[c][0] });
        }
      }
    }
  }
  return hits;
}

test('零硬编码：pages/ 与 ui/ 的**代码行**里没有色值 / 字号 / 圆角字面量', () => {
  const files: string[] = listUiSources();
  // 假绿判据：一个文件都没扫到 → 循环没跑 → 通过。必须先钉住这个下界。
  assert.equal(files.length >= 7, true, `只扫到 ${files.length} 个 .ets 源文件，扫描失效`);
  const hits: HardcodeHit[] = findHardcodes();
  const text: string[] = [];
  for (let i = 0; i < hits.length; i++) {
    text.push(`${hits[i].file}:${hits[i].line} [${hits[i].kind}] ${hits[i].text}`);
  }
  assert.equal(hits.length, 0,
    `这些地方还在直接写色值/字号/圆角（应当换成 core/designTokens 的令牌）：\n  ${text.join('\n  ')}`);
});

test('零硬编码守卫的**自检**：它确实能抓到三种形态（否则上面那条恒绿）', () => {
  // 用一个临时目录之外的做法：直接对着"带硬编码的样例源码"跑同一套正则，
  // 三条都必须命中 —— 这样"守卫本身写错了"会在这里报红，而不是在页面里漏过去。
  const sample: string = [
    "Text('x').fontColor('#1F6FEB').fontSize(14).borderRadius(8)",
    "Text('y').fontColor('#FFFFFF')",
    "Text('z').fontSize(9)"
  ].join('\n');
  const lines: string[] = stripComments(sample).split('\n');
  let n: number = 0;
  for (let k = 0; k < lines.length; k++) {
    if (/#[0-9A-Fa-f]{6}\b/.test(lines[k])) { n++; }
    if (/\.fontSize\(\s*[0-9]/.test(lines[k])) { n++; }
    if (/\.borderRadius\(\s*[0-9]/.test(lines[k])) { n++; }
  }
  assert.equal(n, 5, `样例里应当命中 5 处，实际 ${n} 处 —— 正则写错了（守卫恒绿）`);
});

// ── §4 阶梯：字号 6 档、圆角 3 档（这就是"收敛"的可复核证据）─────────────────

test('字号阶梯：恰好 6 档、严格递增、全部 ≥ 8（下界锚定真机验过的 8fp）', () => {
  const ladder: number[] = [F_MICRO, F_CAPTION, F_LABEL, F_BODY, F_TITLE, F_DISPLAY];
  assert.equal(ladder.length, 6, '字号阶梯不是 6 档 —— 工单要求收敛到 6 档以内');
  for (let i = 0; i < ladder.length; i++) {
    assert.equal(ladder[i] >= 8, true, `第 ${i} 档 ${ladder[i]}fp 小于 8 —— 真机上认不出字`);
    if (i > 0) {
      assert.equal(ladder[i] > ladder[i - 1], true,
        `第 ${i} 档 ${ladder[i]} 没有大于前一档 ${ladder[i - 1]}（阶梯必须严格递增）`);
    }
  }
  assert.equal(F_MICRO, 8, '下界被改掉了 —— 它是地图地名在真机上验过的值，收敛字号时不许动它');
});

test('圆角阶梯：恰好 3 档、严格递增（从原来的 5 档收敛）', () => {
  const steps: number[] = [R_SM, R_MD, R_LG];
  assert.equal(steps.length, 3, '圆角不是 3 档');
  assert.equal(steps[0] < steps[1] && steps[1] < steps[2], true, '圆角必须严格递增');
  assert.deepEqual(steps, [6, 10, 16], '三档都必须是既有值（6/10/16）—— 不借收敛之名改掉真机看过的外观');
});

// ── §5 地图墙配色：纳入了令牌，且**只有一处定义** ─────────────────────────────

test('地图配色：C_MAP_* 与 core/render 的常量**逐字节同一**（不是抄了一份）', () => {
  assert.equal(C_MAP_BG, BLOCK_FILL, 'C_MAP_BG 必须就是 core/render.BLOCK_FILL');
  assert.equal(C_MAP_LINE, PROVINCE_STROKE, 'C_MAP_LINE 必须就是 core/render.PROVINCE_STROKE');
  assert.equal(C_MAP_TRACK, TRACK_COLOR, 'C_MAP_TRACK 必须就是 core/render.TRACK_COLOR');
  assert.equal(C_MAP_PIN, PIN_COLOR, 'C_MAP_PIN 必须就是 core/render.PIN_COLOR');
  assert.equal(C_MAP_MARKER, MARKER_COLOR, 'C_MAP_MARKER 必须就是 core/render.MARKER_COLOR');
  // 上墙 = 轨迹：同一个值，这是产品语义（"挂上去"与"走过哪里"是同一个概念的两个视图）
  assert.equal(C_WALL, C_MAP_TRACK, 'C_WALL 必须与地图轨迹同值');
  // 另外两个值在 core/render 的 SVG 生成器里是**内联字面量**（没有导出），所以设备侧的
  // 唯一定义处就在令牌表 —— 这里把孪生值钉住：改一边必须改另一边，否则预览与真机不是同一张图。
  assert.equal(LW_MAP_BORDER, 0.8, '国界线宽必须与 core/render 的 SVG stroke-width="0.8" 一致');
  assert.equal(PROVINCE_WIDTH, 0.5, '省界线宽由 core/render 定义（靠线宽分主次，不靠颜色）');
  assert.equal(isHexColor(C_MAP_LAND), true, '陆地填充必须是合法色值（孪生位置：sceneToSvg 的 #E8F0E4）');
  assert.equal(isHexColor(C_MAP_INK), true, '地名墨色必须是合法色值（孪生位置：sceneToSvg 的地名 text fill）');
});
