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
