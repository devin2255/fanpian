import { appTasks } from '@ohos/hvigor-ohos-plugin';

/**
 * 签名材料**不进仓库**。
 *
 * 本仓库是公开仓库，签名口令一旦入库就等于公开。DevEco Studio 默认会把
 * `.cer` / `.p7b` / `.p12` 的绝对路径与 `keyPassword` / `storePassword`
 * 直接写进 `build-profile.json5`（该文件是被 git 跟踪的）—— 这条老路已废弃。
 *
 * 现在的做法：真实材料放在本机未入库的 `signing.local.json5`
 * （`.gitignore` 已忽略；模板见 `signing.local.json5.example`），
 * 由本文件在构建时读取并注入 hvigor 的官方扩展点
 * `config.ohos.overrides.signingConfig`。
 *
 * hvigor 侧的依据（@ohos/hvigor-ohos-plugin 6.26.8）：
 *   - configuration.js: `parseConfig(project, hvigorfile.default.config)`
 *   - abstract-project-plugin.js: `getConfigOpt().getObject('ohos')` → overrides
 *   - sign-util.js: `mergeSigningConfig(base, overrides)`，material 逐字段被覆盖
 * 所以 build-profile.json5 的 `signingConfigs` 留空即可，结构不变、仍是合法配置。
 *
 * 没有 `signing.local.json5` 时 overrides 为空 —— 构建照样成功，
 * 只是产物不签名（只有 unsigned hap）。
 */

declare const require: (id: string) => any;
declare const __dirname: string;

const fs = require('fs');
const path = require('path');

const LOCAL_SIGNING_FILE = 'signing.local.json5';

/**
 * 把 JSON5 的一个子集归一成严格 JSON：去掉注释与尾逗号。
 * 逐字符扫描并跟踪字符串状态，所以字符串里的 `//`、`,`、`}` 不会被误伤。
 */
function normalizeJson5(text: string): string {
  const out: string[] = [];
  let inString = false;
  let quote = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out.push(ch);
      if (ch === '\\') {
        if (i + 1 < text.length) {
          out.push(text[i + 1]);
          i += 2;
          continue;
        }
      } else if (ch === quote) {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '}' || ch === ']') {
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j])) {
        j -= 1;
      }
      if (j >= 0 && out[j] === ',') {
        out.splice(j, 1);
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** 读本机签名材料；文件不存在返回 undefined（= 不签名构建）。 */
function readLocalSigningConfig(): object | undefined {
  const file = path.resolve(__dirname, LOCAL_SIGNING_FILE);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(normalizeJson5(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    throw new Error(
      '读取 ' + LOCAL_SIGNING_FILE + ' 失败：' + (e as Error).message + '\n' +
        '请对照 signing.local.json5.example 检查该文件（必须是合法 JSON5/JSON）。'
    );
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.material) {
    throw new Error(LOCAL_SIGNING_FILE + ' 缺少 material 字段，请对照 signing.local.json5.example。');
  }
  return parsed;
}

const signingConfig = readLocalSigningConfig();

export default {
  system: appTasks, /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins: [],      /* Custom plugin to extend the functionality of Hvigor. */
  config: {
    ohos: {
      overrides: signingConfig ? { signingConfig } : {}
    }
  }
};
