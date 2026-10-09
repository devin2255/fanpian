import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExifTime, buildExifInfo } from './exifParse.ts';

test('标准 EXIF 时间格式', () => {
  const t = parseExifTime('2026:10:08 14:48:49');
  assert.ok(t > 0);
  const d = new Date(t);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth() + 1, 10);
  assert.equal(d.getDate(), 8);
  assert.equal(d.getHours(), 14);
});

test('空字符串返回 0', () => {
  assert.equal(parseExifTime(''), 0);
});

test('格式非法返回 0', () => {
  assert.equal(parseExifTime('not a date'), 0);
});

test('用短横线分隔也能解析', () => {
  assert.ok(parseExifTime('2026-10-08 14:48:49') > 0);
});

// ── 以下为计划漏测的边界（控制器要求补） ──────────────────────────────

test('前后有空格也能解析（EXIF 里确实出现过带空白的值）', () => {
  const t = parseExifTime(' 2026:10:08 14:48:49 ');
  assert.equal(t, parseExifTime('2026:10:08 14:48:49'));
});

test('同一时刻也接受 T 分隔符', () => {
  const t = parseExifTime('2026:10:08T14:48:49');
  assert.equal(t, parseExifTime('2026:10:08 14:48:49'));
});

/**
 * 只有日期没有时间 → **按当地时间的 00:00:00 解析**（不是 0、也不是 UTC 午夜）。
 * 理由：① 日期本身是真实信息，截图/部分导出图只留日期并不代表数据损坏，
 * 丢掉它会让地图墙少一张照片的时间；② 同一张表里 `"YYYY:MM:DD HH:MM:SS"` 按**当地时间**解释
 *（EXIF DateTime 无时区字段），只有日期的值也必须落在同一个坐标系里 —— 若交给
 * `Date.parse('2026-10-08')` 走「仅日期 ISO 串 = UTC 午夜」那条规则，在东八区会整体偏移 8 小时
 *（实测 1791417600000 = 当地 08:00），同一天的照片会分到两个不同的时刻上。所以这里自己补齐时分秒。
 */
test('只有日期没有时间 → 当地时间 00:00:00', () => {
  const t = parseExifTime('2026:10:08');
  assert.ok(t > 0);
  const d = new Date(t);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth() + 1, 10);
  assert.equal(d.getDate(), 8);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
});

test('闰日 2024:02:29 能解析', () => {
  const t = parseExifTime('2024:02:29 00:00:00');
  assert.ok(t > 0);
  const d = new Date(t);
  assert.equal(d.getFullYear(), 2024);
  assert.equal(d.getMonth() + 1, 2);
  assert.equal(d.getDate(), 29);
});

test('平年 2026:02:29 返回 0（不是闰年，这天不存在）', () => {
  assert.equal(parseExifTime('2026:02:29 00:00:00'), 0);
});

/**
 * 溢出日期 → **0（视为非法）**。
 * 理由：EXIF DateTime 的字段是有确定值域的（月 1-12、日 1-当月天数、时 0-23、分/秒 0-59），
 * `2026:13:45 99:99:99` 不可能是任何相机的正常输出，只可能是文件损坏或被改写；
 * 给它猜一个时刻（例如回绕/进位的某天）会让一张坏照片悄悄出现在地图墙的错误位置上，
 * 而 0 = 「时间未知」是调用方能正确处理的语义（见 readExif 的 takenAt）。
 */
test('非法日期 2026:13:45 99:99:99 返回 0', () => {
  assert.equal(parseExifTime('2026:13:45 99:99:99'), 0);
});

test('月 0 / 日 0 返回 0', () => {
  assert.equal(parseExifTime('2026:00:08 14:48:49'), 0);
  assert.equal(parseExifTime('2026:10:00 14:48:49'), 0);
});

/**
 * 这条是「必须自己校验值域、不能依赖 Date.parse」的直接证据：
 * V8 的 ISO 解析对**月/日溢出**是宽容的 —— `Date.parse('2026-02-30T00:00:00')` 实测返回
 * 1772380800000（自动进位成 3 月 2 日），而不是 NaN。只有「月 > 12 / 时 > 23」这类
 * 连进位都放不下的值才会得到 NaN。照抄 `Date.parse` 就会把 2 月 30 日当成 3 月 2 日。
 */
test('日期溢出到不存在的日子 2026:02:30 返回 0（Date.parse 会静默进位成 3 月 2 日）', () => {
  assert.equal(parseExifTime('2026:02:30 00:00:00'), 0);
});

test('时 24 返回 0（Date.parse 会静默进位成次日 00:00）', () => {
  assert.equal(parseExifTime('2026:10:08 24:00:00'), 0);
  assert.equal(parseExifTime('2026:10:08 14:60:00'), 0);
});

test('纯数字串返回 0', () => {
  assert.equal(parseExifTime('20261008'), 0);
  assert.equal(parseExifTime('20261008144849'), 0);
});

test('全 0 的占位值 0000:00:00 00:00:00 返回 0', () => {
  assert.equal(parseExifTime('0000:00:00 00:00:00'), 0);
});

test('undefined / null 返回 0（getImageProperties 对缺失字段给不出字符串）', () => {
  // 运行期防御：ArkTS 的 Record 取值在键缺失时可能是 undefined，
  // 类型标注挡不住这种值，所以这里用 as 洗一个进去验证不会抛。
  assert.equal(parseExifTime(undefined as unknown as string), 0);
  assert.equal(parseExifTime(null as unknown as string), 0);
});

// ── buildExifInfo：hasGps 判据（设备侧 readExif 的组装规则，放在纯层才可测） ──

test('buildExifInfo：坐标解析失败（NaN）一律归 0，hasGps=false', () => {
  const info = buildExifInfo(1234, NaN, NaN);
  assert.equal(info.takenAt, 1234);
  assert.equal(info.lat, 0);
  assert.equal(info.lon, 0);
  assert.equal(info.hasGps, false);
});

/**
 * 只有一半坐标 → hasGps=false，且**两个都归 0**（不是只归零 NaN 那个）。
 * 理由：索引里的 `(31.2495, 0)` 在消费方看来是个「合法但错误」的坐标（几内亚湾），
 * 比「没有 GPS」危险得多 —— LocationEntry 没有 hasGps 字段，Task 10 的地图墙
 * 只要漏判一次就会把照片钉到非洲西海岸。成对归零后，唯一的「无坐标」表示就是 (0,0)。
 */
test('buildExifInfo：只有一半坐标 → 两个都归 0，hasGps=false', () => {
  const info = buildExifInfo(0, 31.2495, NaN);
  assert.equal(info.lat, 0);
  assert.equal(info.lon, 0);
  assert.equal(info.hasGps, false);
});

test('buildExifInfo：真实坐标 → hasGps=true', () => {
  const info = buildExifInfo(0, 31.2495, 121.4813);
  assert.equal(info.hasGps, true);
});

test('buildExifInfo：南半球 / 西半球的负坐标也算有 GPS', () => {
  const info = buildExifInfo(0, -33.8688, 151.2093);
  assert.equal(info.lat, -33.8688);
  assert.equal(info.hasGps, true);
});

test('buildExifInfo：(0,0) → hasGps=false（坐标全为 0 视为未记录）', () => {
  const info = buildExifInfo(0, 0, 0);
  assert.equal(info.hasGps, false);
});

test('buildExifInfo：没有时间也照样返回（截图没有 DateTime 是常态，不是错误）', () => {
  const info = buildExifInfo(0, 31.2495, 121.4813);
  assert.equal(info.takenAt, 0);
  assert.equal(info.hasGps, true);
});
