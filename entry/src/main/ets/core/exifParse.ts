/**
 * EXIF 解析的纯逻辑层：拍摄时间 → epoch ms，坐标 → ExifInfo。
 *
 * 本文件**不得** import 任何 `@kit.*`（项目全局约束）：设备侧的读 EXIF 在
 * `data/exifReader`（fileIo + ImageSource），这里只做字符串 → 数值的换算，
 * 于是解析规则可以在 Node 下单测（`exifParse.test.ts`）。
 */

export interface ExifInfo {
  takenAt: number;   // epoch ms；0 = 时间未知（不是错误）
  lat: number;       // 十进制度；0 且 lon 也为 0 = 未记录 GPS
  lon: number;
  hasGps: boolean;   // lat/lon 是否成对有效
}

/**
 * EXIF 日期时间的形状：`YYYY:MM:DD HH:MM:SS`。
 * - 日期段的分隔符接受 `:`（EXIF 标准写法）与 `-`（部分导出工具改写过）；
 * - 日期与时间之间接受空格或 `T`；
 * - 时间部分**允许整个缺失**（只留日期）→ 按当地 00:00:00 解释，理由见 parseExifTime；
 * - 值域（月/日/时/分/秒）**不在这里判**：日与月的关系（闰年 2 月有 29 天、4 月只有 30 天）
 *   正则表达不了，交给 **parseExifTime** 里的值域判断 + 「构造后回读年/月/日」校验
 *   （**不是** buildExifInfo —— 它只对 takenAt/lat/lon 做 isFinite，不碰日期字段）。
 * 刻意不支持小数秒（EXIF 标准里它属于独立的 SubSecTime 标签，不在这张表里）：
 * 见到 `14:48:49.123` 会判为格式非法 → 返回 0（时间未知），这是已知且接受的取舍。
 */
const EXIF_TIME_RE = /^(\d{4})[-:](\d{2})[-:](\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?$/;

/** 用显式的年/月/日构造当地时间，绕开 JS `new Date(y, ...)` 把 0-99 当 1900+y 的坑 */
function localDate(y: number, mo: number, d: number, hh: number, mi: number, ss: number): Date {
  const dt = new Date(0);
  dt.setFullYear(y, mo - 1, d);
  dt.setHours(hh, mi, ss, 0);
  return dt;
}

/**
 * 把 EXIF 的 `"2026:10:08 14:48:49"` 转成 epoch ms；任何不合法输入返回 **0**。
 *
 * 语义（这几条是刻意的，不是实现细节）：
 * 1. **按当地时间解释**。EXIF 的 DateTime 没有时区字段，它就是"相机上显示的那个时刻"，
 *    与全世界其他照片对齐时只能按本机时区理解（本函数与 UI 的 `new Date(t)` 同源）。
 * 2. **只给日期时补 00:00:00（当地）**。日期本身是真实信息，截图/导出图只留日期不代表损坏。
 *    不能交给 `Date.parse('2026-10-08')` —— 「只有日期的 ISO 串」在规范里是 **UTC** 午夜，
 *    东八区会解析成当地 08:00，同一天的照片会被分到两个不同时刻上（实测 1791417600000）。
 * 3. **溢出即非法 → 0**，不依赖 `Date.parse` 的宽容行为。实测 V8：
 *    `Date.parse('2026-02-30T00:00:00')` = 1772380800000（静默进位成 3 月 2 日）、
 *    `Date.parse('2026-10-08T24:00:00')` = 次日 00:00；只有月 > 12 之类的值才给 NaN。
 *    跟着它走会把一张损坏的照片悄悄放到地图墙的错误时间点上，而 0 = 「时间未知」是
 *    调用方能正确处理的语义。所以这里自己校验值域，并用"构造后回读三个字段"兜住
 *    "闰年 2 月 29 日存在 / 平年不存在"这种正则表达不了的关系。
 * 4. 年份 0（`0000:...`）视为占位值 → 0：它是部分相机写不出时间时的哨兵，不是公元 0 年。
 */
export function parseExifTime(s: string): number {
  if (s === undefined || s === null || s === '') { return 0; }
  const m = EXIF_TIME_RE.exec(s.trim());
  if (m === null) { return 0; }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // 时间缺失（m[4..6] 为 undefined）时补 0 → 当地 00:00:00
  const hh = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  if (y < 1) { return 0; }
  if (mo < 1 || mo > 12) { return 0; }
  if (d < 1 || d > 31) { return 0; }          // 上界先粗挡，精确天数由下面的回读校验负责
  if (hh > 23 || mi > 59 || ss > 59) { return 0; }
  const dt = localDate(y, mo, d, hh, mi, ss);
  // 回读校验：2 月 30 日会被 Date 归一化到 3 月 2 日（年/月/日三个字段就对不上了）。
  // 这一步同时覆盖闰年规则（2024-02-29 通过、2026-02-29 被归一化到 3 月 1 日而被拒）。
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) { return 0; }
  const t = dt.getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 组装 ExifInfo：时间/坐标的"解析失败"一律收敛成 0，并给出 hasGps 判据。
 *
 * 为什么在纯层（而不在设备侧的 `readExif` 里）：它是读 EXIF 这条链上唯一有分支的逻辑，
 * 放在 `.ets` 里就进不了 Node 测试 —— 而 hasGps 恰恰是最容易被消费方误解的字段。
 *
 * 坐标的规则是**成对**的：`lat`/`lon` 必须都是有限数、且不全为 0，才算"有 GPS"；
 * 否则两个都归 0。只归零坏掉的那一半会留下 `(31.2495, 0)` 这种"合法但错误"的坐标
 *（几内亚湾），而 `LocationEntry` 里没有 hasGps 字段，漏判一次就把照片钉到错的位置。
 * 真实的 (0,0) 坐标（几内亚湾海面）因此会被当成"没有 GPS"：这是本项目接受的取舍，
 * 与 hasGps 的判据保持一致。
 *
 * takenAt 为 0 是**常态**而非错误：截图、部分导出图没有 DateTime，
 * 调用方按"时间未知"处理即可（不要当成读取失败去重试）。
 */
export function buildExifInfo(takenAt: number, lat: number, lon: number): ExifInfo {
  const timeOk: boolean = Number.isFinite(takenAt);
  const gpsOk: boolean = Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);
  return {
    takenAt: timeOk ? takenAt : 0,
    lat: gpsOk ? lat : 0,
    lon: gpsOk ? lon : 0,
    hasGps: gpsOk
  };
}
