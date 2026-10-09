# 第三方组件与数据来源声明

本仓库包含以下第三方作品。按各自许可要求在此保留版权声明与许可全文。

---

## 1. AreaCity-JsSpider-StatsGov（省市县三级行政区划与坐标数据）

- **来源仓库**：https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov
- **许可**：MIT License
- **版权行**：`Copyright (c) 2019 xiangyuecn`
- **使用的版本**：`2025.251231.260403`
- **上游数据出处**（据该项目说明）：国家地名信息库 / 高德地图 / 腾讯地图
- **本项目的使用方式**：把该项目的两个数据文件合并、裁剪后内嵌进 App

### 用到的上游文件

| 上游文件 | 用途 | 本项目取用的列 |
| --- | --- | --- |
| `ok_data_level3-4.csv`（取自 `ok_data_level3-4.csv.7z`） | 省 / 市 / 县三级区划名称与父子关系 | `id`、`pid`、`deep`、`name` |
| `ok_geo.csv`（取自 `ok_geo.csv.7z`） | 县级中心点坐标 | `id`、`geo` |

下载地址（同一 release）：

```
https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov/releases/download/2025.251231.260403/ok_data_level3-4.csv.7z
https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov/releases/download/2025.251231.260403/ok_geo.csv.7z
```

### 本项目产出的文件

`entry/src/main/resources/rawfile/china_areas.json`（105723 字节）

由上述两个 CSV 以 `id` 关联合并而成，只保留 `deep` 0/1/2 三级（丢弃乡镇），
只取坐标不取边界 `polygon`。结构说明与坐标系注意事项见
`entry/src/main/ets/core/areaData.ts` 文件头注释。

**坐标注意**：`geo` 字段为 **GCJ-02（高德火星坐标）**，非 WGS-84。本项目未做坐标系转换。

### 许可全文

```
MIT License

Copyright (c) 2019 xiangyuecn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Natural Earth — Admin 0 – Countries（中国轮廓）

- **来源**：Natural Earth, <https://www.naturalearthdata.com/>
- **数据集**：Admin 0 – Countries（`ne_10m_admin_0_countries`，1:10m 比例尺的矢量国界）
- **下载文件**：`ne_10m_admin_0_countries.geojson`（13,287,234 字节，**不入库**，见 `.gitignore` 的 `/tools/raw/`）
- **许可**：**Public Domain（公有领域）** —— Natural Earth 的数据由 NACIS 发布，无版权限制、
  无需署名即可使用。此处仍按控制器的要求写明来源与署名，并说明本项目做了哪些改动。
- **版权行**：`Natural Earth — public domain. Courtesy of Natural Earth (naturalearthdata.com).`
- **本项目的使用方式**：抽取其中的中国部分，简化后内嵌进 App 当国界。

### 抽取规则（由数据**自己的字段**决定，不是人工挑的）

| Natural Earth 要素 | `SOVEREIGNT` / `ADMIN` | 是否纳入 | 理由 |
| --- | --- | --- | --- |
| China | `SOVEREIGNT = "China"` | ✅ | 中国本土 + 海南 + 全部沿海岛屿（70 个环） |
| Hong Kong S.A.R. | `SOVEREIGNT = "China"` | ✅ | 数据源把特区单列成要素，但主权字段写的是 China |
| Macao S.A.R | `SOVEREIGNT = "China"` | ✅ | 同上 |
| Taiwan | `ADMIN = "Taiwan"` | ✅ | 数据源把它单列为 Taiwan；**控制器明确要求"含台湾"**，故显式纳入 |
| Spratly Islands | `ADMIN = "Spratly Is."` | ✅ | 南海诸岛 —— "数据里有就保留" |
| 其余 237 个要素 | — | ❌ | 不是中国 |

选定 5 个要素、共 **96 个环 / 15,271 个点**。

### 本项目做了哪些简化（可复现：`tools/build-outline.ts`）

1. **投影**：用 `core/projection.ts` 的 `projectMercator` + `CHINA_REGION.bounds = [73,18,135,54]`
   把每个顶点投影到参考画布 **360 × 267.72pt**（与设备/预览同一套几何）。
2. **Douglas–Peucker 简化**：在**投影后的画布空间**里做（不是经纬度空间 —— 墨卡托下
   "1° 纬度"的屏幕长度随纬度变化，用经纬度容差会让南北方的误差差一倍）。
   **容差 0.15pt** ≈ 1 倍图上 0.15 个像素、3 倍屏上 0.45 个物理像素 —— 屏幕上不可分辨。
   实测最大偏差 **0.1499pt**。
3. **坐标精度**：经纬度各保留 **2 位小数**（0.01° 经度 = 0.058pt、0.01° 纬度 = 0.074pt，
   都远小于 1 个像素），比全精度省约 1/5 体积。
   **例外**：3 条 300m 量级的礁（南海 16.58°N / 10.24°N / 9.77°N）在 2 位小数下会退化成一个点，
   它们**按源数据的全精度保留**，不做四舍五入 —— 否则就等于删掉了 3 个地理要素。
4. **没有删除任何要素**：96 个环全部保留（其中 37 条是小岛，简化后不足 3 个顶点 → 原样保留）。
5. **没有增补任何要素**：没有手工画线、没有合并、没有平滑。

| | |
| --- | --- |
| 源点数 | 15,271 |
| 简化后点数 | **2,959**（19.4%） |
| 环数 | **96**（0 条丢弃） |
| 产出的文件 | `entry/src/main/resources/rawfile/china_outline.json` |
| 产出字节数 | **37,637 字节（36.8 KB）** |

### 坐标系说明

Natural Earth 是 **WGS-84** 经纬度。本项目**未做坐标系转换**
（与 `china_areas.json` 的 GCJ-02 不同源，两者相差约 50~500m，在本 App 的显示比例下
（1pt ≈ 0.17° ≈ 19km）不可见）。这一点在 `core/render.ts` 的模块注释里也有记录。

### 许可见证

Natural Earth 的数据属于公有领域，其官方声明为：

> All versions of Natural Earth raster + vector map data found on this website are in the
> public domain. You may use the maps in any manner, including modifying the content and
> design, without restriction.

（<https://www.naturalearthdata.com/about/terms-of-use/>）

本项目仍然在此保留来源与署名，以便追溯数据的出处与改动过程。

---

## 3. Natural Earth — Admin 1 – States/Provinces（中国省级边界）

- **来源**：Natural Earth, <https://www.naturalearthdata.com/>
- **数据集**：
  - **Admin 1 – States/Provinces**（`ne_10m_admin_1_states_provinces`，1:10m 比例尺的矢量省级边界）
  - 外加 **Admin 0 – Countries** 的 3 个要素（台湾 / 香港 / 澳门 —— 理由是它们的省级边界
    就是全境轮廓，见下"抽取规则"）
- **下载文件**（**不入库**，见 `.gitignore` 的 `/tools/raw/`）：

  | 文件 | 字节数 |
  | --- | --- |
  | `ne_10m_admin_1_states_provinces.geojson` | 40,726,851 |
  | `ne_10m_admin_0_countries.geojson` | 13,287,234（与第 2 节同一份） |

  下载地址：`https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson`
- **许可**：**Public Domain（公有领域）** —— 与第 2 节同一份许可（Natural Earth 由 NACIS 发布，
  无版权限制、无需署名即可使用）。此处仍写明来源与改动过程以便追溯。
- **版权行**：`Natural Earth — public domain. Courtesy of Natural Earth (naturalearthdata.com).`
- **本项目的使用方式**：抽取中国全部 **34 个省级行政区**的边界，简化后内嵌进 App，
  画在国界**之上**、轨迹与照片**之下**（细线淡色）。
- **产出**：`entry/src/main/resources/rawfile/china_provinces.json`（**149,688 字节 = 146.2 KB**）
- **可复现**：`tools/build-provinces.ts`（默认参数即入库口径：10m 源 + 容差 0.08pt）

### 抽取规则（由数据**自己的字段**决定，**没有任何按名字的挑选**）

先读了数据看有哪些字段，再用属性判断。⚠️ 两份源的**字段名大小写不同**、且 admin_1
里**没有** `sovereignt` 字段（那只是 admin_0 的）：

| 组 | 规则 | 实测结果 |
| --- | --- | --- |
| ① 大陆省级 | `admin_1`: `properties.admin === 'China'` **且** `properties.geonunit === 'China'` | **31** 个（22 省 + 5 自治区 + 4 直辖市），93 环 / 53,214 点 |
| ② 台湾 | `admin_0`: `ADMIN === 'Taiwan'` | 1 个（8 环 / 561 点） |
| ③ 香港 | `admin_0`: `SOVEREIGNT === 'China'` 且 `ADMIN` 含 `Hong Kong` | 1 个（4 环 / 398 点） |
| ④ 澳门 | `admin_0`: `SOVEREIGNT === 'China'` 且 `ADMIN` 含 `Macao` | 1 个（2 环 / 92 点） |
| | **合计** | **34 个省级行政区**，107 环 |

两条**有意排除**的规则（都写明了理由，不是漏了）：

- `geonunit === 'Paracel Islands'`（西沙群岛）虽然 `admin === 'China'`，但它**不是省级单位**，
  Natural Earth 把它单列成一个 geounit。它的岛礁形状已由第 2 节的国界层（南海诸岛 12 环）画出。
  加上 `geonunit === 'China'` 这一条就把它排除了。
- admin_1 里 **台湾被拆成 21 个县市、香港被拆成 18 个区**。直接取用会把它们画成 21 块 / 18 块，
  那不是"省级划分"。它们真正的省级边界**就是全境轮廓**，所以从 admin_0 取各自那一个要素。

### 本项目做了哪些简化

1. **投影**：`core/projection.ts` 的 `projectMercator`，参考画布 **360 × 267.72pt**
   （与 `build-outline.ts` **同一个**尺寸，容差数字才可比）。
2. **Douglas–Peucker 简化**：同样在**投影后的画布空间**里做。**容差 0.08pt**，实测最大偏差 **0.0800pt**。
   为什么比国界的 0.15pt 小：国界是在"整块中国都看得见"时看的，而省界是用户**放大 9.5 倍**
   （真机诊断行的 `放大 9.5×`）之后看的，屏幕误差 = 参考容差 × 放大倍数：
   0.15pt → **1.42pt**（看得出线在抖）；**0.08pt → 0.76pt**（亚像素）。
   0.08 是 **150KB 上限之内能做到的最小容差**（0.07pt 就是 159.7KB，超限）。
3. **坐标精度**：经纬度各保留 **2 位小数**。0.01° 经度 = 0.058pt（参考画布），
   在 9.5 倍下是 0.55pt —— 与 DP 容差同量级，所以**没有再降到 1 位**。
   **例外**：2 条不足 3 个顶点的岛礁环**按源数据全精度保留**，不做四舍五入（否则等于删要素）。
4. **没有删除任何要素**：107 个环全部保留（0 条丢弃），其中 2 条是小岛/岛礁、原样保留。
5. **没有增补任何要素**：没有手工画线、没有合并、没有平滑。

| | |
| --- | --- |
| 省级行政区 | **34** |
| 源点数 | 54,265 |
| 简化后点数 | **11,840**（21.8%） |
| 环数 | **107**（0 条丢弃） |
| 产出的文件 | `entry/src/main/resources/rawfile/china_provinces.json` |
| 产出字节数 | **149,688 字节（146.2 KB）**，上限 150 KB |
| 数据版本标记（文件内 `v` 字段） | `ne10m-admin1-dp0.08-2dec` |

**为什么用 10m 而不是 50m**（实测，不是偏好）：同样 34 个省级单位，**10m 有 107 条环、
50m 只有 49 条** —— 少掉的 58 条全是小岛/岛礁。50m 确实能在 0.02pt 容差下只占 95.6KB，
但代价是永久丢掉 58 条地理要素。这与第 2 节 `china_outline.json` 的经验一致
（50m 的中国只有 19 环、10m 有 96 环）。

### 坐标系说明

与第 2 节相同：Natural Earth 是 **WGS-84**，本项目未做坐标系转换。

### 许可见证

与第 2 节同一份许可见证（Natural Earth 官方声明的 public domain 全文），不再重复抄录。

