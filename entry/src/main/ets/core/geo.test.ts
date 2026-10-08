import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, dmsToDecimal, applyRef, parseExifCoord, clusterPoints, medianPoint }
  from './geo.ts';

test('haversine：上海到北京约 1067 公里', () => {
  const d = haversineMeters({ lat: 31.23, lon: 121.47 }, { lat: 39.90, lon: 116.40 });
  assert.ok(d > 1050000 && d < 1090000, `实际 ${d}`);
});

test('同一点距离为 0', () => {
  assert.equal(haversineMeters({ lat: 31.2, lon: 121.4 }, { lat: 31.2, lon: 121.4 }), 0);
});

test('dms 换算：31, 14, 59.821472 → 31.24995', () => {
  const v = dmsToDecimal('31, 14, 59.821472');
  assert.ok(Math.abs(v - 31.24995) < 0.00001, `实际 ${v}`);
});

test('dms 兼容全角逗号', () => {
  const v = dmsToDecimal('31，14，59.821472');
  assert.ok(Math.abs(v - 31.24995) < 0.00001);
});

test('dms 段数不足返回 NaN', () => {
  assert.ok(Number.isNaN(dmsToDecimal('31, 14')));
});

test('applyRef 兼容字母与 ASCII 码', () => {
  assert.equal(applyRef(10, 'N'), 10);
  assert.equal(applyRef(10, 'S'), -10);
  assert.equal(applyRef(10, '83'), -10);   // 'S' 的 ASCII
  assert.equal(applyRef(10, 'W'), -10);
  assert.equal(applyRef(10, '87'), -10);   // 'W' 的 ASCII
  assert.equal(applyRef(10, '78'), 10);    // 'N' 的 ASCII
});

test('parseExifCoord 一步到位', () => {
  const lat = parseExifCoord('31, 14, 59.821472', 'N');
  assert.ok(Math.abs(lat - 31.24995) < 0.00001);
});

test('clusterPoints：500 米内合并，超过则分开', () => {
  const pts = [
    { lat: 31.2300, lon: 121.4700 },
    { lat: 31.2302, lon: 121.4702 },   // 约 30 米 → 同簇
    { lat: 31.2400, lon: 121.4800 }    // 约 1.4 公里 → 新簇
  ];
  const groups = clusterPoints(pts, 500);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, 2);
  assert.equal(groups[1].length, 1);
});

test('medianPoint 取中位数，抗离群点', () => {
  const m = medianPoint([
    { lat: 10, lon: 20 },
    { lat: 11, lon: 21 },
    { lat: 99, lon: 99 }   // 离群
  ]);
  assert.equal(m.lat, 11);
  assert.equal(m.lon, 21);
});
