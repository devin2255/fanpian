# 照片墙 M1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出可在真机运行的 M1——认领照片 → 滑动决策 → 收藏 → 上墙 → 地图照片墙，全部本地持久化。

**Architecture:** 纯 TypeScript `core/` 层承载全部逻辑（算法、状态机、几何/投影），既能被 ArkTS 编译又能被 Node 直接跑单测；ArkUI 只做渲染与手势。地图墙用离线 GeoJSON + 屏幕坐标聚类，先以 Node + SVG 产出可验证成果，再搬进 ArkWeb。

**Tech Stack:** HarmonyOS 7 / API 26、ArkTS、ArkUI、`@kit.MediaLibraryKit`、`@kit.ImageKit`、`@kit.CoreFileKit`、Node v22.17.1（`--experimental-strip-types --test`，零依赖测试）。

**Spec:** `docs/design.md`（随本计划一起搬进本仓库）

## Global Constraints

- 目标平台：**HarmonyOS 7（API 26）**；`compileSdkVersion` / `compatibleSdkVersion` 均为 `26.0.0`
- **禁止声明任何受限权限**（`READ_IMAGEVIDEO` / `WRITE_IMAGEVIDEO`）：声明即安装失败
- 唯一权限：`ohos.permission.MEDIA_LOCATION`，`reason` 文案为 `用于读取照片的拍摄地点，把照片挂到地图照片墙上`
- **ArkTS 硬约束**（编译器实测，违反即编译失败）：
  - 禁 `??`，用 `||`
  - 禁 `Function.apply` / `Function.call`
  - 禁 `any` / `unknown`，必须显式类型
  - `FetchResult.getFirstObjects()` **不存在** → `getFirstObject()` + 循环 `getNextObject()`（**均返回 Promise**）
  - `PhotoAsset.open()` **不存在** → `fileIo.openSync(uri, READ_ONLY)`，**必须自己 `closeSync`**
  - `FetchResult` **必须 `close()`**
  - 谓词列名用 `photoAccessHelper.PhotoKeys.URI`，不写字面量 `'uri'`
- **EXIF 坐标是度分秒字符串**（如 `"31, 14, 59.821472"`）；`REF` 可能是 `'N'/'E'` 或 ASCII `'78'/'69'`，两者都要兼容
- **照片永不复制、永不移动**：数据层只存 `photoId`（即 URI）
- **禁止在线反向地理编码**：坐标不出设备
- 不引入任何运行时依赖（无 npm 包、无手势库、无地图 SDK）
- 提交信息用 `feat:` / `fix:` / `test:` / `chore:` 前缀

## 路径约定

> ⚠️ **路径说明（搬迁时补，原文未改）**：本文档写于作者机器上，下文命令里的绝对路径是**当时实际跑过的**，
> 换一台机器时按下面的规则替换。`D:\dev\PhotoWall` = **本仓库的 clone 路径**；
> `D:\software\DevEco Studio` = **你的 DevEco Studio 安装目录**；`D:\dev\PhotoSpike` = 已被丢弃的探针工程。
> 替换后命令逐字可用（`DEVECO_SDK_HOME` 与 `hvigorw` 的用法已实测，见根 `README.md`「怎么跑」）。

- **产品工程（git 仓库、执行地点）**：`D:\dev\PhotoWall`
- **本计划与设计文档**：`docs/`（本仓库内，随代码一起版本化）
- **`core/` 物理位置**：`entry/src/main/ets/core/*.ts`（**用 `.ts` 而非 `.ets`**，这样 Node 能直接跑）
- **`ui/` 物理位置**：`entry/src/main/ets/pages/*.ets`

## 环境注意事项（执行前必读）

> ⚠️ **包名订正（搬迁时补，原文未改）**：下文 `aa start` 里的 `-b com.example.photowall` 是**计划期的旧名**，
> **从未落地**。实际 `bundleName` 是 `com.example.photospike`（理由见 `docs/decisions.md` 的"设置记录"：
> `.p7b` 调试 profile 与包名绑定，改名会使 profile 失配）。逐字可用的包名见根 `README.md`。

- 命令行编译（agent 可跑）：
  ```powershell
  Set-Location "D:\dev\PhotoWall"
  $env:DEVECO_SDK_HOME = "D:\software\DevEco Studio\sdk"
  & "D:\software\DevEco Studio\tools\node\node.exe" "D:\software\DevEco Studio\tools\hvigor\bin\hvigorw.js" `
    --mode module -p module=entry@default -p product=default assembleHap --no-daemon
  ```
- **`hdc` 不能在 agent 沙箱内运行**（密钥加载失败 → 设备 `Offline`）。所有设备操作（安装、启动、日志）**必须由用户在自有终端执行**：
  ```powershell
  cd "D:\software\DevEco Studio\sdk\default\openharmony\toolchains"
  .\hdc.exe install -r "D:\dev\PhotoWall\entry\build\default\outputs\default\entry-default-signed.hap"
  .\hdc.exe shell aa start -a EntryAbility -b com.example.photowall
  ```
- 单测（agent 可跑）：`node --experimental-strip-types --no-warnings --test`

---

### Task 1: 工程脚手架与测试基础设施

**Files:**
- Create: `D:\dev\PhotoWall\`（DevEco 空工程，用户用 IDE 生成）
- Create: `entry/src/main/ets/core/claim.ts`
- Test: `entry/src/main/ets/core/claim.test.ts`
- Create: `.gitignore`
- Create: `samples/sample.json`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface ClaimedPhoto { photoId: string; batchId: number; claimedAt: number; takenAt: number }`
  - `interface ClaimState { photos: ClaimedPhoto[]; lastBatchId: number }`
  - `emptyClaimState(): ClaimState`
  - `mergeBatch(state: ClaimState, uris: string[], now: number): ClaimState`
  - `claimStorePath(filesDir: string): string`
  - `sortByTakenDesc(photos: ClaimedPhoto[]): ClaimedPhoto[]`

> **分层规则（整个计划通用）**：`core/*.ts` **不得 import 任何 `@kit.*` 模块** —— 否则 Node 无法加载，单测就跑不起来。所有设备 API 调用放 `data/*.ets`，它们不写单测、靠真机验证。

- [ ] **Step 1: 让用户用 DevEco 建空工程**

用户在 DevEco 里：`File → New → Create Project → Application → Empty Ability`

| 字段 | 值 |
|---|---|
| Project name | `PhotoWall` |
| Bundle name | `com.example.photowall` |
| Save location | `D:\dev\PhotoWall` |
| Compatible SDK | `26` |
| Module name | `entry` |
| Device type | 仅 `Phone` |

签名用 `File → Project Structure → Signing Configs → Automatically generate signature`。

用户点一次 ▶ 确认 Hello World 跑通后才继续。

- [ ] **Step 2: 初始化 git 仓库**

```powershell
Set-Location "D:\dev\PhotoWall"
git init
git config user.name "DSH Agent"
git config user.email "agent@dsh.local"
```

创建 `.gitignore`：

```gitignore
build/
oh_modules/
.hvigor/
.idea/
node_modules/
*.hap
*.har
*.hsp
local.properties
```

- [ ] **Step 3: 写失败测试**

创建 `entry/src/main/ets/core/claim.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyClaimState, mergeBatch, claimStorePath, sortByTakenDesc } from './claim.ts';

test('空状态', () => {
  const s = emptyClaimState();
  assert.deepEqual(s.photos, []);
  assert.equal(s.lastBatchId, 0);
});

test('合并一批 URI 会自增 batchId 并保留顺序', () => {
  let s = emptyClaimState();
  s = mergeBatch(s, ['u1', 'u2'], 1000);
  assert.equal(s.photos.length, 2);
  assert.equal(s.photos[0].photoId, 'u1');
  assert.equal(s.photos[0].batchId, 1);
  assert.equal(s.photos[0].claimedAt, 1000);
  assert.equal(s.photos[0].takenAt, 0);   // EXIF 稍后回填（Task 9）
  assert.equal(s.lastBatchId, 1);
});

test('重复认领同一 URI 不产生重复项', () => {
  let s = emptyClaimState();
  s = mergeBatch(s, ['u1', 'u2'], 1000);
  s = mergeBatch(s, ['u2', 'u3'], 2000);
  assert.equal(s.photos.length, 3);
  assert.deepEqual(s.photos.map(p => p.photoId), ['u1', 'u2', 'u3']);
  assert.equal(s.lastBatchId, 2);
});

test('空 URI 被忽略', () => {
  const s = mergeBatch(emptyClaimState(), ['u1', '', 'u2'], 1);
  assert.equal(s.photos.length, 2);
});

test('claimStorePath 拼出固定文件名', () => {
  assert.equal(claimStorePath('/x').endsWith('claimed_photos.json'), true);
});

test('sortByTakenDesc：有拍摄时间的按时间倒序，无时间的排最后', () => {
  const photos = [
    { photoId: 'a', batchId: 1, claimedAt: 1, takenAt: 100 },
    { photoId: 'b', batchId: 1, claimedAt: 1, takenAt: 0 },
    { photoId: 'c', batchId: 1, claimedAt: 1, takenAt: 300 }
  ];
  const sorted = sortByTakenDesc(photos);
  assert.deepEqual(sorted.map(p => p.photoId), ['c', 'a', 'b']);
});
```

- [ ] **Step 4: 运行测试，确认失败**

```powershell
Set-Location "D:\dev\PhotoWall"
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/claim.test.ts
```

预期：FAIL —— `Cannot find module './claim.ts'`

- [ ] **Step 5: 写最小实现**

创建 `entry/src/main/ets/core/claim.ts`：

```ts
// 注意：本文件是纯逻辑，禁止 import @kit.*（否则 Node 无法加载，单测跑不起来）
export interface ClaimedPhoto {
  photoId: string;
  batchId: number;
  claimedAt: number;
  takenAt: number;   // EXIF 拍摄时间，认领时为 0，Task 9 回填
}

export interface ClaimState {
  photos: ClaimedPhoto[];
  lastBatchId: number;
}

export function emptyClaimState(): ClaimState {
  return { photos: [], lastBatchId: 0 };
}

export function mergeBatch(state: ClaimState, uris: string[], now: number): ClaimState {
  const batchId = state.lastBatchId + 1;
  const seen: Set<string> = new Set();
  for (let i = 0; i < state.photos.length; i++) {
    seen.add(state.photos[i].photoId);
  }
  const photos: ClaimedPhoto[] = state.photos.slice();
  for (let i = 0; i < uris.length; i++) {
    const u = uris[i];
    if (u === '' || seen.has(u)) { continue; }
    seen.add(u);
    photos.push({ photoId: u, batchId: batchId, claimedAt: now, takenAt: 0 });
  }
  return { photos: photos, lastBatchId: batchId };
}

export function claimStorePath(filesDir: string): string {
  return `${filesDir}/claimed_photos.json`;
}

/** takenAt 为 0（未读 EXIF）的排到最后 */
export function sortByTakenDesc(photos: ClaimedPhoto[]): ClaimedPhoto[] {
  const withTime = photos.filter((p: ClaimedPhoto) => p.takenAt > 0);
  const noTime = photos.filter((p: ClaimedPhoto) => p.takenAt <= 0);
  withTime.sort((a: ClaimedPhoto, b: ClaimedPhoto) => b.takenAt - a.takenAt);
  return withTime.concat(noTime);
}
```

- [ ] **Step 6: 运行测试，确认通过**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/claim.test.ts
```

预期：PASS，6 个测试全绿。

> **为什么测试里没有落盘测试**：`core/claim.ts` 保持纯净（不 import `@kit.*`），所以它能被 Node 直接加载。落盘逻辑放在 Task 6 的 `data/claimStore.ets`，靠真机验证"杀掉 App 重开计数不变"。

- [ ] **Step 7: 编译验证（ArkTS 侧）**

```powershell
Set-Location "D:\dev\PhotoWall"
$env:DEVECO_SDK_HOME = "D:\software\DevEco Studio\sdk"
& "D:\software\DevEco Studio\tools\node\node.exe" "D:\software\DevEco Studio\tools\hvigor\bin\hvigorw.js" --mode module -p module=entry@default -p product=default assembleHap --no-daemon
```

预期：`BUILD SUCCESSFUL`（`core/*.test.ts` 不应进入 HAP；若被编译报错，在 `entry/build-profile.json5` 的 `buildOption` 里加 `"sourceOption": { "excludes": ["**/*.test.ts"] }`）

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "chore: 工程脚手架 + claim 纯逻辑与 Node 测试基础设施"
```

---

### Task 2: 地点归一（geo 纯逻辑）

**Files:**
- Create: `entry/src/main/ets/core/geo.ts`
- Test: `entry/src/main/ets/core/geo.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface GeoPoint { lat: number; lon: number }`
  - `interface Pin { id: string; name: string; lat: number; lon: number; kind: PinKind }`
  - `type PinKind = 'gps' | 'manual' | 'named'`
  - `EARTH_RADIUS_M: number`
  - `haversineMeters(a: GeoPoint, b: GeoPoint): number`
  - `dmsToDecimal(dms: string): number`
  - `applyRef(dec: number, ref: string): number`
  - `parseExifCoord(dms: string, ref: string): number`
  - `clusterPoints(points: GeoPoint[], thresholdM: number): number[][]`（返回点索引分组）
  - `medianPoint(points: GeoPoint[]): GeoPoint`
  - `dedupePins(pins: Pin[], thresholdM: number): Pin[]`（用户 `manual` / `named` 的钉优先保留）

- [ ] **Step 1: 写失败测试**

创建 `entry/src/main/ets/core/geo.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试，确认失败**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/geo.test.ts
```

预期：FAIL —— `Cannot find module './geo.ts'`

- [ ] **Step 3: 写最小实现**

创建 `entry/src/main/ets/core/geo.ts`：

```ts
export type PinKind = 'gps' | 'manual' | 'named';

export interface GeoPoint { lat: number; lon: number }

export interface Pin {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: PinKind;
}

export const EARTH_RADIUS_M = 6371000;

const DEG = Math.PI / 180;

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * s2 * s2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function dmsToDecimal(dms: string): number {
  if (dms === undefined || dms === null || dms === '') { return NaN; }
  const norm = dms.replace(/，/g, ',');
  const parts = norm.split(',');
  if (parts.length < 3) { return NaN; }
  const d = parseFloat(parts[0].trim());
  const m = parseFloat(parts[1].trim());
  const s = parseFloat(parts[2].trim());
  if (Number.isNaN(d) || Number.isNaN(m) || Number.isNaN(s)) { return NaN; }
  return d + m / 60 + s / 3600;
}

export function applyRef(dec: number, ref: string): number {
  if (Number.isNaN(dec) || ref === undefined || ref === null || ref === '') { return dec; }
  const r = ref.trim().toUpperCase();
  const neg = (r === 'S' || r === 'W' || r === '83' || r === '87');
  return neg ? -dec : dec;
}

export function parseExifCoord(dms: string, ref: string): number {
  return applyRef(dmsToDecimal(dms), ref);
}

export function clusterPoints(points: GeoPoint[], thresholdM: number): number[][] {
  const n = points.length;
  const parent: number[] = [];
  for (let i = 0; i < n; i++) { parent.push(i); }
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) { r = parent[r]; }
    return r;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (haversineMeters(points[i], points[j]) <= thresholdM) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) { parent[rj] = ri; }
      }
    }
  }
  const buckets: Map<number, number[]> = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = buckets.get(r);
    if (arr === undefined) { buckets.set(r, [i]); } else { arr.push(i); }
  }
  const out: number[][] = [];
  buckets.forEach((v: number[]) => { out.push(v); });
  return out;
}

export function medianPoint(points: GeoPoint[]): GeoPoint {
  if (points.length === 0) { return { lat: 0, lon: 0 }; }
  const lats = points.map((p: GeoPoint) => p.lat).sort((a: number, b: number) => a - b);
  const lons = points.map((p: GeoPoint) => p.lon).sort((a: number, b: number) => a - b);
  const mid = Math.floor(points.length / 2);
  const lat = points.length % 2 === 1 ? lats[mid] : (lats[mid - 1] + lats[mid]) / 2;
  const lon = points.length % 2 === 1 ? lons[mid] : (lons[mid - 1] + lons[mid]) / 2;
  return { lat: lat, lon: lon };
}

export function dedupePins(pins: Pin[], thresholdM: number): Pin[] {
  // 用户钉（manual/named）优先保留；把 gps 钉并进最近的用户钉
  const userPins = pins.filter((p: Pin) => p.kind !== 'gps');
  const gpsPins = pins.filter((p: Pin) => p.kind === 'gps');
  const kept: Pin[] = userPins.slice();

  for (let i = 0; i < gpsPins.length; i++) {
    const g = gpsPins[i];
    let merged = false;
    for (let j = 0; j < userPins.length; j++) {
      if (haversineMeters(g, userPins[j]) <= thresholdM) { merged = true; break; }
    }
    if (merged) { continue; }
    // 与已保留的 gps 钉去重
    let dup = false;
    for (let j = 0; j < kept.length; j++) {
      if (haversineMeters(g, kept[j]) <= thresholdM) {
        dup = true;
        break;
      }
    }
    if (!dup) { kept.push(g); }
  }
  return kept;
}
```

- [ ] **Step 4: 运行测试，确认通过**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/geo.test.ts
```

预期：PASS，9 个测试全绿。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: geo 纯逻辑（haversine / 度分秒换算 / 500m 聚类 / 中位数取点）"
```

---

### Task 3: 地图自适应聚散规则 + 投影（placement / projection）

**Files:**
- Create: `entry/src/main/ets/core/projection.ts`
- Create: `entry/src/main/ets/core/placement.ts`
- Test: `entry/src/main/ets/core/placement.test.ts`

**Interfaces:**
- Consumes: `GeoPoint`, `Pin`（Task 2）
- Produces:
  - `interface Region { id: string; name: string; geojson: string; bounds: number[]; }`
  - `interface Projected { x: number; y: number }`
  - `projectMercator(lon: number, lat: number, w: number, h: number, bounds: number[]): Projected`
  - `interface PlacedPin { pinId: string; x: number; y: number }`
  - `interface PinLayout { pinId: string; expanded: boolean; count: number }`
  - `computeLayout(pins: PlacedPin[], counts: Map<string, number>, zoom: number): PinLayout[]`
  - `clusterByScreen(placed: PlacedPin[], minDistPt: number): number[][]`
  - `MAX_HANG = 9`、`COLLAPSE_THRESHOLD = 15`、`EXPAND_ALL_MAX = 3`、`MIN_PIN_DIST_PT = 40`

- [ ] **Step 1: 写失败测试**

创建 `entry/src/main/ets/core/placement.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, clusterByScreen, MAX_HANG, EXPAND_ALL_MAX, COLLAPSE_THRESHOLD }
  from './placement.ts';
import { projectMercator } from './projection.ts';

const counts = (pairs: [string, number][]): Map<string, number> => {
  const m = new Map<string, number>();
  pairs.forEach(([k, v]) => m.set(k, v));
  return m;
};

test('≤3 个钉：全部展开（张数封顶 9）', () => {
  const pins = [
    { pinId: 'a', x: 0, y: 0 },
    { pinId: 'b', x: 200, y: 0 }
  ];
  const out = computeLayout(pins, counts([['a', 20], ['b', 2]]), 1);
  assert.equal(out.length, 2);
  assert.equal(out[0].expanded, true);
  assert.ok(out[0].count <= MAX_HANG);
  assert.equal(out[1].expanded, true);
});

test('4–15 个钉：只有张数 ≥3 的展开', () => {
  const pins: { pinId: string; x: number; y: number }[] = [];
  const c: [string, number][] = [];
  for (let i = 0; i < 5; i++) { pins.push({ pinId: `p${i}`, x: i * 200, y: 0 }); c.push([`p${i}`, i]); }
  const out = computeLayout(pins, counts(c), 1);
  // p0=0, p1=1, p2=2 不展开；p3=3, p4=4 展开
  assert.equal(out[0].expanded, false);
  assert.equal(out[1].expanded, false);
  assert.equal(out[2].expanded, false);
  assert.equal(out[3].expanded, true);
  assert.equal(out[4].expanded, true);
});

test('>15 个钉：全部收成钉', () => {
  const pins: { pinId: string; x: number; y: number }[] = [];
  const c: [string, number][] = [];
  for (let i = 0; i < COLLAPSE_THRESHOLD + 1; i++) {
    pins.push({ pinId: `p${i}`, x: i * 300, y: 0 });
    c.push([`p${i}`, 50]);
  }
  const out = computeLayout(pins, counts(c), 1);
  assert.equal(out.every((l) => !l.expanded), true);
});

test('缩放过小：忽略展开态', () => {
  const pins = [{ pinId: 'a', x: 0, y: 0 }];
  const out = computeLayout(pins, counts([['a', 10]]), 0.2);
  assert.equal(out[0].expanded, false);
});

test('clusterByScreen：40pt 内合并', () => {
  const placed = [
    { pinId: 'a', x: 100, y: 100 },
    { pinId: 'b', x: 120, y: 110 },   // 距 a 约 22pt → 合并
    { pinId: 'c', x: 400, y: 400 }    // 远 → 独立
  ];
  const groups = clusterByScreen(placed, 40);
  assert.equal(groups.length, 2);
});

test('projectMercator：bounds 四角映射到画布四角', () => {
  const bounds = [73, 18, 135, 54];   // 中国大致范围
  const tl = projectMercator(73, 54, 1000, 800, bounds);
  const br = projectMercator(135, 18, 1000, 800, bounds);
  assert.ok(Math.abs(tl.x - 0) < 1 && Math.abs(tl.y - 0) < 1);
  assert.ok(Math.abs(br.x - 1000) < 1 && Math.abs(br.y - 800) < 1);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/placement.test.ts
```

预期：FAIL —— 找不到模块。

- [ ] **Step 3: 实现 projection.ts**

创建 `entry/src/main/ets/core/projection.ts`：

```ts
export interface Region {
  id: string;
  name: string;
  geojson: string;
  bounds: number[];   // [minLon, minLat, maxLon, maxLat]
}

export interface Projected { x: number; y: number }

export const CHINA_REGION: Region = {
  id: 'china',
  name: '中国',
  geojson: 'assets/geo/china.json',
  bounds: [73, 18, 135, 54]
};

const DEG = Math.PI / 180;

function mercY(lat: number): number {
  const clamped = Math.max(-85, Math.min(85, lat));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2));
}

export function projectMercator(
  lon: number, lat: number, w: number, h: number, bounds: number[]
): Projected {
  const minLon = bounds[0];
  const minLat = bounds[1];
  const maxLon = bounds[2];
  const maxLat = bounds[3];
  const x = ((lon - minLon) / (maxLon - minLon)) * w;
  const yTop = mercY(maxLat);
  const yBottom = mercY(minLat);
  const y = ((yTop - mercY(lat)) / (yTop - yBottom)) * h;
  return { x: x, y: y };
}
```

- [ ] **Step 4: 实现 placement.ts**

创建 `entry/src/main/ets/core/placement.ts`：

```ts
export const MAX_HANG = 9;
export const EXPAND_ALL_MAX = 3;
export const COLLAPSE_THRESHOLD = 15;
export const MIN_PIN_DIST_PT = 40;
export const MIN_ZOOM_FOR_EXPAND = 0.5;

export interface PlacedPin { pinId: string; x: number; y: number }
export interface PinLayout { pinId: string; expanded: boolean; count: number }

export function computeLayout(
  pins: PlacedPin[], counts: Map<string, number>, zoom: number
): PinLayout[] {
  const out: PinLayout[] = [];
  const tooSmall = zoom < MIN_ZOOM_FOR_EXPAND;
  const collapsed = pins.length > COLLAPSE_THRESHOLD;

  for (let i = 0; i < pins.length; i++) {
    const p = pins[i];
    const raw = counts.get(p.pinId);
    const n = raw === undefined ? 0 : raw;
    let expanded = false;
    if (!tooSmall && !collapsed) {
      if (pins.length <= EXPAND_ALL_MAX) {
        expanded = n > 0;
      } else {
        expanded = n >= 3;
      }
    }
    out.push({ pinId: p.pinId, expanded: expanded, count: Math.min(n, MAX_HANG) });
  }
  return out;
}

export function clusterByScreen(placed: PlacedPin[], minDistPt: number): number[][] {
  const n = placed.length;
  const parent: number[] = [];
  for (let i = 0; i < n; i++) { parent.push(i); }
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) { r = parent[r]; }
    return r;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = placed[i].x - placed[j].x;
      const dy = placed[i].y - placed[j].y;
      if (Math.sqrt(dx * dx + dy * dy) <= minDistPt) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) { parent[rj] = ri; }
      }
    }
  }
  const buckets: Map<number, number[]> = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = buckets.get(r);
    if (arr === undefined) { buckets.set(r, [i]); } else { arr.push(i); }
  }
  const out: number[][] = [];
  buckets.forEach((v: number[]) => { out.push(v); });
  return out;
}
```

- [ ] **Step 5: 运行测试，确认通过**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/placement.test.ts
```

预期：PASS，6 个测试全绿。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat: 地图自适应聚散规则与墨卡托投影（阈值落成可测常量）"
```

---

### Task 4: 决策状态机与队列

**Files:**
- Create: `entry/src/main/ets/core/queue.ts`
- Test: `entry/src/main/ets/core/queue.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type DecisionState = 'unseen' | 'archived' | 'faved' | 'walled'`
  - `interface Decision { photoId: string; state: DecisionState; decidedAt: number; deferCount: number }`
  - `interface QueueInput { photoId: string; takenAt: number }`
  - `emptyDecision(photoId: string): Decision`
  - `applyDecision(d: Decision, action: Action, now: number): Decision`
  - `type Action = 'archive' | 'fav' | 'wall' | 'unfav' | 'unwall' | 'skip'`
  - `buildQueue(all: QueueInput[], decisions: Map<string, Decision>, todayMemories: QueueInput[]): QueueInput[]`
  - `DEFER_PROMOTE_AT = 3`
  - `MAX_MEMORY_INJECT = 2`

- [ ] **Step 1: 写失败测试**

创建 `entry/src/main/ets/core/queue.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDecision, applyDecision, buildQueue, DEFER_PROMOTE_AT }
  from './queue.ts';
import type { Decision } from './queue.ts';

test('初始状态 unseen，deferCount 0', () => {
  const d = emptyDecision('p1');
  assert.equal(d.state, 'unseen');
  assert.equal(d.deferCount, 0);
});

test('右滑收藏 → faved', () => {
  const d = applyDecision(emptyDecision('p1'), 'fav', 100);
  assert.equal(d.state, 'faved');
  assert.equal(d.decidedAt, 100);
});

test('左滑归档 → archived（不是删除）', () => {
  assert.equal(applyDecision(emptyDecision('p1'), 'archive', 1).state, 'archived');
});

test('上墙 → walled', () => {
  assert.equal(applyDecision(emptyDecision('p1'), 'wall', 1).state, 'walled');
});

test('跳过 → 回到 unseen 且 deferCount +1', () => {
  const d = applyDecision(emptyDecision('p1'), 'skip', 1);
  assert.equal(d.state, 'unseen');
  assert.equal(d.deferCount, 1);
});

test('取消收藏 → 回到 unseen，deferCount 不变', () => {
  const faved = applyDecision(emptyDecision('p1'), 'fav', 1);
  const out = applyDecision(faved, 'unfav', 2);
  assert.equal(out.state, 'unseen');
  assert.equal(out.deferCount, 0);
});

test('摘墙 → 回到 faved（不是 unseen）', () => {
  const walled = applyDecision(emptyDecision('p1'), 'wall', 1);
  assert.equal(applyDecision(walled, 'unwall', 2).state, 'faved');
});

test('队列按拍摄时间倒序，已决策的不出现', () => {
  const all = [
    { photoId: 'old', takenAt: 100 },
    { photoId: 'new', takenAt: 300 },
    { photoId: 'mid', takenAt: 200 }
  ];
  const decisions = new Map<string, Decision>();
  decisions.set('mid', applyDecision(emptyDecision('mid'), 'archive', 1));
  const q = buildQueue(all, decisions, []);
  assert.deepEqual(q.map((x) => x.photoId), ['new', 'old']);
});

test('跳过 3 次以上的排到最前', () => {
  const all = [
    { photoId: 'a', takenAt: 100 },
    { photoId: 'b', takenAt: 300 },
    { photoId: 'c', takenAt: 200 }
  ];
  const decisions = new Map<string, Decision>();
  let d = emptyDecision('a');
  for (let i = 0; i < DEFER_PROMOTE_AT; i++) { d = applyDecision(d, 'skip', i); }
  decisions.set('a', d);
  const q = buildQueue(all, decisions, []);
  assert.equal(q[0].photoId, 'a');
});

test('今日回忆插在队首之后，且不超过上限', () => {
  const all = [{ photoId: 'a', takenAt: 300 }];
  const mem = [{ photoId: 'm1', takenAt: 1 }, { photoId: 'm2', takenAt: 2 }];
  const q = buildQueue(all, new Map<string, Decision>(), mem);
  assert.equal(q.length, 3);
  assert.equal(q[0].photoId, 'a');
  assert.ok(q.some((x) => x.photoId === 'm1'));
});
```

- [ ] **Step 2: 运行测试，确认失败**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/queue.test.ts
```

预期：FAIL —— 找不到模块。

- [ ] **Step 3: 写最小实现**

创建 `entry/src/main/ets/core/queue.ts`：

```ts
export type DecisionState = 'unseen' | 'archived' | 'faved' | 'walled';

export type Action = 'archive' | 'fav' | 'wall' | 'unfav' | 'unwall' | 'skip';

export interface Decision {
  photoId: string;
  state: DecisionState;
  decidedAt: number;
  deferCount: number;
}

export interface QueueInput { photoId: string; takenAt: number }

export const DEFER_PROMOTE_AT = 3;
export const MAX_MEMORY_INJECT = 2;

export function emptyDecision(photoId: string): Decision {
  return { photoId: photoId, state: 'unseen', decidedAt: 0, deferCount: 0 };
}

export function applyDecision(d: Decision, action: Action, now: number): Decision {
  if (action === 'archive') {
    return { photoId: d.photoId, state: 'archived', decidedAt: now, deferCount: d.deferCount };
  }
  if (action === 'fav') {
    return { photoId: d.photoId, state: 'faved', decidedAt: now, deferCount: d.deferCount };
  }
  if (action === 'wall') {
    return { photoId: d.photoId, state: 'walled', decidedAt: now, deferCount: d.deferCount };
  }
  if (action === 'unfav' || action === 'unwall') {
    const back: DecisionState = action === 'unwall' ? 'faved' : 'unseen';
    return { photoId: d.photoId, state: back, decidedAt: now, deferCount: d.deferCount };
  }
  // skip：重新入队
  return { photoId: d.photoId, state: 'unseen', decidedAt: now, deferCount: d.deferCount + 1 };
}

export function buildQueue(
  all: QueueInput[], decisions: Map<string, Decision>, todayMemories: QueueInput[]
): QueueInput[] {
  const pending: QueueInput[] = [];
  const promoted: QueueInput[] = [];

  for (let i = 0; i < all.length; i++) {
    const item = all[i];
    const d = decisions.get(item.photoId);
    if (d === undefined) {
      pending.push(item);
      continue;
    }
    if (d.state !== 'unseen') { continue; }
    if (d.deferCount >= DEFER_PROMOTE_AT) { promoted.push(item); } else { pending.push(item); }
  }

  pending.sort((a: QueueInput, b: QueueInput) => b.takenAt - a.takenAt);
  promoted.sort((a: QueueInput, b: QueueInput) => b.takenAt - a.takenAt);

  const out: QueueInput[] = [];
  const head = pending.length > 0 ? [pending[0]] : [];
  for (let i = 0; i < head.length; i++) { out.push(head[i]); }
  for (let i = 0; i < promoted.length; i++) { out.push(promoted[i]); }
  const memN = Math.min(todayMemories.length, MAX_MEMORY_INJECT);
  for (let i = 0; i < memN; i++) { out.push(todayMemories[i]); }
  for (let i = 1; i < pending.length; i++) { out.push(pending[i]); }
  return out;
}
```

- [ ] **Step 4: 运行测试，确认通过**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/queue.test.ts
```

预期：PASS，10 个测试全绿。

- [ ] **Step 5: 把三套测试一起跑，确认无回归**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/
```

预期：全部 PASS。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat: 决策状态机与队列（跳过后重新入队、跳多次前插、回忆注入）"
```

---

### Task 5: 验收指标埋点（纯逻辑）

**Files:**
- Create: `entry/src/main/ets/core/metrics.ts`
- Test: `entry/src/main/ets/core/metrics.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface SwipeEvent { photoId: string; shownAt: number; decidedAt: number; action: string; rolledBack: boolean }`
  - `emptyMetrics(): MetricsState`
  - `recordSwipe(m: MetricsState, e: SwipeEvent): MetricsState`
  - `medianDecisionMs(m: MetricsState): number`
  - `rollbackRate(m: MetricsState): number`
  - `wallConversion(faved: number, walled: number): number`
  - `interface MetricsState { events: SwipeEvent[] }`

- [ ] **Step 1: 写失败测试**

创建 `entry/src/main/ets/core/metrics.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate, wallConversion }
  from './metrics.ts';

const ev = (decidedAt: number, shownAt: number, rolledBack = false) =>
  ({ photoId: 'p', shownAt, decidedAt, action: 'fav', rolledBack });

test('空状态中位数为 0', () => {
  assert.equal(medianDecisionMs(emptyMetrics()), 0);
});

test('决策间隔中位数取中间值', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(1000, 0));    // 1000
  m = recordSwipe(m, ev(2200, 0));    // 2200
  m = recordSwipe(m, ev(1500, 0));    // 1500
  assert.equal(medianDecisionMs(m), 1500);
});

test('偶数个取中间两个的平均', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(1000, 0));
  m = recordSwipe(m, ev(2000, 0));
  assert.equal(medianDecisionMs(m), 1500);
});

test('回弹率 = 回弹数 / 总数', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(1000, 0, true));
  m = recordSwipe(m, ev(1000, 0, false));
  m = recordSwipe(m, ev(1000, 0, false));
  m = recordSwipe(m, ev(1000, 0, false));
  assert.ok(Math.abs(rollbackRate(m) - 0.25) < 1e-9);
});

test('上墙转化率', () => {
  assert.ok(Math.abs(wallConversion(100, 20) - 0.2) < 1e-9);
});

test('收藏为 0 时转化率为 0，不除零', () => {
  assert.equal(wallConversion(0, 0), 0);
});

test('shownAt 晚于 decidedAt 时忽略该样本', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(500, 1000));
  assert.equal(m.events.length, 0);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/metrics.test.ts
```

预期：FAIL —— 找不到模块。

- [ ] **Step 3: 写最小实现**

创建 `entry/src/main/ets/core/metrics.ts`：

```ts
export interface SwipeEvent {
  photoId: string;
  shownAt: number;
  decidedAt: number;
  action: string;
  rolledBack: boolean;
}

export interface MetricsState { events: SwipeEvent[] }

export function emptyMetrics(): MetricsState {
  return { events: [] };
}

export function recordSwipe(m: MetricsState, e: SwipeEvent): MetricsState {
  if (e.decidedAt < e.shownAt) { return m; }   // 脏数据丢弃
  const events = m.events.slice();
  events.push(e);
  return { events: events };
}

export function medianDecisionMs(m: MetricsState): number {
  const n = m.events.length;
  if (n === 0) { return 0; }
  const arr = m.events
    .map((e: SwipeEvent) => e.decidedAt - e.shownAt)
    .sort((a: number, b: number) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

export function rollbackRate(m: MetricsState): number {
  const n = m.events.length;
  if (n === 0) { return 0; }
  let rb = 0;
  for (let i = 0; i < n; i++) { if (m.events[i].rolledBack) { rb++; } }
  return rb / n;
}

export function wallConversion(faved: number, walled: number): number {
  if (faved <= 0) { return 0; }
  return walled / faved;
}
```

- [ ] **Step 4: 运行测试，确认通过**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/metrics.test.ts
```

预期：PASS，7 个测试全绿。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 验收指标埋点纯逻辑（决策间隔中位数/回弹率/上墙转化率）"
```

---

### Task 6: 认领流程接通真机（Picker → 落盘 → 展示）

**Files:**
- Create: `entry/src/main/ets/data/claimStore.ets`
- Modify: `entry/src/main/module.json5`（只加 `MEDIA_LOCATION`）
- Modify: `entry/src/main/resources/base/element/string.json`
- Create: `entry/src/main/ets/pages/ClaimPage.ets`
- Modify: `entry/src/main/resources/base/profile/main_pages.json`

**Interfaces:**
- Consumes: `ClaimState`, `emptyClaimState`, `mergeBatch`, `claimStorePath`, `sortByTakenDesc`（Task 1）
- Produces:
  - `class ClaimStore { constructor(ctx: common.UIAbilityContext); load(): ClaimState; save(s: ClaimState): void; addBatch(uris: string[], now: number): ClaimState; count(): number }`
  - `pickPhotos(): Promise<string[]>`（封装 `PhotoViewPicker`，`maxSelectNumber = 500`）

- [ ] **Step 1: 加权限声明**

在 `entry/src/main/module.json5` 的 `module` 对象里插入（与 `abilities` 同级）：

```json5
"requestPermissions": [
  {
    "name": "ohos.permission.MEDIA_LOCATION",
    "reason": "$string:reason_media_location",
    "usedScene": { "abilities": ["EntryAbility"], "when": "inuse" }
  }
],
```

**不要声明 `READ_IMAGEVIDEO` / `WRITE_IMAGEVIDEO`** —— 声明即安装失败。

在 `entry/src/main/resources/base/element/string.json` 的 `string` 数组里加：

```json
{ "name": "reason_media_location", "value": "用于读取照片的拍摄地点，把照片挂到地图照片墙上" }
```

- [ ] **Step 2: 写 claimStore.ets**

```ts
import { common } from '@kit.AbilityKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ClaimState, emptyClaimState, mergeBatch } from '../core/claim';
import { fileIo } from '@kit.CoreFileKit';

export function claimStorePath(filesDir: string): string {
  return `${filesDir}/claimed_photos.json`;
}

export async function pickPhotos(): Promise<string[]> {
  const picker = new photoAccessHelper.PhotoViewPicker();
  const opt: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
  opt.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
  opt.maxSelectNumber = 500;
  const result: photoAccessHelper.PhotoSelectResult = await picker.select(opt);
  return result.photoUris;
}

export class ClaimStore {
  private ctx: common.UIAbilityContext;

  constructor(ctx: common.UIAbilityContext) {
    this.ctx = ctx;
  }

  load(): ClaimState {
    try {
      const path = claimStorePath(this.ctx.filesDir);
      const st = fileIo.statSync(path);
      const buf = new ArrayBuffer(st.size);
      const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      try {
        fileIo.readSync(file.fd, buf);
      } finally {
        fileIo.closeSync(file);
      }
      const bytes = new Uint8Array(buf);
      let text = '';
      for (let i = 0; i < bytes.length; i++) { text += String.fromCharCode(bytes[i]); }
      const parsed = JSON.parse(text) as ClaimState;
      if (parsed === null || parsed.photos === undefined) { return emptyClaimState(); }
      return parsed;
    } catch (e) {
      return emptyClaimState();
    }
  }

  save(s: ClaimState): void {
    const file = fileIo.openSync(claimStorePath(this.ctx.filesDir),
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, JSON.stringify(s));
    } finally {
      fileIo.closeSync(file);
    }
  }

  addBatch(uris: string[], now: number): ClaimState {
    const next = mergeBatch(this.load(), uris, now);
    this.save(next);
    return next;
  }

  count(): number {
    return this.load().photos.length;
  }
}
```

- [ ] **Step 3: 写 ClaimPage.ets**

```ts
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ClaimStore, pickPhotos } from '../data/claimStore';

@Entry
@Component
struct ClaimPage {
  @State claimed: number = 0;
  @State msg: string = '';
  private ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
  private store: ClaimStore = new ClaimStore(this.ctx);

  aboutToAppear(): void {
    this.claimed = this.store.count();
  }

  build() {
    Column({ space: 16 }) {
      Text('照片墙').fontSize(26).fontWeight(FontWeight.Bold)
      Text(`已认领 ${this.claimed} 张照片`).fontSize(15).fontColor('#666')
      Text('先认领一批照片。建议挑选一次旅行，这样马上就能看到地图墙。')
        .fontSize(13).fontColor('#999').textAlign(TextAlign.Center).padding({ left: 32, right: 32 })

      Button('认领照片')
        .fontSize(16).height(46).width(200)
        .onClick(() => { this.doPick(); })

      Text(this.msg).fontSize(12).fontColor('#D33')
    }
    .width('100%').height('100%').justifyContent(FlexAlign.Center)
  }

  private async doPick(): Promise<void> {
    try {
      const uris: string[] = await pickPhotos();
      if (uris.length === 0) { this.msg = '没有选中照片'; return; }
      const next = this.store.addBatch(uris, Date.now());
      this.claimed = next.photos.length;
      this.msg = `本次认领 ${uris.length} 张，累计 ${next.photos.length} 张`;
    } catch (e) {
      const err = e as BusinessError;
      this.msg = `认领失败：${err.code} ${err.message}`;
    }
  }
}
```

- [ ] **Step 4: 注册页面**

`entry/src/main/resources/base/profile/main_pages.json`：

```json
{ "src": ["pages/ClaimPage"] }
```

- [ ] **Step 5: 编译**

```powershell
Set-Location "D:\dev\PhotoWall"
$env:DEVECO_SDK_HOME = "D:\software\DevEco Studio\sdk"
& "D:\software\DevEco Studio\tools\node\node.exe" "D:\software\DevEco Studio\tools\hvigor\bin\hvigorw.js" --mode module -p module=entry@default -p product=default assembleHap --no-daemon
```

预期：`BUILD SUCCESSFUL`。若报 `arkts-*` 错误，逐条按 Global Constraints 修正。

- [ ] **Step 6: 真机验证（需用户执行）**

用户在自己的终端跑：

```powershell
cd "D:\software\DevEco Studio\sdk\default\openharmony\toolchains"
.\hdc.exe install -r "D:\dev\PhotoWall\entry\build\default\outputs\default\entry-default-signed.hap"
.\hdc.exe shell aa start -a EntryAbility -b com.example.photowall
```

**验收标准**：点「认领照片」→ 选 10 张以上 → 显示"本次认领 N 张，累计 N 张" → **杀掉 App 重开，累计数不变**（证明落盘生效）。

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat: 认领流程（Picker 多选 + URI 落盘 + 计数展示）"
```

---

### Task 7: 滑动卡片（原生手势 + 弹簧回弹 + 埋点）

**Files:**
- Create: `entry/src/main/ets/pages/SwipePage.ets`
- Create: `entry/src/main/ets/ui/CardStack.ets`
- Modify: `entry/src/main/resources/base/profile/main_pages.json`

**Interfaces:**
- Consumes: `Decision`, `Action`, `applyDecision`, `emptyDecision`（Task 4）；`MetricsState`, `recordSwipe`（Task 5）
- Produces:
  - `@Component CardStack` 参数：`items: QueueItem[]`、`onDecide: (photoId: string, action: Action, rolledBack: boolean) => void`
  - `COMMIT_VELOCITY = 800`（pt/s）、`COMMIT_DISTANCE_RATIO = 0.28`、`SPRING_BACK_MS = 150`

- [ ] **Step 1: 实现 CardStack.ets（手势核心）**

```ts
export const COMMIT_VELOCITY = 800;
export const COMMIT_DISTANCE_RATIO = 0.28;
export const SPRING_BACK_MS = 150;

@Component
export struct CardStack {
  @Prop item: QueueItem;
  onDecide: (photoId: string, action: string, rolledBack: boolean) => void = () => {};
  @State dx: number = 0;
  @State dy: number = 0;
  @State animating: boolean = false;
  private lastX: number = 0;
  private lastT: number = 0;
  private velocity: number = 0;
  private startT: number = 0;

  aboutToAppear(): void {
    this.startT = Date.now();
    this.dx = 0;
    this.dy = 0;
    this.velocity = 0;
  }

  build() {
    Column() {
      // 照片本体（真实实现里从 URI 解码，这里用占位控件）
      Image(this.item.thumbUri)
        .width('100%').height('100%')
        .objectFit(ImageFit.Cover)
        .borderRadius(16)
    }
    .width('86%').height('62%')
    .backgroundColor('#EEE')
    .borderRadius(16)
    .translate({ x: this.dx, y: this.dy })
    .rotate({ angle: this.dx / 24 })
    .gesture(
      PanGesture({ fingers: 1, distance: 5 })
        .onActionStart((e: GestureEvent) => {
          this.lastX = e.offsetX;
          this.lastT = Date.now();
          this.velocity = 0;
        })
        .onActionUpdate((e: GestureEvent) => {
          const now = Date.now();
          const dt = now - this.lastT;
          if (dt > 0) { this.velocity = ((e.offsetX - this.lastX) / dt) * 1000; }
          this.lastX = e.offsetX;
          this.lastT = now;
          this.dx = e.offsetX;
          this.dy = e.offsetY;
        })
        .onActionEnd((e: GestureEvent) => { this.settle(); })
    )
  }

  private settle(): void {
    const w = 360;   // 卡片参考宽度，用真实宽度替换
    const commitDist = w * COMMIT_DISTANCE_RATIO;
    const fast = Math.abs(this.velocity) > COMMIT_VELOCITY;
    const far = Math.abs(this.dx) > commitDist;

    if (this.dx > 0 && (fast || far)) {
      this.flyOut(1);
    } else if (this.dx < 0 && (fast || far)) {
      this.flyOut(-1);
    } else {
      this.springBack();
    }
  }

  private flyOut(dir: number): void {
    this.animating = true;
    animateTo({ duration: 220, curve: Curve.EaseOut }, () => {
      this.dx = dir * 600;
      this.dy = this.dy + 40;
    });
    // 动画结束后回调；rollback=false 表示真的生效了
    setTimeout(() => {
      this.onDecide(this.item.photoId, dir > 0 ? 'fav' : 'archive', false);
      this.dx = 0;
      this.dy = 0;
      this.animating = false;
    }, 230);
  }

  private springBack(): void {
    // 回弹 = 用户犹豫过，计入回弹率
    this.onDecide(this.item.photoId, 'none', true);
    animateTo({ duration: SPRING_BACK_MS, curve: Curve.Friction }, () => {
      this.dx = 0;
      this.dy = 0;
    });
  }
}
```

- [ ] **Step 2: 实现 SwipePage.ets（串起队列与埋点）**

```ts
import { common } from '@kit.AbilityKit';
import { ClaimStore } from '../data/claimStore';
import { CardStack } from '../ui/CardStack';
import { Decision, emptyDecision, applyDecision, QueueInput } from '../core/queue';
import { MetricsState, emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate } from '../core/metrics';

interface QueueItem { photoId: string; thumbUri: string }

@Entry
@Component
struct SwipePage {
  @State items: QueueItem[] = [];
  @State idx: number = 0;
  @State medianMs: number = 0;
  @State rollbackPct: number = 0;
  private decisions: Map<string, Decision> = new Map();
  private metrics: MetricsState = emptyMetrics();
  private shownAt: number = Date.now();
  private ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;

  aboutToAppear(): void {
    const store = new ClaimStore(this.ctx);
    const claimed = store.load();
    const q: QueueItem[] = claimed.photos.map((p) => ({ photoId: p.photoId, thumbUri: p.photoId }));
    // 真实实现：用 EXIF 拍摄时间排序（Task 9），这里先按认领顺序倒序
    this.items = q.reverse();
    this.idx = 0;
    this.shownAt = Date.now();
  }

  build() {
    Column() {
      Row() {
        Text(`剩余 ${this.items.length - this.idx}`).fontSize(13).fontColor('#666').layoutWeight(1)
        Text(`中位 ${this.medianMs}ms  回弹 ${this.rollbackPct}%`).fontSize(12).fontColor('#999')
      }.width('100%').padding(12)

      Stack() {
        if (this.idx < this.items.length) {
          CardStack({
            item: this.items[this.idx],
            onDecide: (photoId: string, action: string, rolledBack: boolean) => {
              this.handle(photoId, action, rolledBack);
            }
          })
        } else {
          Text('今天的份刷完了').fontSize(18).fontColor('#666')
        }
      }.layoutWeight(1).width('100%')
    }
    .width('100%').height('100%').backgroundColor('#FAFAFA')
  }

  private handle(photoId: string, action: string, rolledBack: boolean): void {
    const now = Date.now();
    this.metrics = recordSwipe(this.metrics, {
      photoId: photoId, shownAt: this.shownAt, decidedAt: now,
      action: action, rolledBack: rolledBack
    });
    this.medianMs = Math.round(medianDecisionMs(this.metrics));
    this.rollbackPct = Math.round(rollbackRate(this.metrics) * 100);

    if (rolledBack) { return; }   // 回弹不消耗队列

    const prev = this.decisions.get(photoId);
    const d = prev === undefined ? emptyDecision(photoId) : prev;
    const nextAction = action === 'fav' ? 'fav' : 'archive';
    this.decisions.set(photoId, applyDecision(d, nextAction, now));
    this.idx = this.idx + 1;
    this.shownAt = Date.now();
  }
}
```

- [ ] **Step 3: 注册页面**

`main_pages.json`：

```json
{ "src": ["pages/SwipePage", "pages/ClaimPage"] }
```

把 `EntryAbility` 的首个页面改为 `pages/SwipePage`（或在 `ClaimPage` 里加一个「开始刷」按钮 `router.pushUrl({ url: 'pages/SwipePage' })`）。**采用后者**：`main_pages.json` 保持 `["pages/ClaimPage", "pages/SwipePage"]`，在 `ClaimPage` 的按钮区加：

```ts
Button('开始刷照片').fontSize(16).height(46).width(200)
  .onClick(() => { router.pushUrl({ url: 'pages/SwipePage' }); })
```

并在 `ClaimPage.ets` 顶部加 `import { router } from '@kit.ArkUI';`

- [ ] **Step 4: 编译**

```powershell
Set-Location "D:\dev\PhotoWall"
$env:DEVECO_SDK_HOME = "D:\software\DevEco Studio\sdk"
& "D:\software\DevEco Studio\tools\node\node.exe" "D:\software\DevEco Studio\tools\hvigor\bin\hvigorw.js" --mode module -p module=entry@default -p product=default assembleHap --no-daemon
```

预期：`BUILD SUCCESSFUL`。

- [ ] **Step 5: 真机验证（需用户执行）**

```powershell
cd "D:\software\DevEco Studio\sdk\default\openharmony\toolchains"
.\hdc.exe install -r "D:\dev\PhotoWall\entry\build\default\outputs\default\entry-default-signed.hap"
.\hdc.exe shell aa start -a EntryAbility -b com.example.photowall
```

**验收标准**：
1. 左滑右滑都能把卡片甩出去，**不出现卡在一半**
2. 轻轻一甩也能过（速度阈值生效）
3. 拖一点松手会**弹回原位**，且顶部"回弹 X%"计数增加
4. 顶部"中位 XXXms"会随操作变化

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat: 滑动卡片（PanGesture + 速度阈值 + 弹簧回弹 + 指标埋点）"
```

---

### Task 8: 决策落盘 + 收藏页 + 上墙窗口期

**Files:**
- Create: `entry/src/main/ets/data/decisionStore.ets`
- Create: `entry/src/main/ets/pages/FavPage.ets`
- Modify: `entry/src/main/ets/pages/SwipePage.ets`（接上墙按钮）
- Modify: `entry/src/main/resources/base/profile/main_pages.json`

**Interfaces:**
- Consumes: `Decision`, `applyDecision`（Task 4）
- Produces:
  - `class DecisionStore { loadAll(): Map<string, Decision>; saveAll(m: Map<string, Decision>): void; set(d: Decision): void; favedIds(): string[]; walledIds(): string[] }`
  - `WALL_PROMPT_MS = 4000`
  - `FavPage` 组件；`SwipePage` 新增 `@State wallPromptFor: string`

- [ ] **Step 1: 写 decisionStore.ets**

```ts
import { common } from '@kit.AbilityKit';
import { Decision } from '../core/queue';
import { fileIo } from '@kit.CoreFileKit';

function pathOf(filesDir: string): string {
  return `${filesDir}/decisions.json`;
}

export class DecisionStore {
  private ctx: common.UIAbilityContext;

  constructor(ctx: common.UIAbilityContext) { this.ctx = ctx; }

  loadAll(): Map<string, Decision> {
    const m = new Map<string, Decision>();
    try {
      const path = pathOf(this.ctx.filesDir);
      const st = fileIo.statSync(path);
      const buf = new ArrayBuffer(st.size);
      const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      try { fileIo.readSync(file.fd, buf); } finally { fileIo.closeSync(file); }
      const bytes = new Uint8Array(buf);
      let text = '';
      for (let i = 0; i < bytes.length; i++) { text += String.fromCharCode(bytes[i]); }
      const arr = JSON.parse(text) as Decision[];
      for (let i = 0; i < arr.length; i++) { m.set(arr[i].photoId, arr[i]); }
    } catch (e) { /* 首次运行无文件 */ }
    return m;
  }

  saveAll(m: Map<string, Decision>): void {
    const arr: Decision[] = [];
    m.forEach((v: Decision) => { arr.push(v); });
    const file = fileIo.openSync(pathOf(this.ctx.filesDir),
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try { fileIo.writeSync(file.fd, JSON.stringify(arr)); } finally { fileIo.closeSync(file); }
  }

  set(d: Decision): void {
    const m = this.loadAll();
    m.set(d.photoId, d);
    this.saveAll(m);
  }

  favedIds(): string[] {
    const out: string[] = [];
    this.loadAll().forEach((d: Decision) => { if (d.state === 'faved' || d.state === 'walled') { out.push(d.photoId); } });
    return out;
  }

  walledIds(): string[] {
    const out: string[] = [];
    this.loadAll().forEach((d: Decision) => { if (d.state === 'walled') { out.push(d.photoId); } });
    return out;
  }
}
```

- [ ] **Step 2: SwipePage 接上墙窗口期**

在 `SwipePage.ets` 里加状态与逻辑：

```ts
export const WALL_PROMPT_MS = 4000;
```

`SwipePage` 内新增：

```ts
@State wallPromptFor: string = '';
private wallTimer: number = -1;
private dStore: DecisionStore = new DecisionStore(this.ctx);
```

在 `handle()` 里，`action === 'fav'` 生效后：

```ts
this.wallPromptFor = photoId;
if (this.wallTimer !== -1) { clearTimeout(this.wallTimer); }
this.wallTimer = setTimeout(() => { this.wallPromptFor = ''; }, WALL_PROMPT_MS);
```

在 build 的 Stack 里、卡片下方浮出按钮：

```ts
if (this.wallPromptFor !== '') {
  Button('挂上墙')
    .fontSize(15).height(42).width(160)
    .backgroundColor('#1F6FEB')
    .margin({ bottom: 32 })
    .align(Alignment.Bottom)
    .onClick(() => { this.promoteToWall(); })
}
```

```ts
private promoteToWall(): void {
  const id = this.wallPromptFor;
  if (id === '') { return; }
  const prev = this.decisions.get(id);
  const d = prev === undefined ? emptyDecision(id) : prev;
  const next = applyDecision(d, 'wall', Date.now());
  this.decisions.set(id, next);
  this.dStore.set(next);
  this.wallPromptFor = '';
}
```

并把 `handle()` 里生效的决策同步落盘：`this.dStore.set(this.decisions.get(photoId)!);`（用局部变量取出来，避免 `!` 断言，ArkTS 不接受非空断言 —— 改为先取 `const saved = this.decisions.get(photoId); if (saved !== undefined) { this.dStore.set(saved); }`）

- [ ] **Step 3: 写 FavPage.ets**

```ts
import { common } from '@kit.AbilityKit';
import { DecisionStore } from '../data/decisionStore';
import { Decision } from '../core/queue';

@Entry
@Component
struct FavPage {
  @State faved: string[] = [];
  @State walled: string[] = [];
  private store: DecisionStore = new DecisionStore(getContext(this) as common.UIAbilityContext);

  aboutToAppear(): void {
    this.faved = this.store.favedIds();
    this.walled = this.store.walledIds();
  }

  build() {
    Column() {
      Text(`收藏 ${this.faved.length} 张 ｜ 已上墙 ${this.walled.length} 张`)
        .fontSize(15).fontWeight(FontWeight.Medium).padding(16)
      Grid() {
        ForEach(this.faved, (uri: string) => {
          GridItem() {
            Stack({ alignContent: Alignment.TopEnd }) {
              Image(uri).width('100%').height('100%').objectFit(ImageFit.Cover).borderRadius(8)
              if (this.walled.indexOf(uri) >= 0) {
                Text('墙上').fontSize(10).fontColor(Color.White)
                  .backgroundColor('#1F6FEB').borderRadius(6).padding({ left: 5, right: 5 })
                  .margin(4)
              }
            }
          }
        }, (uri: string) => uri)
      }
      .columnsTemplate('1fr 1fr 1fr').columnsGap(8).rowsGap(8)
      .layoutWeight(1).width('100%').padding({ left: 12, right: 12 })
    }
    .width('100%').height('100%').backgroundColor('#FAFAFA')
  }
}
```

- [ ] **Step 4: 注册页面 + 编译**

`main_pages.json` 改为：

```json
{ "src": ["pages/ClaimPage", "pages/SwipePage", "pages/FavPage"] }
```

```powershell
Set-Location "D:\dev\PhotoWall"
$env:DEVECO_SDK_HOME = "D:\software\DevEco Studio\sdk"
& "D:\software\DevEco Studio\tools\node\node.exe" "D:\software\DevEco Studio\tools\hvigor\bin\hvigorw.js" --mode module -p module=entry@default -p product=default assembleHap --no-daemon
```

- [ ] **Step 5: 真机验证（需用户执行）**

```powershell
cd "D:\software\DevEco Studio\sdk\default\openharmony\toolchains"
.\hdc.exe install -r "D:\dev\PhotoWall\entry\build\default\outputs\default\entry-default-signed.hap"
.\hdc.exe shell aa start -a EntryAbility -b com.example.photowall
```

**验收标准**：
1. 右滑后卡片下方浮出「挂上墙」按钮，**4 秒后自动消失**
2. 4 秒内点击 → 该照片在收藏页显示"墙上"角标
3. 收藏页的"已上墙"计数与操作一致
4. 杀掉 App 重开，**收藏与上墙状态都还在**

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat: 决策落盘 + 收藏页 + 上墙 4 秒窗口期"
```

---

### Task 9: EXIF 读取（时间 + GPS）接进队列与地图

**Files:**
- Create: `entry/src/main/ets/data/exifReader.ts`
- Test: `entry/src/main/ets/core/exifParse.test.ts`
- Create: `entry/src/main/ets/core/exifParse.ts`

**Interfaces:**
- Consumes: `parseExifCoord`（Task 2）；`ClaimedPhoto`、`ClaimState`、`sortByTakenDesc`（Task 1）
- Produces:
  - `interface ExifInfo { takenAt: number; lat: number; lon: number; hasGps: boolean }`
  - `parseExifTime(s: string): number`（把 `"2026:10:08 14:48:49"` 转成 epoch ms，失败返回 0）
  - `readExif(uri: string): Promise<ExifInfo>`（在 `data/exifReader.ts`，用 `fileIo` + `ImageSource`）
  - `interface LocationEntry { photoId: string; lat: number; lon: number; takenAt: number }`
  - `class LocationIndex { load(): LocationEntry[]; save(list: LocationEntry[]): void; buildFrom(uris: string[], onProgress?: (done: number, total: number) => void): Promise<LocationEntry[]> }`（在 `data/locationIndex.ets`）
  - `locationIndexPath(filesDir: string): string`

- [ ] **Step 1: 写失败测试（纯解析部分）**

创建 `entry/src/main/ets/core/exifParse.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExifTime } from './exifParse.ts';

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
```

- [ ] **Step 2: 运行测试，确认失败**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/exifParse.test.ts
```

预期：FAIL —— 找不到模块。

- [ ] **Step 3: 实现 exifParse.ts**

```ts
export interface ExifInfo {
  takenAt: number;
  lat: number;
  lon: number;
  hasGps: boolean;
}

export function parseExifTime(s: string): number {
  if (s === undefined || s === null || s === '') { return 0; }
  const norm = s.trim().replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  const t = Date.parse(norm.replace(' ', 'T'));
  if (Number.isNaN(t)) { return 0; }
  return t;
}
```

- [ ] **Step 4: 运行测试，确认通过**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/exifParse.test.ts
```

预期：PASS，4 个测试全绿。

- [ ] **Step 5: 实现 exifReader.ts（设备侧，不可单测）**

```ts
import { image } from '@kit.ImageKit';
import { fileIo } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ExifInfo, parseExifTime } from '../core/exifParse';
import { parseExifCoord } from '../core/geo';

export async function readExif(uri: string): Promise<ExifInfo> {
  const empty: ExifInfo = { takenAt: 0, lat: 0, lon: 0, hasGps: false };
  let file: fileIo.File | undefined = undefined;
  let src: image.ImageSource | undefined = undefined;
  try {
    file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    src = image.createImageSource(file.fd);
  } catch (e) {
    return empty;
  }
  try {
    const props = await src.getImageProperties([
      image.PropertyKey.DATE_TIME,
      image.PropertyKey.GPS_LATITUDE,
      image.PropertyKey.GPS_LATITUDE_REF,
      image.PropertyKey.GPS_LONGITUDE,
      image.PropertyKey.GPS_LONGITUDE_REF
    ]);
    const t = props[image.PropertyKey.DATE_TIME];
    const la = props[image.PropertyKey.GPS_LATITUDE];
    const lo = props[image.PropertyKey.GPS_LONGITUDE];
    const lar = props[image.PropertyKey.GPS_LATITUDE_REF];
    const lor = props[image.PropertyKey.GPS_LONGITUDE_REF];

    const takenAt = (t === undefined || t === null) ? 0 : parseExifTime(String(t));
    let lat = 0;
    let lon = 0;
    let hasGps = false;
    if (la !== undefined && la !== null && lo !== undefined && lo !== null) {
      const latS = String(la);
      const lonS = String(lo);
      if (latS !== '' && lonS !== '') {
        lat = parseExifCoord(latS, (lar === undefined || lar === null) ? '' : String(lar));
        lon = parseExifCoord(lonS, (lor === undefined || lor === null) ? '' : String(lor));
        hasGps = !Number.isNaN(lat) && !Number.isNaN(lon) && (lat !== 0 || lon !== 0);
      }
    }
    return { takenAt: takenAt, lat: lat, lon: lon, hasGps: hasGps };
  } catch (e) {
    return empty;
  } finally {
    if (src !== undefined) { try { src.release(); } catch (e) { /* 忽略 */ } }
    if (file !== undefined) { try { fileIo.closeSync(file); } catch (e) { /* 忽略 */ } }
  }
}
```

- [ ] **Step 6: 实现 locationIndex.ets（地点索引，避免每次进地图页重读 EXIF）**

创建 `entry/src/main/ets/data/locationIndex.ets`：

```ts
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { readExif } from './exifReader';

export interface LocationEntry {
  photoId: string;
  lat: number;
  lon: number;
  takenAt: number;
}

export function locationIndexPath(filesDir: string): string {
  return `${filesDir}/locations.json`;
}

export class LocationIndex {
  private ctx: common.UIAbilityContext;

  constructor(ctx: common.UIAbilityContext) { this.ctx = ctx; }

  load(): LocationEntry[] {
    try {
      const path = locationIndexPath(this.ctx.filesDir);
      const st = fileIo.statSync(path);
      const buf = new ArrayBuffer(st.size);
      const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      try { fileIo.readSync(file.fd, buf); } finally { fileIo.closeSync(file); }
      const bytes = new Uint8Array(buf);
      let text = '';
      for (let i = 0; i < bytes.length; i++) { text += String.fromCharCode(bytes[i]); }
      return JSON.parse(text) as LocationEntry[];
    } catch (e) {
      return [];
    }
  }

  save(list: LocationEntry[]): void {
    const file = fileIo.openSync(locationIndexPath(this.ctx.filesDir),
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try { fileIo.writeSync(file.fd, JSON.stringify(list)); } finally { fileIo.closeSync(file); }
  }

  /** 只处理索引里没有的 URI（增量），读完即落盘 */
  async buildFrom(uris: string[], onProgress?: (done: number, total: number) => void): Promise<LocationEntry[]> {
    const existing = this.load();
    const known: Set<string> = new Set();
    for (let i = 0; i < existing.length; i++) { known.add(existing[i].photoId); }

    const todo = uris.filter((u: string) => !known.has(u));
    for (let i = 0; i < todo.length; i++) {
      const ex = await readExif(todo[i]);
      existing.push({ photoId: todo[i], lat: ex.lat, lon: ex.lon, takenAt: ex.takenAt });
      if (onProgress !== undefined) { onProgress(i + 1, todo.length); }
    }
    this.save(existing);
    return existing;
  }
}
```

- [ ] **Step 7: 编译并验证（用户执行安装）**

```powershell
Set-Location "D:\dev\PhotoWall"
$env:DEVECO_SDK_HOME = "D:\software\DevEco Studio\sdk"
& "D:\software\DevEco Studio\tools\node\node.exe" "D:\software\DevEco Studio\tools\hvigor\bin\hvigorw.js" --mode module -p module=entry@default -p product=default assembleHap --no-daemon
```

**验收标准**：在 `SwipePage` 的 `aboutToAppear` 里调用 `new LocationIndex(this.ctx).buildFrom(claimed.photos.map(p => p.photoId))`，然后用 `hilog` 打印索引条数和其中 `lat !== 0` 的条数。用户跑：

```powershell
cd "D:\software\DevEco Studio\sdk\default\openharmony\toolchains"
.\hdc.exe shell hilog | Select-String "photowall"
```

预期：能看到"索引 N 条，其中带 GPS M 条"，且 N 等于认领总数。

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat: EXIF 读取与地点索引（fileIo + ImageSource 绕开 medialibrary，增量构建）"
```

---

### Task 10: 地图照片墙渲染（Node 可验证的视觉产出）

**Files:**
- Create: `entry/src/main/ets/core/render.ts`
- Test: `entry/src/main/ets/core/render.test.ts`
- Create: `tools/render-preview.ts`（Node 脚本，产出 SVG）
- Create: `assets/geo/china.json`（用户放入，或用简化占位）

**Interfaces:**
- Consumes: `Pin`、`GeoPoint`（Task 2）；`projectMercator`、`Region`（Task 3）；`computeLayout`、`clusterByScreen`（Task 3）
- Produces:
  - `interface WallPhoto { photoId: string; lat: number; lon: number; takenAt: number }`
  - `interface ScenePin { pinId: string; name: string; x: number; y: number; photos: WallPhoto[] }`
  - `buildScene(pins: ScenePin[], w: number, h: number, zoom: number): ScenePin[]`（应用聚散规则，给每个要展开的钉算照片落点）
  - `hangOffsets(n: number, spread: number): { dx: number; dy: number }[]`（**弧形排布**，不是垂直）
  - `sceneToSvg(pins: ScenePin[], w: number, h: number, chinaPath: string): string`

- [ ] **Step 1: 写失败测试**

创建 `entry/src/main/ets/core/render.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hangOffsets, buildScene } from './render.ts';
import type { ScenePin } from './render.ts';

test('弧形排布：照片不重叠，且越靠边越往上（像风铃）', () => {
  const offs = hangOffsets(5, 60);
  assert.equal(offs.length, 5);
  for (let i = 1; i < offs.length; i++) {
    assert.ok(offs[i].dx > offs[i - 1].dx, 'dx 应递增');
  }
  // 两侧 dy 小于中间（弧形）
  const mid = offs[Math.floor(offs.length / 2)];
  assert.ok(offs[0].dy < mid.dy || offs[offs.length - 1].dy < mid.dy);
});

test('1 张照片时居中不偏移', () => {
  const offs = hangOffsets(1, 60);
  assert.equal(offs.length, 1);
  assert.equal(offs[0].dx, 0);
});

test('buildScene 按规则决定展开', () => {
  const pins: ScenePin[] = [
    { pinId: 'a', name: 'A', x: 100, y: 100, photos: [
      { photoId: 'p1', lat: 1, lon: 1, takenAt: 1 },
      { photoId: 'p2', lat: 1, lon: 1, takenAt: 2 },
      { photoId: 'p3', lat: 1, lon: 1, takenAt: 3 }
    ]},
    { pinId: 'b', name: 'B', x: 500, y: 300, photos: [
      { photoId: 'p4', lat: 2, lon: 2, takenAt: 4 }
    ]}
  ];
  const scene = buildScene(pins, 800, 600, 1);
  assert.equal(scene.length, 2);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/render.test.ts
```

预期：FAIL —— 找不到模块。

- [ ] **Step 3: 实现 render.ts**

```ts
import { MAX_HANG } from './placement';

export interface WallPhoto { photoId: string; lat: number; lon: number; takenAt: number }

export interface ScenePin {
  pinId: string;
  name: string;
  x: number;
  y: number;
  photos: WallPhoto[];
}

export const PHOTO_SIZE_PT = 54;
export const HANG_DROP_PT = 96;

/** 弧形排布：中部最低、两侧抬高，形似风铃 */
export function hangOffsets(n: number, spread: number): { dx: number; dy: number }[] {
  const out: { dx: number; dy: number }[] = [];
  if (n <= 0) { return out; }
  if (n === 1) { out.push({ dx: 0, dy: HANG_DROP_PT }); return out; }
  const step = spread / (n - 1);
  const start = -spread / 2;
  const maxLift = 18;
  for (let i = 0; i < n; i++) {
    const dx = start + step * i;
    // 归一化到 [-1,1]，中部 0 → 抬升 0，两侧 → 抬升 maxLift
    const t = (dx / (spread / 2));
    const dy = HANG_DROP_PT - maxLift * (t * t);
    out.push({ dx: dx, dy: dy });
  }
  return out;
}

export function buildScene(pins: ScenePin[], w: number, h: number, zoom: number): ScenePin[] {
  const out: ScenePin[] = [];
  const many = pins.length > 15;
  for (let i = 0; i < pins.length; i++) {
    const p = pins[i];
    const expand = !many && zoom >= 0.5 && (pins.length <= 3 ? p.photos.length > 0 : p.photos.length >= 3);
    const photos = expand ? p.photos.slice(0, MAX_HANG) : [];
    out.push({ pinId: p.pinId, name: p.name, x: p.x, y: p.y, photos: photos });
  }
  return out;
}

/** 产出可独立打开的 SVG，用于在 Node 上验证视觉，不依赖设备 */
export function sceneToSvg(pins: ScenePin[], w: number, h: number, chinaPath: string): string {
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);
  parts.push(`<rect width="${w}" height="${h}" fill="#0e0f12"/>`);
  parts.push(`<path d="${chinaPath}" fill="#1b2735" stroke="#2f4256" stroke-width="1"/>`);

  for (let i = 0; i < pins.length; i++) {
    const p = pins[i];
    if (p.photos.length > 0) {
      const offs = hangOffsets(p.photos.length, Math.min(120, p.photos.length * 26));
      for (let j = 0; j < p.photos.length; j++) {
        const px = p.x + offs[j].dx;
        const py = p.y + offs[j].dy;
        // 垂线
        parts.push(`<line x1="${p.x}" y1="${p.y}" x2="${px}" y2="${py}" stroke="#3d556e" stroke-width="1"/>`);
        // 照片占位（真实实现用 <image> 指向缩略图）
        parts.push(`<rect x="${px - PHOTO_SIZE_PT / 2}" y="${py}" width="${PHOTO_SIZE_PT}" height="${PHOTO_SIZE_PT}" rx="6" fill="#7aa2c8" stroke="#dfe9f3"/>`);
      }
    }
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="4" fill="#ffb15c"/>`);
    parts.push(`<text x="${p.x + 8}" y="${p.y - 6}" fill="#9fb3c8" font-size="11" font-family="sans-serif">${p.name} (${p.photos.length})</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}
```

- [ ] **Step 4: 运行测试，确认通过**

```powershell
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings --test entry/src/main/ets/core/render.test.ts
```

预期：PASS，3 个测试全绿。

- [ ] **Step 5: 生成中国轮廓 SVG path（离线，不引入地图 SDK）**

创建 `tools/make-china-path.ts`：

```ts
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { projectMercator, CHINA_REGION } from '../entry/src/main/ets/core/projection.ts';

const W = 900;
const H = 700;

// 输入：GeoJSON（FeatureCollection 或 Geometry）。可从公开数据集获取，
// 例如 Natural Earth 1:50m 的 admin_0_countries 中 China 的多边形。
// 本脚本只做「经纬度 → 屏幕坐标 → SVG path」，不下载数据。
const src = process.argv[2];
if (!src) {
  console.error('用法: node --experimental-strip-types tools/make-china-path.ts <china.geojson>');
  process.exit(1);
}

const geo = JSON.parse(readFileSync(src, 'utf8'));

function ringToPath(ring: number[][]): string {
  const parts: string[] = [];
  for (let i = 0; i < ring.length; i++) {
    const lon = ring[i][0];
    const lat = ring[i][1];
    const p = projectMercator(lon, lat, W, H, CHINA_REGION.bounds);
    parts.push(`${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

const paths: string[] = [];
const features = geo.type === 'FeatureCollection' ? geo.features : [{ geometry: geo }];
for (let i = 0; i < features.length; i++) {
  const g = features[i].geometry;
  if (!g) { continue; }
  if (g.type === 'Polygon') {
    for (let r = 0; r < g.coordinates.length; r++) { paths.push(ringToPath(g.coordinates[r])); }
  } else if (g.type === 'MultiPolygon') {
    for (let p = 0; p < g.coordinates.length; p++) {
      for (let r = 0; r < g.coordinates[p].length; r++) { paths.push(ringToPath(g.coordinates[p][r])); }
    }
  }
}

const out = paths.join(' ');
writeFileSync('assets/geo/china_path.txt', out, 'utf8');
console.log(`已写出 assets/geo/china_path.txt（${out.length} 字符，${paths.length} 个环）`);
```

**获取 GeoJSON**（任选其一，都是离线文件）：
- 从公开数据集下载中国边界 GeoJSON（Natural Earth / 阿里云 DataV.GeoAtlas 等），存为 `assets/geo/china.geojson`
- 若暂时拿不到，**跳过这一步**：`WallPage` 会自动退化为矩形轮廓，垂线挂照片的核心机制照样能验证

运行：

```powershell
Set-Location "D:\dev\PhotoWall"
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings tools/make-china-path.ts assets/geo/china.geojson
```

预期：`已写出 assets/geo/china_path.txt（... 字符，N 个环）`

**把生成的路径装进应用**：在 `ClaimPage` 的 `aboutToAppear` 里，首次运行时把 `china_path.txt` 从 rawfile 复制到 `filesDir`：

```ts
private async ensureChinaPath(): Promise<void> {
  const dest = `${this.ctx.filesDir}/china_path.txt`;
  try { fileIo.statSync(dest); return; } catch (e) { /* 需要复制 */ }
  try {
    const data: Uint8Array = await this.ctx.resourceManager.getRawFileContent('geo/china_path.txt');
    const f = fileIo.openSync(dest, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try { fileIo.writeSync(f.fd, data.buffer as ArrayBuffer); } finally { fileIo.closeSync(f); }
  } catch (e) { /* 没放就退化用矩形 */ }
}
```

同时把 `assets/geo/china_path.txt` 复制到 `entry/src/main/resources/rawfile/geo/china_path.txt`。

- [ ] **Step 6: 写 Node 预览脚本**

创建 `tools/render-preview.ts`：

```ts
import { writeFileSync } from 'node:fs';
import { buildScene, sceneToSvg } from '../entry/src/main/ets/core/render.ts';
import { projectMercator, CHINA_REGION } from '../entry/src/main/ets/core/projection.ts';

const W = 900;
const H = 700;

const raw: { name: string; lon: number; lat: number; n: number }[] = [
  { name: '上海', lon: 121.4813, lat: 31.2495, n: 6 },
  { name: '北京', lon: 116.4074, lat: 39.9042, n: 3 },
  { name: '杭州', lon: 120.1551, lat: 30.2741, n: 2 },
  { name: '西安', lon: 108.9398, lat: 34.3416, n: 1 },
  { name: '成都', lon: 104.0665, lat: 30.5723, n: 4 }
];

const pins = raw.map((r, i) => {
  const pt = projectMercator(r.lon, r.lat, W, H, CHINA_REGION.bounds);
  const photos = [];
  for (let k = 0; k < r.n; k++) {
    photos.push({ photoId: `p${i}_${k}`, lat: r.lat, lon: r.lon, takenAt: k });
  }
  return { pinId: `pin${i}`, name: r.name, x: pt.x, y: pt.y, photos: photos };
});

// 中国轮廓用矩形占位；拿到真实 GeoJSON 后替换
const placeholderPath = 'M 40 80 L 860 80 L 860 620 L 40 620 Z';
const scene = buildScene(pins, W, H, 1);
writeFileSync('tools/preview.svg', sceneToSvg(scene, W, H, placeholderPath), 'utf8');
console.log('已写出 tools/preview.svg');
```

- [ ] **Step 7: 生成预览并在浏览器查看**

```powershell
Set-Location "D:\dev\PhotoWall"
& "D:\software\nodejs\node.exe" --experimental-strip-types --no-warnings tools/render-preview.ts
```

预期：打印 `已写出 tools/preview.svg`。用浏览器打开该文件，**看到 5 个地点的钉、以及从钉垂下的弧形照片列**。

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat: 地图墙场景构建与弧形挂照片（Node 产出 SVG 预览可独立验证）"
```

---

### Task 11: 地图墙搬进 ArkWeb

**Files:**
- Create: `entry/src/main/resources/rawfile/map/index.html`
- Create: `entry/src/main/ets/pages/WallPage.ets`
- Modify: `entry/src/main/resources/base/profile/main_pages.json`

**Interfaces:**
- Consumes: `ScenePin`、`buildScene`、`sceneToSvg`（Task 10）；`DecisionStore.walledIds()`（Task 8）；`LocationIndex`、`LocationEntry`（Task 9）
- Produces: `WallPage` 组件；HTML 侧 `window.__setScene(json: string)` 入口

- [ ] **Step 1: 写 HTML 宿主**

创建 `entry/src/main/resources/rawfile/map/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>
  html, body { margin: 0; padding: 0; background: #0e0f12; overflow: hidden; }
  #stage { width: 100vw; height: 100vh; }
  .pin-label { fill: #9fb3c8; font: 11px sans-serif; }
  .hangline { stroke: #3d556e; stroke-width: 1; }
  .photo { fill: #7aa2c8; stroke: #dfe9f3; }
</style>
</head>
<body>
<div id="stage"></div>
<script>
  // 原生侧通过 runJavaScript 调用 window.__setScene(svgString)
  window.__setScene = function (svg) {
    document.getElementById('stage').innerHTML = svg;
  };
  window.__ready = true;
</script>
</body>
</html>
```

- [ ] **Step 2: 写 WallPage.ets**

```ts
import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { DecisionStore } from '../data/decisionStore';
import { LocationIndex, LocationEntry } from '../data/locationIndex';
import { buildScene, sceneToSvg, ScenePin, WallPhoto } from '../core/render';
import { projectMercator, CHINA_REGION } from '../core/projection';
import { clusterPoints, medianPoint, GeoPoint } from '../core/geo';

const VIEW_W = 900;
const VIEW_H = 700;

@Entry
@Component
struct WallPage {
  @State info: string = '正在构建地图墙…';
  private ctrl: webview.WebviewController = new webview.WebviewController();
  private ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;

  build() {
    Column() {
      Text(this.info).fontSize(12).fontColor('#888').padding(8).width('100%')
      Web({ src: $rawfile('map/index.html'), controller: this.ctrl })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .width('100%').layoutWeight(1)
        .onPageEnd(() => { this.buildAndPush(); })
    }
    .width('100%').height('100%').backgroundColor('#0e0f12')
  }

  private async buildAndPush(): Promise<void> {
    const walled = new DecisionStore(this.ctx).walledIds();
    if (walled.length === 0) {
      this.info = '墙上还没有照片';
      return;
    }

    // 从地点索引取坐标（不重读 EXIF）
    const index = new LocationIndex(this.ctx).load();
    const byId: Map<string, LocationEntry> = new Map();
    for (let i = 0; i < index.length; i++) { byId.set(index[i].photoId, index[i]); }

    const withGps: LocationEntry[] = [];
    for (let i = 0; i < walled.length; i++) {
      const e = byId.get(walled[i]);
      if (e !== undefined && e.lat !== 0 && e.lon !== 0) { withGps.push(e); }
    }
    if (withGps.length === 0) {
      this.info = `${walled.length} 张已上墙，但都没有定位信息`;
      return;
    }

    // 500 米聚类成钉（用中位数取点，抗离群）
    const pts: GeoPoint[] = withGps.map((e: LocationEntry) => ({ lat: e.lat, lon: e.lon }));
    const groups = clusterPoints(pts, 500);

    const pins: ScenePin[] = [];
    for (let g = 0; g < groups.length; g++) {
      const idxs = groups[g];
      const groupPts: GeoPoint[] = idxs.map((k: number) => pts[k]);
      const center = medianPoint(groupPts);
      const pt = projectMercator(center.lon, center.lat, VIEW_W, VIEW_H, CHINA_REGION.bounds);
      const photos: WallPhoto[] = idxs.map((k: number) => ({
        photoId: withGps[k].photoId,
        lat: withGps[k].lat,
        lon: withGps[k].lon,
        takenAt: withGps[k].takenAt
      }));
      pins.push({ pinId: `pin${g}`, name: `${photos.length} 张`, x: pt.x, y: pt.y, photos: photos });
    }

    const scene = buildScene(pins, VIEW_W, VIEW_H, 1);
    // 地图轮廓：先用 assets/geo 的路径，缺失时退化为矩形占位
    const svg = sceneToSvg(scene, VIEW_W, VIEW_H, this.chinaPath());
    try {
      await this.ctrl.runJavaScript(`window.__setScene(${JSON.stringify(svg)})`);
      this.info = `${pins.length} 个地点，共 ${withGps.length} 张照片上墙`;
    } catch (e) {
      this.info = `渲染失败：${(e as BusinessError).code}`;
    }
  }

  private chinaPath(): string {
    // Task 10 生成的简化轮廓路径（存在则读取，否则用矩形占位）
    try {
      const st = fileIo.statSync(`${this.ctx.filesDir}/china_path.txt`);
      const buf = new ArrayBuffer(st.size);
      const f = fileIo.openSync(`${this.ctx.filesDir}/china_path.txt`, fileIo.OpenMode.READ_ONLY);
      try { fileIo.readSync(f.fd, buf); } finally { fileIo.closeSync(f); }
      const bytes = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
      if (s.trim() !== '') { return s.trim(); }
    } catch (e) { /* 落到占位 */ }
    return 'M 40 80 L 860 80 L 860 620 L 40 620 Z';
  }
}
```

在 `WallPage.ets` 顶部补上 `import { fileIo } from '@kit.CoreFileKit';`

- [ ] **Step 3: 注册页面并编译**

`main_pages.json`：

```json
{ "src": ["pages/ClaimPage", "pages/SwipePage", "pages/FavPage", "pages/WallPage"] }
```

```powershell
Set-Location "D:\dev\PhotoWall"
$env:DEVECO_SDK_HOME = "D:\software\DevEco Studio\sdk"
& "D:\software\DevEco Studio\tools\node\node.exe" "D:\software\DevEco Studio\tools\hvigor\bin\hvigorw.js" --mode module -p module=entry@default -p product=default assembleHap --no-daemon
```

- [ ] **Step 4: 真机验证（需用户执行）**

```powershell
cd "D:\software\DevEco Studio\sdk\default\openharmony\toolchains"
.\hdc.exe install -r "D:\dev\PhotoWall\entry\build\default\outputs\default\entry-default-signed.hap"
.\hdc.exe shell aa start -a EntryAbility -b com.example.photowall
```

**验收标准**：在收藏页点一张已上墙的照片进入地图墙，**看到钉 + 垂线 + 垂挂的照片**；顶部显示"N 个地点，共 M 张照片上墙"。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 地图墙接入 ArkWeb（rawfile 宿主 + runJavaScript 推场景）"
```

---

### Task 12: 指标达标验证与手感调优

**Files:**
- Modify: `entry/src/main/ets/ui/CardStack.ets`（调参）
- Modify: `entry/src/main/ets/pages/SwipePage.ets`（展示三项指标）
- Create: `docs/measurements.md`（记录实测数据）

**Interfaces:**
- Consumes: `medianDecisionMs`、`rollbackRate`、`wallConversion`（Task 5）
- Produces: 实测指标记录；调优后的 `COMMIT_VELOCITY` / `COMMIT_DISTANCE_RATIO` / `WALL_PROMPT_MS`

- [ ] **Step 1: 在 SwipePage 顶部展示三项指标**

把顶部状态行改为：

```ts
Row() {
  Text(`剩余 ${this.items.length - this.idx}`).fontSize(13).fontColor('#666').layoutWeight(1)
  Text(`中位 ${this.medianMs}ms ｜ 回弹 ${this.rollbackPct}% ｜ 上墙 ${this.wallPct}%`)
    .fontSize(11).fontColor('#999')
}.width('100%').padding(12)
```

并在 `handle()` 与 `promoteToWall()` 之后刷新：

```ts
private refreshMetrics(): void {
  this.medianMs = Math.round(medianDecisionMs(this.metrics));
  this.rollbackPct = Math.round(rollbackRate(this.metrics) * 100);
  const faved = this.dStore.favedIds().length;
  const walled = this.dStore.walledIds().length;
  this.wallPct = Math.round(wallConversion(faved, walled) * 100);
}
```

新增 `@State wallPct: number = 0;` 并在 `promoteToWall()` 末尾调用 `this.refreshMetrics();`

- [ ] **Step 2: 编译并安装（用户执行）**

同 Task 11 Step 4 的命令。

- [ ] **Step 3: 用户刷 200 张，记录三项指标**

**操作**：连续滑动 200 张照片（可中途收藏几张并上墙），记录屏幕顶部显示的三项数值。

- [ ] **Step 4: 判定是否达标（对照 Spec §5.3）**

| 指标 | 目标 | 不达标时怎么调 |
|---|---|---|
| 决策间隔中位数 | < 1200 ms | 若过大：把卡片尺寸改小、把照片缩略图分辨率从 256 降到 192（`getThumbnail({width:192,height:192})`） |
| 回弹率 | < 3% | 若过大：**降低** `COMMIT_DISTANCE_RATIO`（0.28 → 0.22），让判定更容易触发 |
| 上墙转化率 | 15%–30% | 若 < 15%：`WALL_PROMPT_MS` 从 4000 → 6000，并把按钮文字从「挂上墙」改为「挂到地图上」；若 > 50%：`WALL_PROMPT_MS` 降到 2500 |

每次调参只改**一个**变量，重新刷 50 张看变化。

- [ ] **Step 5: 记录实测数据**

创建 `docs/measurements.md`：

```markdown
# 手感与指标实测记录

## 第 1 轮（默认参数）

- COMMIT_VELOCITY = 800, COMMIT_DISTANCE_RATIO = 0.28, WALL_PROMPT_MS = 4000
- 样本：200 张
- 决策间隔中位数：___ ms（目标 < 1200）
- 回弹率：___ %（目标 < 3）
- 上墙转化率：___ %（目标 15–30）
- 主观感受：___

## 第 2 轮（调整 __ → __）

（同上格式）
```

把实测值填进去（**用户提供数值，执行者不得臆造**）。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "chore: 指标达标验证与手感调参记录"
```

---

## 完成标准（M1 Definition of Done）

- [ ] 全部 12 个任务完成，`git log` 可见 12 次提交
- [ ] `node --experimental-strip-types --no-warnings --test entry/src/main/ets/core/` 全绿
- [ ] `assembleHap` 无 ERROR
- [ ] 真机可完成完整闭环：认领 → 刷 → 收藏 → 上墙 → 地图墙看到垂挂照片
- [ ] 杀掉 App 重开，认领数、收藏、上墙状态全部保留
- [ ] 三项指标实测达标（或已记录调参过程与最终值）
- [ ] `module.json5` 中**只有** `MEDIA_LOCATION` 一个权限
