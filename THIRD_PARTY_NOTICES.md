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
