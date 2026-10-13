# 翻片

> **HarmonyOS NEXT 照片应用**：把手机里那一堆旧照片变成**可以随手刷的回忆流**，再把你真正想再看见的那些**挂到中国地图上**。

产品核心不是"清理"，是「**重新看见**」。用户原话：

> 手机里一堆旧照片 有好看的 有重复的 有没用的 通过这个app 可以随意的刷自己的照片 来整理
> 没有负担 不用刻意到相册批量整理

---

## 📛 名字

**「翻片」谐音「翻篇」** —— 翻过去的那一页，不再纠结；字面上它同时就是"**翻照片**"（翻 + 片）。

这个名字是一个谐音梗，**名字本身推不出功能**，所以首屏在它下面必须挂一句定位语「翻自己的照片」把这件事顶住
（理由写在 `entry/src/main/ets/pages/ClaimPage.ets:127`）。

> 历史：产品最初叫「照片墙」，HEAD 提交 `3815dd0` 更名为「翻片」（**只改用户可见文案**，
> 包名与工程名未动 —— 原因见下面「未完成 / 已知遗留」）。

---

## ✨ 它做什么

| 功能 | 说明 | 代码位置 |
|---|---|---|
| **刷卡决策** | 一张一张地翻自己的照片。**上滑 = 下一张**（翻页本身不产生决策）；**下滑 = 回看刚划过去的那张**，可以当场改主意 | `ui/CardStack.ets`、`core/session.ts` |
| **四个动作** | 卡片下方一排四个按钮：**主页面 / 归档 / 上墙 / 收藏**。归档是"从流里退出"，**不是删除**（照片仍在相册） | `ui/CardStack.ets:1894-1915` |
| **上墙** | 把照片挂到**中国地图**上：国界 + **34 个省级行政区省界** + 按拍摄时间的**旅行轨迹折线** + 地点钉 + 垂挂照片。**双指缩放**视野、**左右拖动**看全国、点钉子看该地点全部照片 | `pages/WallPage.ets`、`core/render.ts` |
| **长按播放动态照片** | 拍摄的 Live Photo / 动态图，**默认不自动播**，**长按才播**、松手回静态。角标亮 ⟺ 长按一定有效 | `core/movingPhoto.ts`、`ui/CardStack.ets` |
| **图片缩放** | 刷卡页照片支持**双指捏合 1×~4×**、放大后单指拖动平移、**双击复位到 1×** | `core/zoom.ts`（`SCALE_MIN=1` / `SCALE_MAX=4`） |
| **收藏页** | 收藏池与已上墙的回头路；上墙入口错过也不惩罚，随时能补 | `pages/FavPage.ets` |
| **使用统计页** | 把三条验收指标从落盘的历史数据算出来（**只读**，重置 = 删 `files/metrics.json`） | `pages/StatsPage.ets` |
| **分批认领** | 用系统选图器一批批把照片"认领"进来（见下节的平台约束）。可先选这次刷多少张（20 / 50 / 100 / 200，默认 100） | `pages/ClaimPage.ets`、`data/claimStore.ets` |
| **本地持久化** | 决策状态、地点索引、认领清单、统计全部落盘。**零网络、零上传、零账号** | `entry/src/main/ets/data/` |

---

## ⚠️ 平台约束（**这一节决定了整个产品形态，必读**）

产品的形状不是设计偏好挑出来的，是 **HarmonyOS 的权限模型逼出来的**。四条实测事实：

### 1️⃣ 拿不到"读整个相册"的权限 —— 而且是**装包就失败**

全库枚举相册需要 `ohos.permission.READ_IMAGEVIDEO`。它是 **`system_basic` 级**权限，
**第三方应用声明它会导致安装失败**（实测，不是文档推断）：

```
install failed due to grant request permissions failed.
PermissionName: ohos.permission.READ_IMAGEVIDEO
```

> 出处：`docs/design.md` §1 探针结论表 Q1；`core/session.ts:9`、`pages/ClaimPage.ets:221` 的注释。

**后果**：本 App **无法**"扫描整个相册"，也**无法**做"自动发现新照片"。所有"删除 / 归档"只对**已经认领进来的**照片有效。

### 2️⃣ 所以产品是「**分批认领**」，不是"读相册"

唯一入口是**系统选图器**（`PhotoViewPicker`）。用户选中的 URI 会获得**永久授权**（跨 App 重启仍然可读，实测 Q7），
然后本 App 就能自己用 `fileIo.openSync(uri)` 打开它 —— **完全绕过 medialibrary**，这是整个技术底座。

代价（设计里明示，不是缺陷）：

- **新拍的照片不会自动出现**，需要用户主动"补选"
- 每次认领有批次成本（选图器上限 500 张，实测 43 张耗时 9.5 秒）

### 3️⃣ 唯一声明的权限是 `ohos.permission.MEDIA_LOCATION`

它只用来**读 EXIF 里的拍摄地点**，好把照片挂到地图上。
未授权时系统会**主动抹掉** EXIF 的位置字段，所以这个权限**必需、不可省**。

```
requestPermissions: [ ohos.permission.MEDIA_LOCATION ]   ← 全仓库唯一一条
```

> 出处：`entry/src/main/module.json5:35-46`；**已复核打包产物** —— `entry-default-signed.hap` 内的
> `module.json` 里声明的权限**有且仅有** `ohos.permission.MEDIA_LOCATION`，`READ_IMAGEVIDEO` **不在其中**。

### 4️⃣ 动态照片为什么能播 —— 选图器的永久授权**替代**了受限权限

读动态照片的接口在 `.d.ts` 上标着 `@permission ohos.permission.READ_IMAGEVIDEO`，
但**选图器给出的永久授权可以替代它**（真机验证过）。所以本 App 在不声明任何受限权限的前提下，
既读得到 EXIF、也播得了动态照片。

> 出处：`data/movingPhotoSource.ets:186-187`。

---

## 🏗️ 架构

**一句话**：**纯逻辑**与**设备层**严格分开，纯逻辑那一半可以在 Node 上跑单测。

```
entry/src/main/ets/
├─ core/     ← 🧠 纯逻辑：零 @kit.* import，可在 Node 上直接跑单测（17 个模块 + 18 个测试文件）
│              render(地图几何/SVG) · designTokens(设计令牌) · metrics(验收指标) · anim(动画预算)
│              zoom(照片缩放) · movingPhoto(动态照片判据) · geo/projection/placement/areaData(地理)
│              queue/session(队列与会话) · claim · exifParse · atomicText · placePick · motionProbeState
├─ data/     ← 🔌 设备层：文件 IO、选图器、EXIF 读取、媒体库查询（10 个模块）
├─ pages/    ← 🖼️ 页面：ClaimPage · SwipePage · FavPage · WallPage · StatsPage
└─ ui/       ← 🧩 组件：CardStack(刷卡核心交互) · PlacePicker(手动选地点)
```

### 🔴 硬规矩：`core/*.ts` **不得 import 任何 `@kit.*`**

这是"**纯逻辑能在 Node 上跑单测**"的**前提** —— `@kit.*` 是设备侧模块，一旦被 import，Node 就加载不了这个文件，
整套单测直接跑不起来。所以：

- 平台动作一律**经接口注入**（例如 `core/atomicText.ts` 只收一个 `AtomicWritePort`，fd 用 `number` 而不是平台对象）
- 平台枚举值以**数字常量 + 注释**的方式镜像（例如 `core/movingPhoto.ts` 的 `MOVING_PHOTO_ENABLED(1)`）
- 类型刻意用**结构类型**而不是 `image.PixelMap`（`core/anim.ts:33`）
- 光靠自觉不够，有测试**读源码**来守这条线：`core/storeWiring.test.ts`

> **已复核**：`core/*.ts` 里 `import ... from '@kit.*'` 的实际条数 = **0**（`@kit` 只出现在**注释**里，
> 共 24 处，都是在解释这条规矩）。设备层的 `@kit.*` import 有 **62 处**，都在 `data/` `pages/` `ui/`。

---

## 🚀 怎么跑

> 所有命令在 **PowerShell** 下逐字可用（Windows）。已验证环境：
> **Node v22.17.1** · **DevEco Studio 26.0.0.851** · **HarmonyOS SDK 26.0.0.105 (API 26)**。

### 🧪 单测

**基线 438 个用例，18 个测试文件，全绿。**

⚠️ **必须逐个列出测试文件**。用 `--test <目录>` 会得到**假红**（Node 的目录扫描与本项目的导入方式不兼容）：

```powershell
Set-Location "<你的 clone 路径>"
$tests = Get-ChildItem "entry\src\main\ets\core" -Filter "*.test.ts" | ForEach-Object { "entry/src/main/ets/core/$($_.Name)" }
node --experimental-strip-types --no-warnings --test @tests
```

> 在作者机器上 `node` 是 `D:\software\nodejs\node.exe`（v22.17.1），已在 PATH 上，所以直接写 `node` 即可；
> 若你的 Node 不在 PATH，把 `node` 换成它的绝对路径。

预期结尾：

```
1..438
# tests 438
# pass 438
# fail 0
```

**版本要求**：`--experimental-strip-types` 需要 **Node 22+**（本项目在 **v22.17.1** 上验证）。
`--no-warnings` 是为了压掉该实验特性的告警。
`core/*.ts` 全部是 `.ts` 且**零外部依赖**，所以不需要 `npm install`、也不需要编译，Node 直接跑。

### 🔨 构建

仓库里**没有 `hvigorw` 包装脚本**，要直接调用 DevEco Studio 内置的 hvigor。
**命令行编译必须设 `DEVECO_SDK_HOME`**，否则报 `00303217 Configuration Error: Invalid value of 'DEVECO_SDK_HOME'`。

```powershell
Set-Location "<你的 clone 路径>"
$env:DEVECO_SDK_HOME = "<你的 DevEco 安装目录>\sdk"
& "<你的 DevEco 安装目录>\tools\node\node.exe" "<你的 DevEco 安装目录>\tools\hvigor\bin\hvigorw.js" `
  --mode module -p module=entry@default -p product=default assembleHap --no-daemon
```

成功时结尾是：

```
> hvigor Finished :entry:assembleHap... after 1 ms
> hvigor BUILD SUCCESSFUL in 15 s 592 ms
```

> 这套参数来自 `docs/plan.md` 的「环境注意事项」（当时实际跑过的命令）。
> **本次搬迁时又实测了一遍**：删掉 `entry/build` 全量重建 → `BUILD SUCCESSFUL`、**exit 0**、
> `entry-default-signed.hap` 与 `modules.abc` 均为本次新生成。

**产物**：

| 文件 | 说明 |
|---|---|
| `entry/build/default/outputs/default/entry-default-signed.hap` | ✅ **装这个**（已签名，约 1.27 MB） |
| `entry/build/default/outputs/default/entry-default-unsigned.hap` | 未签名，仅中间产物 |

⚠️ **DevEco Studio 开着会与命令行争 `entry/build`** —— IDE 自行构建会清掉命令行刚建好的产物。
命令行构建与 IDE 构建**不要同时进行**。取证时用「**删 build → 构建 → 同一进程内立即取证**」。

### 🔑 本地签名配置（新 clone 必读）

🔴 **先做这件事**：本仓库曾经把**真实签名口令**写进 `build-profile.json5` 并推到公开仓库
（`776be16` 引入，一直存在到 `a9ac000`）。那些值已从**全部提交**里移除，但
**「移除」不能撤销「已经暴露」** —— 请在 DevEco Studio 里**重新生成一份调试签名**，
让旧口令彻底作废。那只是两次点击（`File > Project Structure > Signing Configs` →
`Automatically generate signature`）。

**仓库里现在没有任何签名材料。** 签名材料只存在于**本机未入库**的 `signing.local.json5`：

| 文件 | 是否入库 | 作用 |
|---|---|---|
| `signing.local.json5.example` | ✅ 入库 | 模板 + 填写说明 |
| `signing.local.json5` | ❌ **被 `.gitignore` 忽略** | 你的真实材料（口令 + 绝对路径） |
| `build-profile.json5` | ✅ 入库 | `signingConfigs` **留空**，文件结构不变 |
| `hvigorfile.ts` | ✅ 入库 | 构建时读本地文件，注入 hvigor 的 `config.ohos.overrides.signingConfig` |

**步骤**：

```powershell
Set-Location "<你的 clone 路径>"
Copy-Item signing.local.json5.example signing.local.json5
# 然后按文件内注释填：3 个绝对路径 + 2 个口令
```

值从哪来：在 DevEco 里生成签名后，DevEco 会把结果写进 `build-profile.json5`；
把那段 `material` 抄进 `signing.local.json5`，再 `git restore build-profile.json5`
把仓库文件还原成模板。**绝不要提交那段值。**

**不配也能编译**：没有 `signing.local.json5` 时 `assembleHap` **依然 `BUILD SUCCESSFUL`**，
只是产物只有 `entry-default-unsigned.hap`（装不上真机）。两种情形都实测过。

> ⚠️ `signing.local.json5` 的字段**受 schema 约束**：hvigor 用
> `@ohos/hvigor-ohos-plugin/res/schemas/hvigorfile-configuration/project-schema.json`
> 校验 `overrides.signingConfig`，只允许 `type` 与 `material` 两个字段，
> `material` 只允许 `certpath` / `keyAlias` / `keyPassword` / `profile` / `signAlg` /
> `storeFile` / `storePassword`。**多写一个键（例如 `name`）会直接
> `Schema validate failed` 构建失败**（这是实测踩到的）。

### 📱 装到设备

> ⚠️ **必须在你的自有终端执行** —— `hdc` 在 agent 的文件沙箱里跑不起来（密钥加载失败会让设备变 `Offline`）。

```powershell
cd "<你的 DevEco 安装目录>\sdk\default\openharmony\toolchains"
.\hdc.exe install -r "<你的 clone 路径>\entry\build\default\outputs\default\entry-default-signed.hap"
.\hdc.exe shell aa start -a EntryAbility -b com.example.photospike
```

| | |
|---|---|
| **bundleName** | `com.example.photospike` ⚠️ **仍是占位符**（见下节） |
| **Ability** | `EntryAbility` |
| **deviceTypes** | `phone` |
| **启动页** | `pages/ClaimPage`（`entry/src/main/ets/entryability/EntryAbility.ets:20`） |

### 🛠️ DevEco Studio 版本要求

| 项 | 值 | 出处 |
|---|---|---|
| `compatibleSdkVersion` | **`26.0.0`** | `build-profile.json5:23` |
| `targetSdkVersion` | **`26.0.0`** | `build-profile.json5:22` |
| `runtimeOS` | `HarmonyOS` | `build-profile.json5:24` |
| `modelVersion` | `26.0.0` | `hvigor/hvigor-config.json5`、`oh-package.json5` |
| 验证过的 DevEco Studio | **26.0.0.851**（build `DS-261.23567.138.36.2600851`） | 本机 `product-info.json`；`docs/design.md` 附录 A 记 26.0.0 |
| HarmonyOS SDK | **26.0.0.105 / `apiVersion 26`** | `<DevEco>/sdk/default/openharmony/ets/oh-uni-package.json` |

### 🗺️ 地图数据工具（可选，`tools/`）

`tools/` 下是可复现地图数据的独立脚本（**不参与 App 构建**）：

- `tools/build-outline.ts` → 生成国界 `china_outline.json`
- `tools/build-provinces.ts` → 生成省界 `china_provinces.json`
- `tools/render-preview.ts` → 用 Node 把地图场景渲染成 SVG/PNG 预览（**不开模拟器也能看视觉结果**）
- `tools/wall-audit.ts` → 场景审计

原始 GeoJSON 与预览产物**都不入库**（`.gitignore` 的 `/tools/raw/`、`/tools/out/`）——
入库的只有简化后的三个 `rawfile/*.json`。

---

## 📜 数据来源与许可

App 内嵌三个离线数据文件，全部有明确的来源、许可与**可复现的抽取规则**：

| 文件 | 大小 | 来源 | 许可 |
|---|---|---|---|
| `entry/src/main/resources/rawfile/china_areas.json` | 105,723 B | [AreaCity-JsSpider-StatsGov](https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov) `2025.251231.260403` | MIT |
| `entry/src/main/resources/rawfile/china_outline.json` | 37,637 B | [Natural Earth](https://www.naturalearthdata.com/) Admin 0 – Countries (1:10m) | Public Domain |
| `entry/src/main/resources/rawfile/china_provinces.json` | 149,688 B | Natural Earth Admin 1 – States/Provinces (1:10m) | Public Domain |

**➡️ 完整的来源、版权行、许可全文、抽取规则、简化容差与实测偏差，见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。**

两点值得单独记住：

- **区划坐标是 GCJ-02（高德火星坐标）**，不是 WGS-84；**国界/省界是 WGS-84**。本项目**未做坐标系转换**
  （两者相差约 50~500 m，在本 App 的显示比例下不可见）。
- 国界抽取**含台湾、香港、澳门、南海诸岛**，规则由数据自身的 `SOVEREIGNT` / `ADMIN` 字段决定，
  **不是按名字人工挑选**；96 个环 / 107 条省界环**一条都没丢**。

---

## 📚 文档索引

设计与执行的全部来龙去脉在 **[`docs/`](docs/README.md)**：

| 文档 | 大小 | 是什么 |
|---|---|---|
| [`docs/design.md`](docs/design.md) | 18.2 KB | **设计文档** —— 探针实测结论、平台约束、交互语义、验收指标、地图墙规则、风险与未决项 |
| [`docs/plan.md`](docs/plan.md) | 87.3 KB | **M1 实现计划** —— 12 个 Task，逐字可执行的 TDD 步骤 |
| [`docs/decisions.md`](docs/decisions.md) | 139.7 KB | **决策台账** —— **84 条 Ruling**：每个结论是被什么数据推翻或确立的 |
| [`docs/README.md`](docs/README.md) | — | **索引**：三份是什么、**建议阅读顺序**、Ruling 是什么、路径替换规则 |

**先读哪份**：只想知道这是什么 → 本 README + `design.md` §0–§2。
要继续开发 → `plan.md` 的 `## Global Constraints` + `decisions.md` 的 **Ruling 69–84**（最新口径）。
想复查某个结论凭什么 → 按 `Ruling NN` 在 `decisions.md` 里检索。

---

## ⚠️ 未完成 / 已知遗留

**如实列出**（继续工作时从这里开始最省时间）：

### 🔧 工程债

| # | 遗留 | 详情 |
|---|---|---|
| 1 | **`bundleName` 仍是占位符** | `com.example.photospike`，`vendor` 是 `example`（`AppScope/app.json5:3-4`）。改名的**真实阻碍**：`.p7b` 调试 profile 与包名绑定，改名即失配，而重新生成需要 DevEco 的自动签名交互（`docs/decisions.md` 设置记录 / Ruling 1） |
| 2 | **应用图标是 DevEco 默认模板** | `AppScope/resources/base/media/` 下只有模板生成的 `background.png` + `foreground.png` + `layered_image.json`，从未替换 |
| 3 | **没有 `LICENSE` 文件** | 仓库根只有 `THIRD_PARTY_NOTICES.md`（第三方声明）。**本项目自身的许可未声明** —— 公开分发前必须补 |
| 4 | ~~**`build-profile.json5` 里含本机签名材料**~~ → ✅ **已处理** | 原状：`signingConfigs` 内联了 `.cer` / `.p7b` / `.p12` 的**绝对路径**（含用户名）与 `keyPassword` / `storePassword`，**被 git 跟踪、且已推到公开仓库**，任何一版历史都能读到。已做三件事：① 改为仓库只留模板，真值放未入库的 `signing.local.json5`，由 `hvigorfile.ts` 注入 hvigor 官方扩展点 —— 见「🔑 本地签名配置」；② 用 `git filter-repo` 把两串口令与含用户名的绝对路径从**全部 109 个提交**里移除；③ `--force-with-lease` 强推覆盖远端，并用全新 clone 复验 0 命中。**⚠️ 唯一的残留风险是"已经暴露过"这件事本身** —— 旧口令仍应视为已泄露，**必须重新生成签名**（见上节） |

### 🐞 功能未完成

| # | 遗留 | 详情 |
|---|---|---|
| 5 | **删除照片功能未实现** | 设计里有（`docs/design.md` §5.1 长按菜单含"真删除"，§3.1 认领流程含删除/归档），**代码里没有删除路径**。`ui/CardStack.ets:185` 明确写着 `'skip' 与删除不在此列`。作品集里还有一条 `reason_read_imagevideo` 权限文案字符串是上一条路线的残留（`entry/src/main/resources/base/element/string.json:12`），**没有任何消费者** |
| 6 | **`SwipePage` 的 `[标尺]` 日志是临时诊断** | `pages/SwipePage.ets` 里的「安全区标尺」（`batch-44`）是为判定"可用区到底含不含系统手势区"临时加的**取证装置**：四行 `hilog` + 两个 `id` + 两个口径常量 + 三个 `@State` 量测字段。**它自己就写着"待验证结论"**（`SwipePage.ets:95`）。定案后应清理 —— 它是本仓库**唯一一处为诊断而长期驻留的生产代码** |

### 📉 指标未达标（三条验收指标）

| 指标 | spec 目标 | 实测真值 | 结论 |
|---|---|---|---|
| 决策间隔中位数 | < 1200 ms | **656.5 ms** | ✅ **达标** |
| **误操作率（滑到一半回弹）** | **< 3%** | **8.51%**（`4/47`） | ❌ **未达标（高约 2.8 倍）** |
| 上墙转化率（收藏池 → 上墙） | ≥ 15%（只判下限） | **60%**（`33/55`） | ✅ **达标** |

> 出处：`docs/decisions.md` **Ruling 79**（回弹率口径反转 → `4/47 = 8.51%`）、
> **Ruling 80**（中位数 `656.5 ms`，且注明这是**偏悲观的上界**）、**Ruling 74**（转化率 `walled 33 / 收藏池 55 = 60%`）；
> 目标值出处 `docs/design.md` §5.3。所有读数可在 App 的**「使用统计」页**当场复核（`pages/StatsPage.ets`）。

⚠️ **读数前先看口径**，这三条的口径**不一样且刻意不一样**（`pages/StatsPage.ets:177-211` 有页内说明）：

- **回弹率** = 出现过回弹的**尝试组数** ÷ 尝试组数。分组键是 `photoId|shownAt`（"一张照片的一次出现"），
  **分母含「上墙」**。
- **决策间隔中位数**的口径**没有跟着改，两边已分家**：它**仍然排除「上墙」**。
  这是**有意保留**的（Ruling 80）—— 排除上墙会让中位数**偏高**，所以 `656.5 ms` 是个**偏悲观的上界**，达标是稳的。
- **上墙转化率**的分母是**收藏池**（`faved ∪ walled`），不是 `faved`。
  因为上墙会把状态直接写成 `walled`，**只数 `faved` 会让分母被分子吃掉** —— 实测会读出 `150%`
  （百分比超过 100% 是"分母选错"的典型症状）。

**回弹率为什么高**：8.51% 是**行为事实**，口径本身已按真机数据反转过一次（旧口径 `4/24 = 16.67%`）。
要动它属于**手感/交互调参**，不是改数字。

### 📌 台账里已登记但有意不修的残留

- **R1**（`docs/decisions.md` Ruling 82）：`SwipePage.handle()` 的重复上报守卫在 `recordSwipe` **之后**，
  于是"同帧重复点按钮"会多算 1 个尝试组（分母 +1 → 回弹率**略偏"好看"**）。修它属逻辑变更。
- **R2**：`core/metrics.test.ts:43` 的**用例名**仍是旧单位措辞（字符串字面量，非注释），改它会破坏"只改注释"的验收。

### 🧭 设计里尚未定案的三件事

见 `docs/design.md` §10「未决项」：上墙交互最终形态、首批认领的引导方式、世界地图解锁阈值。

---

## 🔢 关键数字的出处

本 README 里每个数字都能回溯（**无一处是估计**）：

| 数字 | 出处 |
|---|---|
| 438 个单测 / 18 个测试文件 | 本次实测：`node --experimental-strip-types --no-warnings --test @tests` → `# tests 438 / # pass 438 / # fail 0` |
| `core/` 17 个模块、`data/` 10 个、`pages/` 5 个、`ui/` 2 个 | 本次实测：目录文件计数 |
| `core/*.ts` 的 `@kit.*` import = **0**、设备层 = 62 | 本次实测：`Select-String "^\s*import.*@kit"` 计数 |
| `china_areas.json` 105,723 B / `china_outline.json` 37,637 B / `china_provinces.json` 149,688 B | 本次实测文件大小；且与 `THIRD_PARTY_NOTICES.md` §1/§2/§3 各自写明的产出台账**逐字一致** |
| 34 个省级行政区 / 96 个国界环 / 107 条省界环 | `THIRD_PARTY_NOTICES.md` §2、§3 的抽取规则表 |
| `compatibleSdkVersion` / `targetSdkVersion` = `26.0.0` | `build-profile.json5:22-23` |
| `bundleName` = `com.example.photospike` | `AppScope/app.json5:3`；**并已从打包产物 `entry-default-signed.hap` 内的 `module.json` 复核** |
| 唯一权限 = `MEDIA_LOCATION` | `entry/src/main/module.json5:37`；**并已从打包产物复核**（`READ_IMAGEVIDEO` 不在声明里） |
| `READ_IMAGEVIDEO` 是 `system_basic`、声明即安装失败 | `docs/design.md` §1 Q1（含 `install failed ... PermissionName: ohos.permission.READ_IMAGEVIDEO`）；`core/session.ts:9` |
| 选图器永久授权（跨重启有效）/ 43 张 9.5 秒 / 上限 500 | `docs/design.md` §1 探针表 Q5、Q7 |
| 回弹率 **8.51%**（`4/47`） | `docs/decisions.md` **Ruling 79** |
| 决策间隔中位数 **656.5 ms** | `docs/decisions.md` **Ruling 80** |
| 上墙转化率 **60%**（`33/55`） | `docs/decisions.md` **Ruling 74**；`docs/design.md` §5.3 |
| spec 目标 `< 1200 ms` / `< 3%` / `≥ 15%` | `docs/design.md` §5.3 验收指标表 |
| `1×~4×` / `SCALE_MIN=1`、`SCALE_MAX=4` | `entry/src/main/ets/core/zoom.ts:34,46` |
| 默认 100 张、可选 20/50/100/200 | `entry/src/main/ets/core/session.ts`（`DEFAULT_SESSION_SIZE` / `SESSION_SIZE_CHOICES`） |
| DevEco Studio 26.0.0.851 / SDK 26.0.0.105 (API 26) | 本机 `<DevEco>/product-info.json` 与 `<DevEco>/sdk/default/openharmony/ets/oh-uni-package.json` |
| Node v22.17.1 | 本次实测：`node --version` |
| 构建 `BUILD SUCCESSFUL in 15 s 592 ms`、exit 0 | 本次实测：删 `entry/build` 后全量重建 |
