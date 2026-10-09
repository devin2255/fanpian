/**
 * 坐标 → 地名 探针（一次性排查用，不是产品代码）。
 * 用法：node --experimental-strip-types tools/probe-names.ts
 */
import fs from 'node:fs';
import { parseAreaData, nearestCounty } from '../entry/src/main/ets/core/areaData.ts';
import { formatPlace } from '../entry/src/main/ets/core/placePick.ts';
import { projectMercator } from '../entry/src/main/ets/core/projection.ts';

const AREA = new URL('../entry/src/main/resources/rawfile/china_areas.json', import.meta.url);
parseAreaData(fs.readFileSync(AREA, 'utf8'));

const PTS: [string, number, number][] = [
  ['上海人民广场', 31.2304, 121.4737],
  ['上海外滩', 31.2397, 121.4998],
  ['上海徐家汇', 31.1948, 121.4370],
  ['苏州观前街', 31.3110, 120.6190],
  ['杭州西湖', 30.2489, 120.1500],
  ['北京天安门', 39.9042, 116.4074],
  ['北京颐和园', 39.9999, 116.2755],
  ['广州塔', 23.1066, 113.3245],
  ['深圳市民中心', 22.5431, 114.0579],
  ['香港中环', 22.2817, 114.1582],
  ['拉萨布达拉宫', 29.6577, 91.1170],
  ['乌鲁木齐', 43.8256, 87.6168],
  ['敦煌', 40.1421, 94.6618],
  ['正定', 38.1464, 114.5709],
  ['三沙永兴岛', 16.8328, 112.3383],
  ['漠河', 52.9721, 122.5388],
  ['海拉尔', 49.2122, 119.7658],
  ['哈尔滨', 45.8038, 126.5349],
  ['喀什', 39.4704, 75.9898],
  ['成都', 30.6598, 104.0657],
  ['重庆', 29.5630, 106.5516],
  ['三亚', 18.2528, 109.5119],
  ['东京', 35.6762, 139.6503]
];

const W = 360;
const H = 720;
for (const [label, lat, lon] of PTS) {
  const hit = nearestCounty(lon, lat);
  const name = hit === undefined ? '(境外/无县)' : formatPlace(hit);
  const p = projectMercator(lon, lat, W, H, [73, 18, 135, 54]);
  const inCanvas = p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
  console.log(`${label.padEnd(14)} ${name.padEnd(20)} x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} ${inCanvas ? '' : '  <-- 画布外'}`);
}
