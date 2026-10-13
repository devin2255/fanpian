# SDD ledger — plan: `docs/plan.md`（本仓库）

Spec: `docs/design.md`（本仓库）
Product repo: 本仓库（git，master 分支）
Ledger 出处：原文件在另一个工作区的 `.superpowers/sdd/2026-10-08-photo-wall-m1/progress.md`（已 gitignore、不入库）。
为让 clone 后自足，于本次搬迁进本仓库作为 `docs/decisions.md`；**正文除本顶部路径块外逐字未改**。

> ⚠️ **路径说明（搬迁时补）**：下文里的 `D:\dev\PhotoWall` = **本仓库的 clone 路径**，
> `D:\dev\PhotoSpike` = 已被丢弃的探针工程（见 `docs/design.md` 附录 A）。
> 搬迁时已把**含用户名的绝对路径**（`C:\Users\<用户名>\...`）脱敏为仓库内相对路径，其余原样保留。

## 设置记录

- 产品工程 `D:\dev\PhotoWall` 由控制器从已通过真机验证的 `D:\dev\PhotoSpike` 复用生成
  （计划 Task 1 Step 1 原写"用户用 DevEco 生成"；控制器代为完成，等价且省一轮交互）
- **bundle name 保持 `com.example.photospike`**（不是计划里写的 `com.example.photowall`）：
  `.p7b` 调试 profile 与 bundle name 绑定，改名会使 profile 失配，而重新生成需 DevEco 的
  自动签名交互。用户可见的是应用名（已设为「照片墙」），包名仅调试期可见。见 Ruling 1。
- 已有脚手架：空 DevEco 工程（SDK 26.0.0 / 自动签名 / 无页面）
- 测试设施已验证：`node --experimental-strip-types --no-warnings --test` 可跑 `.ts`（Node v22.17.1）

## 预检冲突扫描

### 跨任务共享（文件 / 接口）

| 对 | 一方产出 | 另一方消费 | 结论 |
|---|---|---|---|
| T1→T6 | `ClaimState`/`ClaimedPhoto`/`mergeBatch`/`claimStorePath` | `data/claimStore.ets` | 一致 |
| T1→T9 | `sortByTakenDesc` | 计划文字说用 `LocationEntry.takenAt` 排序，未指名该函数；Task 6/7 未消费它 | 轻微未用，非冲突 |
| T2→T3/T9/T11 | `Pin`/`GeoPoint`/`clusterPoints`/`medianPoint`/`parseExifCoord`/`dedupePins` | T3 用 GeoPoint/Pin；T9 用 parseExifCoord；T11 用 clusterPoints/medianPoint/GeoPoint | 一致（`dedupePins` 暂无消费者，可接受） |
| T3→T10/T11 | `projectMercator`/`CHINA_REGION`/`MAX_HANG` | T10 用全部；T11 用 projectMercator/CHINA_REGION | 一致 |
| T4→T7/T8 | `Decision`/`Action`/`emptyDecision`/`applyDecision`/`QueueInput` | T7 用全部；T8 用 Decision/applyDecision | 一致 |
| T5→T7/T12 | `SwipeEvent`/`emptyMetrics`/`recordSwipe`/`medianDecisionMs`/`rollbackRate` | T7 用前四个；T12 用 `wallConversion` | 一致（T12 需自行取 faved/walled 计数，计划已写明） |
| T8→T11 | `DecisionStore.walledIds()` | T11 用 | 一致 |
| T9→T11 | `LocationEntry`/`LocationIndex.load()` | T11 用 | 一致 |
| T10→T11 | `ScenePin`/`buildScene`/`sceneToSvg`/`WallPhoto` | T11 用全部 | 一致 |
| T1/T4/T6/T7/T8/T9/T10/T11 → `main_pages.json` | 多方修改同一文件 | 计划按序演进 | 一致（T1 补 `pages/Index`、T6 加 ClaimPage、T7 加 SwipePage、T8 加 FavPage、T11 加 WallPage） |
| T2/T3/T4/T5/T9/T10 → `core/` | 计划统一约束：`core/*.ts` **不得 import `@kit.*`** | — | 一致（已 grep 验证：25 处 `@kit.*` 全在 `data/`/`pages/`） |

### 任务自洽性

| 任务 | 检查 | 结论 |
|---|---|---|
| T1 | 测试用 `sortByTakenDesc`，实现含它；但 Interfaces 未列 → 已在 brief 中保留实现代码 | 一致（控制器已补 Interfaces 行） |
| T1 | 测试期望 6 个全绿，实际测试块恰 6 个 `test()` | 一致 |
| T2 | 测试 9 个，实现含全部被导入符号 | 一致 |
| T3 | 测试导入 `MAX_HANG`/`EXPAND_ALL_MAX`/`COLLAPSE_THRESHOLD`，实现均导出 | 一致 |
| T4 | 测试 10 个；`buildQueue` 排序断言与实现一致 | 一致 |
| T5 | 测试 7 个；`wallConversion` 除零已测 | 一致 |
| T6 | 依赖 T1 的 `mergeBatch`；`ClaimStore` 自带 IO | 一致 |
| T7 | 依赖 T4/T5；`router` 导入已在计划中补 | 一致 |
| T8 | 依赖 T4；`!` 非空断言已在计划中改为显式判空 | 一致 |
| T9 | 依赖 T2；`LocationEntry` 定义与 T11 消费一致 | 一致 |
| T10 | 依赖 T2/T3；`sceneToSvg` 用 `PHOTO_SIZE_PT`（本地常量） | 一致 |
| T11 | 依赖 T8/T9/T10；`fileIo` 导入已在计划中补 | 一致 |
| T12 | 依赖 T5；记录文件由用户填数（禁止臆造） | 一致 |

### 扫描发现与裁决

- **发现 A（T1 计划文字）**：Task 1 的 `Files` 列了 `samples/sample.json`，但没有任何步骤创建它。判定为计划残留物，无消费者。
  **Ruling 2**：不创建该文件。理由：YAGNI，无任务消费它；代价：若后续需要样例数据需补。
- **发现 B（T1 Implementer 强制约束）**：ArkTS 工程要求 `pages/Index.ets` 必须存在（`main_pages.json` 指向它），
  否则 `CompileArkTS` 直接失败（控制器已实测：`Page '.../pages/Index.ets' does not exist`）。
  Task 1 未提及此文件。**Ruling 3**：Task 1 需创建最小可用 `pages/Index.ets`（`@Entry` 空页面 + 引用 core 类型以证明 core 可被 ArkTS 编译）。
  代价：T6 会用 `ClaimPage` 替换它，属预期演进。
- **发现 C（T4 `buildQueue` 排序语义）**：`promoted`（跳过 ≥3 次）排在 `pending[0]` 之后，而非最前。
  计划的测试只断言"在前部"，未断言"第一"。**Ruling 4**：按计划实现，不改语义；真实手感留待 Task 12 验证。
  代价：若用户觉得"躲了 3 次的那张不够显眼"，T12 需调整顺序。

## 进度

### Task 1: 工程脚手架与测试基础设施

- BASE: 无（根提交）
- 状态: implementer 已派发（agent 29476500-a0df-4f80-ad5d-960bfb7c53e4）
- brief: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-1-brief.md`
- 报告: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-1-report.md`
- 结果: DONE，commit 776be16（根提交，39 文件；新增 3 个源码文件）
  - 测试 6/6 passing，output pristine
  - TDD: RED = `ERR_MODULE_NOT_FOUND ...core\claim.ts`（# pass 0 / # fail 1）；GREEN = # pass 6 / # fail 0
  - 编译: BUILD SUCCESSFUL（29s），产出 entry-default-signed.hap
  - 额外证据: 编译器缓存含 `core\claim.protoBin` 与 `pages\Index.protoBin`，`claim.test.ts` 不在 cache/loader_out
    → `.test.ts` 未污染 ArkTS 编译，brief 里条件的 `sourceOption.excludes` **未添加**（正确）
- reviewer 已派发（agent 51be6168-6407-41f5-866a-578144ea5677）
- review package: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-1-review-package.txt`
- **审查结果: ✅ Spec compliant / Approved**（无 Critical、无 Important，7 条 Minor）
- reviewer 的三项 ⚠️「无法从 diff 验证」由控制器亲自核实，**全部通过**：
  - `targetSdkVersion` / `compatibleSdkVersion` = `26.0.0` ✓
  - 受限权限 `READ_IMAGEVIDEO` / `WRITE_IMAGEVIDEO` 各 0 处；`MEDIA_LOCATION` 1 处 ✓
  - `entry/build-profile.json5` 无 `sourceOption` ✓
  - HAP 内无任何 `test` 路径（13 个条目）✓
  - **控制器重跑编译：BUILD SUCCESSFUL，退出码 0** → 编译由"间接佐证"升级为"直接验证" ✓

#### Ruling 5（Fix 组 1）：把两条 Minor 升格为修复

reviewer 判 #2/#3 为 Minor（"当前无写入者"）。**控制器不同意降级，理由具体**：

- **#2 `claim.ts:40-41` 排序分组不穷尽**：`takenAt > 0` 与 `takenAt <= 0` 对 `NaN` 皆为假 → 该照片两组都不进、**静默消失**。
  计划明写 `takenAt` 由 Task 9 回填 EXIF，故 **Task 9 很可能引入 NaN 生产者**，那时即为无声数据丢失。
- **#3 `claim.ts:24` 浅拷贝**：返回的 `ClaimedPhoto` 与前一状态共享对象引用；Task 9 若就地回填 `takenAt`
  会污染前一状态（陈旧快照风险）。

按技能规定 Minor 不进 fix loop，故此项由控制器以 Ruling 明示升格。
**代价（若判断有误）**：偏离计划的逐字代码两行，增加一次 fix dispatch + 一次 scoped 再审查；
`sortByTakenDesc` 语义按 `!(takenAt > 0)` 判定，NaN/0 同归"无时间"组，需确保后续无消费者区分二者。

误判代价小、放过的代价是难查的数据丢失 → 决定修。

#### 其余 Minor 处置（deferred，交最终整分支审查三方裁决）

- #1 `lastBatchId` 空批量仍自增（计划强制）—— reviewer 判 Minor 且理由充分（游标只前进，安全方向）→ 保留
- #4 测试覆盖窄于行为面（批内重复、输入不可变、排序并列、空 URI 断言过弱）—— 加测试会偏离计划的确切测试清单 → 记录
- #5 `claimStorePath` 硬编码 `/`（HarmonyOS 上正确，计划强制）→ 记录
- #6 `Index.ets:8` 声明了未被读取的 `claimState`（Ruling 3 的编译证明，有意为之）→ 记录
- #7 报告 §3 的测试输出为节选（实质行与退出码齐全）→ 记录

#### 工具约束（影响流程，非缺陷）

本 harness 的 `subagent` 为**一次性执行**：agent 完成后无法用 `send_message` 恢复（`list_agents` 显示 inactive 且不再接受消息）。
因此技能规定的「fix 轮次 1–3 恢复原 implementer」在本环境退化为**携带完整上下文（brief + report + findings）派发全新 implementer**。
技能的 fallback 正为此设计："If your harness cannot send another message to a live subagent, dispatch a fresh implementer carrying the brief path, the report-file path, and the findings — the report file is the persistent memory either way."

- Task 1 fix 轮 1/5：FIX_BASE = 776be16，已派发（agent 42cbb2dc-99ec-4117-a56f-2f5223972eaa）
- Task 1 fix 轮 1/5 结果：DONE，commit `2168310`（2 文件 +30/−3）
  - `claim.ts:48` `noTime` 分组 `takenAt <= 0` → `!(p.takenAt > 0)`：两 filter 严格互补 → 分组穷尽，NaN 不再丢失
  - `claim.ts:24-30` `slice()` → 逐元素显式字段复制：状态间不再共享照片对象（未用 `{...p}`）
  - `claim.test.ts:50-60,62-68` 追加 2 个测试；**原有 6 个测试 0 行修改**
  - RED 证据（仅加测试、未改实现）：`# tests 8 / pass 6 / fail 2`
    - #7 `expected: 3, actual: 2` → NaN 照片被静默丢弃，与 finding 1 逐字吻合
    - #8 `expected: 0, actual: 999` → 新旧状态为同一对象引用，与 finding 2 逐字吻合
  - GREEN：`# tests 8 / # pass 8 / # fail 0`，exit 0
  - 额外：复跑 `assembleHap` = `BUILD SUCCESSFUL`，且 `CompileArkTS Finished 8s 878ms`（真实重编，非 UP-TO-DATE）
- scoped 再审查已派发（agent ef0b60e9-c2f6-4dc1-bc45-6e7b51856827）
  - package: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-1-fix1-review-package.txt`（92 行）
- fix 实施者疑虑（不阻塞，已记）：
  1. NaN 与 0（未读 EXIF）排序后不可区分，同归末组；若 Task 9 需区分"解析失败"与"尚未解析"需额外状态字段
     → **Task 9 的 dispatch 必须携带此点**
  2. 深拷贝只深一层；`ClaimedPhoto` 现为扁平结构故已完全隔离，已在 `claim.ts:24-25` 留注释警示
- scoped 再审查结果：**All findings addressed, no new Critical/Important breakage**（两条均 ADDRESSED，
  Ruling 5 的测试要求 SATISFIED，原 6 测试字节级未改，diff 算术自洽，无隐藏 hunk）

#### Ruling 6：把 `sourceOption.excludes` 并入 Task 2 范围（一行保险）

再审查的 out-of-scope 观察 (a)：brief Step 7 的兜底 `entry/build-profile.json5` →
`"sourceOption": { "excludes": ["**/*.test.ts"] }` **从未添加**。当前编译能过，仅因 `claim.test.ts`
不在 ArkTS 模块图内（`Index.ets → core/claim`，无 barrel 导入）。**若将来某任务加入 barrel/批量导入
把测试文件拉进图，`CompileArkTS` 会直接失败。**

裁决：**现在加上**（一行配置，零行为风险），并入 Task 2 的 dispatch；不由控制器改代码
（保持控制器会话干净、所有代码改动经过审查）。代价（若判断有误）：多一行配置。

- **Task 1: complete (commits 776be16..2168310, review clean)** —— 1 个 fix 轮，0 条 parked

### Task 2: 地点归一（geo 纯逻辑）

- BASE: `2168310`
- 状态: implementer 已派发（agent e3861ae1-7bf2-4eb7-86ac-81cdf291f07e）
- brief: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-2-brief.md`（已含 Ruling 6）
- 报告: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-2-report.md`
- 结果: DONE_WITH_CONCERNS，commit `1649c3b`（`geo.ts` +112、`geo.test.ts` +63，共 +175 行）
  - 测试: geo 9/9；完整套件 17/17（claim 4 + geo 9），exit 0，输出干净
  - TDD: RED = `ERR_MODULE_NOT_FOUND .../geo.ts`（exit 1）；GREEN = 9/9 ok（exit 0）
  - 控制器核实：提交未触碰任何 build-profile ✓；`entry/build-profile.json5` 现无 sourceOption ✓；工作树干净 ✓
  - 还原后编译：`BUILD SUCCESSFUL in 23s 620ms`
- reviewer 已派发（agent 0e7df00f-b4dd-4502-a82e-102e08cc4c61）
  - package: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-2-review-package.txt`（198 行）
  - dispatch 特别要求：**独立判断测地线数学/DMS 换算的正确性**（不只是"与 brief 一致"），并审计分支穷尽性
- **审查结果: ✅ Approved**（无 Critical、无 Important，6 条 Minor）
  - reviewer 独立手算验证：haversine 上海→北京 = 1,067,073 m（落在断言区间内）、同点精确为 `+0`；
    DMS = 31.2499504；全角逗号确实是 U+FF0C（码点扫描）；ASCII REF 四个映射全对；
    并查集 `find` 返回真根、迭代无栈风险、分组确定性且顺序稳定；`medianPoint` 奇偶均正确且不改调用方数组
  - **分支穷尽性：未发现 Task 1 那类静默丢失**（empty/<3 段/parseFloat NaN 全部 → NaN；`clusterPoints` 每个索引恰好归一个桶；
    `dedupePins` 两个 filter 严格互补）
- **Task 2: complete (commits 2168310..1649c3b, review clean)**

#### Ruling 9：立刻关闭 reviewer 的 ⚠️「geo.ts ArkTS 可编译性未验证」

reviewer 指出：**没有任何文件 import `geo.ts`**，故它极可能不在 ArkTS 模块图内，`BUILD SUCCESSFUL` **不覆盖它**
（brief:45 已豁免编译验证，故不算 Missing 缺陷）。

**裁决：立刻验证，不推迟到 Task 11。** 理由：`geo.ts` 用了 `Map` / `Map.forEach` / `Array.sort` 比较器 /
正则 `replace` / `parseFloat`——这些在 ArkTS 下都有踩雷可能（工程已在 `.apply`、`??`、`any`、非空断言上各踩过一次）。
若它编译不过，**Task 3、Task 9、Task 11 全要返工**；越早发现越便宜。

**加入 Task 3 的范围**（它是 geo 的第一个消费者，验证与消费天然同批）：
1. `geo.ts` 的所有回调参数补**显式类型标注**（Map.forEach、filter/sort/map 的 lambda），避免 ArkTS 推断出 `any`
2. 在 `pages/Index.ets` 加一个**真实 import**（引用 `GeoPoint` 或 `haversineMeters`）使其进入模块图，**提交该 import**
   （比"临时 import 后还原"更好：它让这个验证成为持续性的，而非一次性的）
3. 跑 `assembleHap`，要求 `BUILD SUCCESSFUL` 且 `CompileArkTS` 真实重编（非 UP-TO-DATE）
4. 若报错 → 修到编译通过（这属于发现真实缺陷，不是偏离计划）
代价（若判断有误）：多一次编译周期；`Index.ets` 多一行 import（该文件在 Task 6 被替换）。

#### Ruling 10 / 11：Minor 处置

- **Ruling 10（修）**：`geo.ts:189-191` `dedupePins` 的"已保留"循环重复扫描 user pins（第一个循环已证明无匹配）
  —— 死代码，且首个循环若提前退出会变成陷阱。**加入 Task 3 范围一并清理**（3 行改动，零行为风险）。
- **Ruling 11（不修，前向）**：`medianPoint([])` 返回伪造的 `{0,0}`（计划强制，brief:243）——指定管线不可达；
  若将来变成可达，应改为 NaN 或抛错。记为前向观察。
- **单链接链式效应（reviewer #4）**：`clusterPoints` 是单链接聚类，A–B–C 各距 400 m 会合成一簇，即使 A–C 相距 800 m
  → 一处"抖动拖尾"可以超出 500 m 宽度（中位数仍在云内）。**这是真实的产品级观察，转交 Task 11**
  （决定地图钉的预期半径与视觉呈现时需要考虑）。
- **测试覆盖缺口（reviewer #3）**：mandated 9 测试未覆盖偶数中位数、ASCII `'69'`(E)、小写 REF、`<= thresholdM` 边界
  → 正确性由构造保证；**Task 11 首次真实使用时补**。
- **报告措辞过强（reviewer #6）**：`task-2-report.md:133` 称"geo.ts 会被 ArkTS 扫描"，而它无消费者。
  已由 Ruling 9 的验证取代 —— 验证完成后该措辞的实质（可编译）才会为真。

#### Ruling 12：撤回控制器自己在 Task 3 简报里的一次误判（起草阶段拦截）

起草 Task 3 简报时，控制器一度把计划里的 `buckets.set(r, [i])`（plan:437/708，`placement.ts` 与 `geo.ts` 一致）
误判为 bug，并在简报里写入"修正版" `buckets.set(i, [i])`，还配了偏离授权。

**发现方式**：写完后用 grep 核实计划原文，发现两处都是 `r`，随即自行推导：
桶的 key 必须是**簇的根** `r`；若用索引 `i`，当某 `i` 恰好等于另一簇的根时会把两个簇塞进同一桶
→ `out` 少一个簇（**静默丢簇**）。**`r` 正确，`i` 错误。**

**处置**：简报已改为 `buckets.set(r, [i])`，并保留一段"控制器勘误"说明该误判，
明确"本任务不存在对该计划代码的偏离授权"。**未派发任何实现者，故零成本**。

### Task 3: 地图自适应聚散规则 + 投影

- BASE: `1649c3b`
- 状态: implementer 已派发（agent 6c0f0157-d423-4a55-8ceb-f59b476a9a4f）
- brief: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-3-brief.md`（含 Ruling 9/10 + 勘误说明）
- 报告: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-3-report.md`（待生成）
- dispatch 携带的跨任务信息：
  - Task 1 的 NaN 分组教训
  - Ruling 9：`geo.ts` 从未被编译过（无消费者）→ 必须拉进模块图验证
  - Ruling 10：`dedupePins` 死代码清理（须保持行为一致）
  - 环境事实：`sourceOption` 只接受 `workers`（加 excludes 会 schema 硬失败）
  - 环境事实：`node --test <目录>` 假红灯，必须逐文件列出

### Task 3 结果

- 状态: DONE，两个提交 —— `dc3f54b`（placement/projection/placement.test）、`191992e`（geo.ts 清理 + 模块图验证）
- 测试: placement 6/6；全量逐文件 23/23（claim 8 + geo 9 + placement 6）
- **Ruling 9 的验证手段被 implementer 证明为假绿（重要发现）**：
  只按简报加 `import { GeoPoint, haversineMeters }` + `homePoint: GeoPoint` 字段时，
  编译 `BUILD SUCCESSFUL`、`CompileArkTS` 也非 UP-TO-DATE，**但 `geo.protoBin` 并未生成**。
  根因：**ArkTS 转译器擦除未在「值位置」使用的 import**，生成物里只剩 `import type { GeoPoint }`；
  type-only import 不产生模块依赖 → 模块根本不被编译。
  修法（implementer）：让 `haversineMeters` 落在值位置（`homeToBeijingM` 字段）。
- **控制器独立核实**: `geo.protoBin` 存在（28,494 字节），`geo.ts` 已登记进编译器缓存 ✓；
  `placement.protoBin` / `projection.protoBin` / `queue.protoBin` **均不存在** ✓；`Index.ets` 值位置用法确认 ✓
- Ruling 10（`dedupePins` 死代码清理）：implementer 用**仓库外一次性差分脚本**验证等价性——
  内联 HEAD~ 旧实现逐字副本 vs 新实现，5000 组随机引脚 × 6 档阈值 + 5 个边界用例 → 0 处不一致
- reviewer 已派发（agent e1e10b70-af46-4644-bdec-064e4cde6898）
  - package: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-3-review-package.txt`（298 行）
  - dispatch 特别要求：独立验算投影数学（含 y 方向是否翻转）+ 独立判断 Ruling 10 改动的行为等价性
    （特别问：旧实现在"已保留"循环里拿含 user pins 的 `kept` 比较，会不会多排除 gps 钉？若是则新实现是行为改变）
- **审查结果: ✅ Approved**（无 Critical、无 Important，6 条 Minor）
  - 投影数学独立验算通过：四角精确（`(73,54)→(0,0)`、`(135,18)→(1000,800)`）；经度线性（墨卡托应然）；
    纬度非线性且方向正确（y(36°N)=447.26 而非 plate-carrée 的 400.00；上 9° 跨 241.4pt vs 下 9° 的 169.3pt）；**无上下翻转**
  - `clusterByScreen` 单链接实现正确：union 只连不同分量的根 → 无环；`<=` 含边界；成员索引升序、组序确定
  - Ruling 10 **被证明**行为等价（且不依赖那个差分脚本）：`dup` 循环仅在 `merged === false` 时到达，
    而它意味着**没有任何** user pin 满足阈值；`kept` 初值为 `userPins.slice()` 且此后只追加，
    故其 user-pin 前缀就是 `userPins` 本身 —— 旧循环对该前缀做的每次比较都已被第一轮循环判定为 false。
    → 有效比较集 = 其 gps 后缀 = `keptGps`，逐元素同序；返回顺序也相同。**这是对全部输入的证明，不是抽样。**
  - `geo.protoBin` 由 reviewer 独立核实存在（28,494 字节，时间戳 16:19:57，与报告一致）

#### Ruling 14：纠正控制器勘误 Ruling 12 的**机制**错误，并据此补测试

reviewer 用数值反例指出：**控制器在 Ruling 12 / Task 3 简报勘误里的机制描述是错的。**

- 控制器原话：`buckets.set(i, ...)` 会导致"**少一个簇**"（静默丢簇）。
- **实测真相**：错误 key 的失败模式是**裂成多簇**（split/extra group）。反例：
  `clusterByScreen([{x:0,y:0},{x:60,y:0},{x:30,y:0}], 40)`
  → 正确实现 `set(r,...)` 得 `[[0,1,2]]`；错误实现 `set(i,...)` 得 `[[0],[1,2]]`。
- **`r` 仍然是正确的 key**（结论不变），但控制器给出的理由错了。

**更严重的连带后果**：简报里那 6 个 mandated 测试**抓不到这个 bug** —— 测试 5 只断言 `groups.length === 2`，
而错误实现在该输入上**恰好也返回 2**。控制器当时以为"结论正确 + 测试存在"就够了，实际测试对此零保护。

**Ruling 14：**
1. 本 ledger 的 Ruling 12 机制描述**以本条为准**（结论保留，机制纠正）。
2. **补测试**（并入 Task 5 的 dispatch，它也是纯逻辑、触碰文件不冲突）：
   - `clusterByScreen` 断言**组成员身份**而非仅组数，并加入上面那个 3 点链式反例
   - 补一个中纬度 y 的断言（如 `projectMercator(100, 36, 1000, 800, [73,18,135,54]).y ≈ 447.26`，**不是 400**），
     使"把墨卡托退化成线性映射"的重实现会被测出来
   - `placement.test.ts:61` 的硬编码 `40` 改用 `MIN_PIN_DIST_PT`；`placement.test.ts:3` 未使用的 `EXPAND_ALL_MAX` 导入处理掉
3. 代价（若判断有误）：偏离计划的逐字测试清单三处；多一次 fix 派发与一次再审查。
   **放过的代价**：地图墙的聚类回归要到 Task 12 真机才发现，且"墨卡托被改回线性"这类改动不会被测出来。

#### Ruling 13：把 `placement` / `projection` / `queue` 拉进 ArkTS 模块图（并入 Task 4）

Task 3 的 implementer 上报疑虑 ①：`placement.ts` / `projection.ts` 同样无消费者，**不在 ArkTS 模块图内，可编译性未验证**
（控制器已核实 `*.protoBin` 均不存在）。它按"只做被要求的事"没有扩权 — 这个克制是对的。

**裁决：并入 Task 4 一并解决**（Task 4 会新建 `queue.ts`，它同样面临此坑；三者在同一文件里一起验，成本最低）。
要求：在 `Index.ets` 加**值位置**字段，把 `computeLayout` / `projectMercator` / `applyDecision` 都落到值位置，
然后编译并**逐个检查三个 `*.protoBin` 是否生成**（这是判真伪的唯一可靠方法）。

**这条经验已成为流程资产**：后续任何"加 import 证明能编译"的手法，都必须落在**值位置**，
否则 `BUILD SUCCESSFUL` 不代表任何东西。已写入任务简报的固定约束段。

代价（若判断有误）：`Index.ets` 多几个只为编译证明存在的字段（Task 6 会替换该文件时清理）。

### Task 4: 决策状态机与队列

- BASE: `191992e`
- 状态: implementer 已派发
- brief: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-4-brief.md`（含 Ruling 13 + 计划错误的修正）
- 报告: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-4-report.md`（待生成）
- **brief 已修正计划的一处错误**：计划 Task 4 Step 5 写 `node --test entry/src/main/ets/core/`（目录形式），
  而那正是 Task 2 实测的假红灯 → 已改为逐文件显式列出

### Task 4 结果

- 状态: DONE_WITH_CONCERNS，commit `8af0399`
- 测试: queue 11/11；全量 34/34（claim 8 + geo 9 + placement 6 + queue 11）
- Ruling 13 DONE：`Index.ets` 加了值位置字段；`BUILD SUCCESSFUL`（CompileArkTS 真实重编 3s 439ms）；
  **三个目标产物全部生成**：`placement.protoBin` 12,381 B、`projection.protoBin` 6,367 B、`queue.protoBin` 14,321 B。
  且验证测试文件未泄漏进模块图或 HAP。
- implementer 备注：无法使用 `ask_user_question`（harness 拒绝：它由存活的父 agent 拥有），
  故以最小偏离 + 上报待批准的方式处理冲突，而非阻塞。**这是正确的处置。**

#### Ruling 15：批准 Task 4 的三处偏离（brief 自身矛盾，implementer 处置正确）

**Concern 1 —— 控制器 brief 自相矛盾（已核实为真）**：

- brief Step 3 的实现产出：测试数据 `a`(takenAt 100，被 promote) / `b`(300) / `c`(200)
  → `pending = [b, c]`、`promoted = [a]` → 输出 `b → a → c`。
- brief Step 1 的测试却断言 `q[0].photoId === 'a'` → **必然 RED**。
- 根因：控制器在 brief 里写的解释"`q[0]==='a'` 是因为 `pending` 里只有 'a' 一张"
  **错配了测试 10（回忆注入）的数据**。计划原文同样有此错（plan:35 与 plan:813-825 不一致），
  控制器转录时把它带了进来。**这是控制器的错误，不是计划的错误。**

**裁决 15**：
1. **批准**修正该断言（`q[0]` → `q[1]`），因为 Ruling 4 保护的是"promoted 排在 pending[0] 之后"这一语义，
   而 `queue.ts` 与 brief 逐字一致、无需改动。
2. **批准**加入第二个 promoted 项 `d`，使 `['b','d','a','c']` 成为唯一确定顺序。
   理由：**原数据下"promoted 排在哪"根本测不出来**，这是把 Ruling 4 真正钉住所必需的。
3. **批准**新增那 1 个 `MAX_MEMORY_INJECT` 上限测试（纯追加）。
   理由：brief 的测试 10 名为"……且不超过上限"却只喂 2 条、从未触碰上限——`MAX_MEMORY_INJECT` 是零覆盖的导入。
   测试名承诺的事，测试就该做。
4. 关于"是否把 promoted 移到绝对队首"：**不授权**。Ruling 4 维持原判，见 Ruling 16。

#### Ruling 16：`deferCount` 在组内不影响排序 —— 保留语义，升级为 Task 12 的首项验证

implementer 的 Concern 3（仅上报、未改，符合我的指令）指出问题比控制器原判断更严重：
`deferCount` 只决定 promoted/非 promoted 的**布尔分裂**；组内排序只按 `takenAt`，所以"躲 3 次"与"躲 30 次"被同等对待，
而且被躲的照片通常更老 → 在 promoted 组内排得**更靠后**。**"越纠结越靠后"，与设计意图相反。**

**裁决 16**：**保留现语义，不改**。理由：
- spec §5.3 明确把"手感"的判定交给真机实测（决策间隔/回弹率/上墙转化率），而非在纯逻辑层猜测
- Task 12 正是为"实测后调参"而设；此时改动等于用推断替换测量
- 代码是计划逐字实现，且 spec 只说"跳过 3 次以上插到前面"（未规定组内再按 deferCount 排）

**升级为 Task 12 的首要验证项**（并写入 Task 12 的 dispatch）：
候选方案二选一——(a) promoted 整个移到 `pending[0]` 之前；(b) promoted 组内按 `deferCount` 降序排。
代价（若判断有误）：可能在真机上表现为"躲了很多次的照片仍然不显眼"，Task 12 才发现并调整。

#### Task 4 其余前向观察（已记，当前不可达，未改）

- `applyDecision` 不校验前置状态（对 `unseen` 的照片 `unwall` 会得到 `faved`）
- `buildQueue` 不对同时出现在 `all` 与 `todayMemories` 的 photoId 去重
→ 两者今日均不可达（调用方尚不存在），交最终审查三方裁决。

- 控制器独立核实 Ruling 13：**五个 core 模块的 `*.protoBin` 全部存在**
  （claim 11,597 / geo 28,494 / placement 12,381 / projection 6,367 / queue 14,321 字节）；工作树干净
- reviewer 已派发（agent ddfc1f35-ddc1-461d-9233-3e27ecbae2c7）
  - package: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-4-review-package.txt`（235 行）
  - dispatch 特别要求：**独立推导** `['b','d','a','c']` 这个期望顺序是否正确
    （含核对 `d` 的 `deferCount` 是否真 ≥ 3、promoted 组内是否按 `takenAt` 降序），不要只看 implementer 的说法

### Task 5: 验收指标埋点 + Ruling 14 反回归测试

- BASE: `8af0399`
- 状态: implementer 已派发（agent 575de2a7-5fdf-4f40-9e67-201a19d36089）
- brief: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-5-brief.md`
- **dispatch 特别强调**：Ruling 14 的三处测试价值高于任务主体，且必须用**变异测试**证明新测试会失败
  （临时把 `placement.ts` 的 `buckets.set(r,...)` 改成 `set(i,...)` → 跑 → 必须 FAIL → 还原 → 全绿），原始输出入报告
- **Task 5 的 implementer 无法使用 `ask_user_question`**（harness 限制：归属于存活父 agent）→ 已在 dispatch 中说明：
  有疑问就在最终消息里问或用 NEEDS_CONTEXT 回报，不要因无法提问而猜测或空转

### Task 4 审查结果

- **审查结果: ✅ Approved**（无 Critical、无 Important，8 条 Minor）
- reviewer **独立推导**确认了争议期望顺序 `['b','d','a','c']` 正确（`a`/`d` 的 `deferCount` 恰为 3，
  `>=` 成立；promoted 组内按 `takenAt` 降序），并指出该测试**非空洞**（`>=`→`>` 或 promoted 移位都会使其失败）
- reviewer **独立核实 Ruling 13**（读磁盘产物）：三个 `*.protoBin` 字节数逐一吻合；
  `Get-ChildItem entry\build -Recurse -Filter "*test*"` **无结果** → 测试文件未进模块图或 HAP（Ruling 7 约定完好）
- 分支穷尽性：`applyDecision` 的 `unfav || unwall` 分支对两者分别产出 `unseen`/`faved`，
  6 成员 `Action` 联合下 fall-through 仅 `skip` 可达 ✓

#### Ruling 17：`Index.ets` 的模块图守卫必须在 Task 6 存活（架构性风险）

reviewer Minor #8 指出：`Index.ets:3-5,21-27` 那几个值位置字段是 `placement`/`projection`/`queue`
留在 ArkTS 模块图里的**唯一原因**。**Task 6 会把该页替换为 `ClaimPage`——若那些用法被丢掉，
会静默退回"假绿"状态**（`BUILD SUCCESSFUL` 但 `*.protoBin` 不再生成）。

**裁决 17**：Task 6 的 dispatch **必须携带**：
1. 在替代页面中保留对 `placement` / `projection` / `queue` 的**值位置**使用（或等价手段）
2. **保留 `*.protoBin` 存在性检查作为 Task 6 验收的一部分**（列出全部应存在的 core 模块产物）
3. 把这条经验写成代码注释留在页面里（Task 3 的 implementer 已示范过这个做法，值得延续）

代价（若判断有误）：`Index.ets` 的替代页多几行只为编译证明存在的字段。

#### Ruling 18：检查持久化数据的状态/动作合法性 —— 转交 Task 6/8

reviewer Minor #3/#4 指出同一类风险：`queue.ts:41-42` 的 `skip` 是 fall-through，
故**联合类型之外的值**（未来调用点写错的动作名、或从持久化里回放的字符串）会被**静默当成 skip**——
`deferCount+1` 且把已归档/已收藏的照片复活为 `unseen`；同理 `queue.ts:59` 对无法识别的 `state`
会**静默把照片从每个队列里移除**（与 Task 1 的 NaN 教训同一形状：filter 里的静默丢弃）。

**裁决 18**：**不在 `queue.ts` 里加校验**（纯函数保持简单；联合类型今日封闭）。
改为**前向要求**：**Task 6（落盘）与 Task 8（决策落盘）的 dispatch 必须携带 ——
加载持久化数据时校验 `state` 与 `action` 的合法性，非法值不得静默通过。**

代价（若判断有误）：该校验推迟到数据边界层，若 Task 6/8 遗漏则风险残留。

#### Ruling 19：Minor 批（并入 Task 6 之前的 fix 轮）

- **修（批处理）**：
  1. `queue.test.ts:33-37` 测试名承诺"deferCount 不变"却检测不出"被重置为 0"（输入 `faved` 的 `deferCount` 本就是 0）
     —— 与 Ruling 15.3 修掉的 `MAX_MEMORY_INJECT` 缺陷同类。修法：输入改为
     `applyDecision(applyDecision(emptyDecision('p1'),'skip',1),'fav',2)`，断言 `unfav` 后 `deferCount === 1`
  2. **补一个同时含 promoted + memories + 其余 pending 的顺序测试**：reviewer 验证过，
     **交换 `queue.ts:69` 与 `:71` 两个循环，现有套件仍然全绿**，而这会改变 spec 规定的顺序 → 必须补测
  3. `queue.ts:2` 注释说"三个刻意的取舍"却列了四项 → 改为"四个"
- **不修（记录）**：Minor #5（`takenAt` 为 NaN 时等效未排序 → 归 Task 7 数据源规范化）、
  Minor #7（报告的证据方法过滤掉了 `//` 行，故看不到第二处新增注释——证据主张弱于其表述）

- **Task 4: complete (commits 191992e..8af0399, review clean)** —— 0 个 fix 轮，0 条 parked
- **Fix 批 1（待 Task 5 完成后派发）**：Ruling 19 的三项（`queue.test.ts` 断言加强、
  补 promoted+memories+pending 顺序测试、`queue.ts:2` 注释三→四）。并入 Task 6 之前执行。

### Task 5 结果

- 状态: DONE_WITH_CONCERNS，两个提交 —— `76e8690`（metrics）、`6d9bc89`（Ruling 14 反回归测试）
- 测试: **控制器亲自复跑 = 45/45 pass，exit 0**（claim 8 + geo 9 + placement 10 + queue 11 + metrics 7）
- 控制器独立核实：`placement.ts` / `projection.ts` **零改动**；`placement.ts` SHA256 = `FD73C348…4CEC`（与其声称一致）
- 变异测试（brief 要求）：`set(r,[i])`→`set(i,[i])` → 指定测试 FAIL（`2 !== 1`）→ 还原后 10/10 全绿
- 额外变异（implementer 主动）：`projection.ts` 换线性映射 → 新测试 FAIL（`实际 400`），**而旧测试 6 仍 ok**
  —— 实证了"旧测试对墨卡托退化不设防"的判断

#### Ruling 20：批准追加乱序反例测试；回填 Ruling 14 的缺陷

implementer 上报：**brief 里 Ruling 14 ① 的第一条测试，按它自己的输入顺序抓不到它声明要抓的 mutation**
（变异后仍 `ok 7`）。根因：控制器用的是**升序**输入 `[{0,0},{30,0},{60,0}]`，
而 reviewer 给的反例是**乱序** `[{0,0},{60,0},{30,0}]`。升序下并查集三点根**恰好都是索引 0**，
于是首插 `set(i=0)` 与后续 `get(r=0)` 的 key 撞上，缺陷被掩盖。

**这等于控制器让 Ruling 14 重演了它要消灭的"测试存在但不设防"。**

**裁决 20**：**批准**其处置 —— 不改 brief 给定代码，**额外追加**一条乱序反例测试
（`placement.test.ts` 现有 10 个测试，含 `'…乱序输入的链式相邻仍连成一簇（根作 key，非索引作 key）'`），
并把它作为唯一能钉死"根作 key"的输入顺序。代价（若判断有误）：多一个测试；两条链式测试几何相同、仅顺序不同。

**同时记录**：Ruling 14 的正文（本 ledger 与计划文档）**按此更正** —— 有效的反回归输入必须**乱序**，
升序输入因根与索引重合而掩盖该类缺陷。这是可复用的教训，已写入 Task 6+ 的约束段。

#### Ruling 21：`medianDecisionMs` 空状态返回 0 会"假达标" → Task 12 必读

implementer 提醒：`medianDecisionMs(emptyMetrics())` 返回 `0`，而 `0 < 1200ms` 目标 ——
**Task 12 若直接拿这个 0 判定，会得出"已达标"的错误结论。**

**裁决 21**：不改 `metrics.ts`（空输入返回 0 是合理默认）。**改为 Task 12 的 dispatch 必带约束**：
判定三项指标前必须先检查 `metrics.events.length > 0`（样本不足时报"样本不足"，不得报"达标"）。
代价（若判断有误）：Task 12 的判定逻辑多一个前置分支。

#### 测试计数勘误（控制器的算术错误，第二次）

brief 预期 42，实际 45。三处偏差：
1. `queue.test.ts` 在 Task 5 的**起始 HEAD 上就是 11 个**（非本任务引入）—— 控制器误记为 10
2. `placement` 实为 **10** 而非 8 —— implementer 新增 4 条（①两条 + 乱序反例 + ②），控制器只算了 2 条
3. 控制器把"Ruling 14 新增测试数"与"placement 测试总数"混算

→ 控制器在写预期值时未逐一清点既有测试数。**这是本会话第二次算术错误**（上次是 Task 4 brief 的 claim 4/8）。
**约束**：后续 dispatch 的"预期测试数"必须由控制器**先清点再写**，不得凭记忆推算。

- reviewer 已派发（agent bb4dc3ee-692b-41cb-9f5b-11f31784b04a）
- package: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-5-review-package.txt`（239 行）
- dispatch 特别要求：**独立验证那条乱序反例测试是否真的能钉住"根作 key"**（纯推理，禁止临时改文件）

### Fix 批 1（Ruling 19）

- BASE: `6d9bc89`
- 状态: implementer 已派发（agent 55666ed6-010b-449b-92c8-6ac1c627985b）
- 范围：③ 条 —— `queue.test.ts` 加强 `deferCount` 断言；补"四段顺序"测试；`queue.ts:2` 注释三→四
- dispatch 要求：**变异测试证明**新顺序测试有鉴别力（临时对调 promoted/memories 循环 → 必须 FAIL → 还原 → 全绿）；
  且**要求 implementer 独立推导期望顺序**，若与控制器写的不符则停下上报而非照抄
  （教训来自 Ruling 20：控制器写进测试的期望值本身可能是错的）
- 报告: `.superpowers/sdd/2026-10-08-photo-wall-m1/fix-batch-1-report.md`

### Task 5 审查结果

- **审查结果: ✅ Approved**（无 Critical、无 Important，5 条 Minor）
- reviewer **独立重推**了那条乱序测试的有效性（这是控制器特别要求的）：
  乱序输入下 `parent=[1,1,0]` → 变异版 `buckets.set(i,[i])` 得 `[[0],[1,2]]` → 测试在 `:114` 以 `2 !== 1` 失败 ✓；
  **升序输入下 `parent=[0,0,0]`：每点根都是 0、索引 0 又是自身根 → 变异的写键与读键相撞 → 两种实现都返回 `[[0,1,2]]`，对变异盲**
  → **从代码证明了 Ruling 20 的根因判断**，并确认新测试有效
- 字节保真度由 reviewer **机械复核**（非采信报告）：`metrics.ts` 43/43 行 EXACT、`metrics.test.ts` 49/49 行 EXACT
- 投影数学由 reviewer **独立重算**：`mercY(36)=0.6742756 → y(36)=447.26`；`topSpan≈194.2 > botSpan≈136.2`；
  线性退化恰为 400 → 测试有鉴别力 ✓
- 变异的失败栈指向 `placement.test.ts:104`（测试）与 `:114`（断言），与提交文件行号吻合 ✓

#### Ruling 22：测试计数基线 = **46**（当前 HEAD）

reviewer 指出 Task 5 报告记的 45 与"当前修订"不符（Minor #1）。**控制器裁断：Task 5 报告没错**——
45 是 `6d9bc89` 时的真实值（+8+9+10+11+7）。但 **Fix 批 1（`3fea687`）往 `queue.test.ts` 加了 1 个测试**，
故 **当前 HEAD（`3fea687`）的基线是 46**，控制器已亲自复跑确认（`# tests 46 / # pass 46 / # fail 0`）。

→ **后续 dispatch 的"预期测试数"一律以 46 为基线**（Task 6 不写新单测，故仍为 46）。

#### Ruling 23：批 2（注释纠错 + 补两条测试）并入 Task 6

- **批 2a（注释纠错，低成本防误导）**
  1. `placement.test.ts:107` 的注释"这是唯一能真正钉死…的输入顺序"**表述过强**：
     reviewer 枚举了同三点全部 6 种排列，**有两种对变异敏感**（`{0,2,1}` 与 `{2,0,1}`）
     → 改为"是能暴露该类缺陷的输入顺序之一"
  2. `placement.test.ts:75-76` 的注释称索引作 key "会裂成 [[0],[1,2]] —— 此测试必须失败"，
     **对它自己的升序输入可证伪**（根全为 0）→ 改为指向 `:104` 那条真正会失败的测试
     （**不改测试本身**，Ruling 20 不动）
- **批 2b（补两条测试，堵真实覆盖缺口）**
  3. `rollbackRate` 的空状态保护（`metrics.ts:34`）**从未被任何测试触及**（median 的空态有测，rollback 的没有）
  4. 脏数据测试（`metrics.test.ts:45-48`）只断言"没被 push"，**未验证丢弃后状态仍可用**（后续合法 swipe 应得长度 1）
- 代价（若判断有误）：多两处注释改动 + 两条测试；`placement.test.ts` 被再次触碰（其内容已审查两次）

- **Task 5: complete (commits 8af0399..6d9bc89, review clean)** —— 0 个 fix 轮，0 条 parked
  （后续 Fix 批 1 = `3fea687` 追加在其后，属 Ruling 19 的独立范围）

### Task 6: 认领流程接通真机（第一个真机任务）

- BASE: `3fea687`
- 状态: implementer 已派发（agent 7f239eab-1868-40aa-ab32-1972b36c9394）
- brief: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-6-brief.md`
- dispatch 携带的修正与补充（计划里没有或写错的）：
  1. **包名 = `com.example.photospike`**（计划写的是 `photowall`，错的）
  2. **`MEDIA_LOCATION` 已存在**（复用探针工程时带入），不要重复添加 → 改为验证
  3. **Ruling 17 守卫迁移** + **把 `core/metrics` 也纳入守卫**（Task 5 的 reviewer 指出它同样无消费者、编译包含性未证）
     → 六个 `*.protoBin` 全部验证
  4. **Ruling 18 持久化校验**（`ClaimStore.load()` 逐字段校验，非法数据不得静默通过）
  5. **批 2**（Ruling 23）作为前置小修：两处注释纠错 + 两条 `metrics.test.ts` 测试（46 → 48）
- 真机步骤：**待用户执行**（控制器沙箱无法运行 `hdc`）

### Task 6 结果

- 状态: DONE，commit `309dddd`（7 文件 +175/−42），另加 `7be5bd7`（应用名改为「照片墙」）
- 批 2（Ruling 23）：两处注释纠错 + 两条 `metrics.test.ts` 测试 → 套件 **46 → 48 全 pass**
- 编译：清空 build + hvigor 缓存**全量重建** → `BUILD SUCCESSFUL`、0 ERROR
- **六个 core `*.protoBin` 齐全**（`metrics` 9862 字节**首次生成**）；测试泄漏检查无结果
- **implementer 抓到控制器 brief 漏掉的致命改动**：`EntryAbility.ets:20` 硬编码 `loadContent('pages/Index')`；
  只删 `Index.ets` 会让 **App 启动加载不存在的页面而崩溃**（改对 `main_pages.json` 也没用）。已改为 `'pages/ClaimPage'`。
- **implementer 主动做证伪实验**：临时删掉 `metrics` 守卫 → 全量重建 → `BUILD SUCCESSFUL` 但 `metrics.protoBin` 消失
  → **实际复现了 brief 描述的假绿陷阱**，证明守卫确实承重（而非"因别处连带引用而恰好成立"）。实验后已还原重建。
- Ruling 18 校验在 ArkTS 下编译通过，**未降级**
- 控制器核实：工作树干净；HAP 与 HEAD 一致（`CompileArkTS UP-TO-DATE`）；
  **解包 HAP 核验权限恰一项 `ohos.permission.MEDIA_LOCATION`**；六个 `protoBin` 齐全；无 `Index` 残留引用

#### ✅ 真机验收通过（用户实测）—— M1 技术地基确认

| 验收项 | 结果 |
|---|---|
| 点「认领照片」弹出系统选择器 | ✅ |
| 多选 | ✅ 可用；**无「全选」按钮**（印证探针观察：系统允许多选但不给一键认领整库） |
| 选 10 张的速度 | ✅ 很快 |
| 点按钮时是否卡顿 | ✅ 不卡 |
| 界面错位/白屏/闪退 | ✅ 均无 |
| **杀掉 App 重开、累计数不变** | ✅ **通过 —— 落盘生效** |

**这条的产品含义（写入设计认知）**：**「分批认领 → URI 永久有效 → 有限刷 → 地图墙」路线在真机成立**，不再是探针里的一次性现象。
且"无全选"意味着**每批认领的粒度必然是"一次旅行/一个事件"级别**，这与 spec §2.4 的代价陈述一致，也反过来强化了"回忆馆而非清理工具"的定位。

### Task 6 审查结果

- **审查结果: Needs fixes** —— 1 条 Important（plan-mandated，由控制器 brief 带入）+ 4 条 Minor
- reviewer 独立核实通过：
  - **Ruling 18 有效且完整**：`claimStore.ets:43` 早返回 / `:48-49` photoId 非串或空 → `continue`（过滤而非保留）/
    `:52-54,:57-58` 四个数值字段 `typeof`+`Number.isFinite` 兜底 / `:59` 返回恰为 `ClaimState` 两字段、
    元素恰为 `ClaimedPhoto` 四字段（无一遗漏、无一多余、**未降级**）；`load()` 全路径有返回，无 fall-through
  - **IO 无句柄泄漏**：`openSync(:31)` 紧接 `try{readSync}finally{closeSync}(:32-36)`，中间无抛点；`save :66→:68-72` 同理
  - **Ruling 17 承重且迁移完整**：六个模块全部为 **CALL-position**（非 type-only）；
    磁盘产物六个 `*.protoBin` 齐全、`Index.protoBin` 已消失；且**真机通过反证了守卫初始化确实执行**
    （若 `computeLayout`/`medianDecisionMs` 抛异常会阻塞渲染）
  - **控制器怀疑的 Critical 被排除**：`claimShape` 用的是 `emptyClaimState()`（`ClaimPage.ets:26`），
    真正的 `load()` 在 `aboutToAppear`（`:41-42`），**字段初始化期不接触 `this.store`**；守卫依赖顺序正确

#### Ruling 24：UTF-8 缺陷 —— 先证明可达性，再定级（已由控制器实证为不可达）

reviewer 的 Important #1：`claimStore.ets:37-39` 用 `String.fromCharCode` **按字节**拼串，
**那不是 UTF-8 解码**。`save()` 经 `JSON.stringify` 写 UTF-8，故**任何非 ASCII 的 photoId 在读回时损坏**
→ `mergeBatch` 去重失败 → 同一照片存两次、累计虚高，且 mojibake 每轮 save/load 累积。

**控制器实测（发现 `hdc` 在本沙箱可用后直接读设备文件）**：

```
/data/app/el2/100/base/com.example.photospike/haps/entry/files/claimed_photos.json
41 条 URI，形如 file://media/Photo/8198/IMG_1791448931_6657/screenshot_20261008_164030_com.tencent.wechat.jpg
非 ASCII 字符数 = 0
```

→ **缺陷当前不可达**（鸿蒙相机/截图的文件名是 ASCII）。reviewer 的"必须证明而非假设"要求已满足。

**裁决 24**：**仍然修**（一行，`buffer.from(buf).toString('utf-8')`，该写法在探针工程已真机验证过），
但**定级降为 Minor（latent，已修）**，因为：
- 触发条件存在（用户从微信/其他 App 保存的中文文件名照片会进入相册并被认领）
- 后果是静默数据损坏 + 累积，且**真机测试覆盖不到**（用户恰好选的都是 ASCII 名）
- 一行修复成本，无行为风险

**并把"证明可达性"的做法记为流程资产**：对"可能不可达的缺陷"，先用设备实证给出判定，
而不是按最坏情况排优先级，也不是假设它没问题。

#### Ruling 25：Minor 处置

- **修（并入同一 fix）**：Minor #2 `claimStorePath` 在 `claimStore.ets:6-8` 与 `core/claim.ts:40-42` **重复定义**
  → 改为从 `core/claim.ts` import（brief 的 Consumes 行本来就是这么写的）
  - 副带好处：`core/claim.ts` 的 `claimStorePath` 是有单测的（`claim.test.ts:36-37`），
    而 `claimStore.ets` 里那份没有；消除重复后两处行为一致有保障
- **修（并入同一 fix）**：Minor #3 `load()` 里 `lastBatchId → 0` 未与保留照片的 `batchId` 交叉校验
  → 改为 `Math.max(0, ...)` 并与已保留项的最大 `batchId` 取大（防止损坏的计数器复用**在用**的 batchId）
- **记录（前向要求）**：Minor #4 损坏文件 → 静默空状态 → 下次 `addBatch` **TRUNC 覆盖、旧认领无声丢失**；
  `save()` 非原子。→ **写入 Task 8 的 dispatch**：加 `hilog.warn` + 临时文件+rename 的原子写。
- **真机待验（写入 Task 7 的真机验收清单）**：Minor #5 若 picker 取消会 **reject**，
  用户会看到红色"认领失败"而非中性路径 → 请用户**取消一次**选择器确认。

### Task 6 fix 轮 1（Ruling 24/25）

- FIX_BASE = `7be5bd7`，commit `fbc85c3`（1 文件 +13/−9，仅 `claimStore.ets`）
- 控制器核实：工作树干净；只改 1 文件；`buffer.from(buf).toString('utf-8')` 到位；
  `claimStorePath` 本地定义已删净（只剩 :4 import 与 :25/:70 调用）；`lastBatchId = Math.max(Math.max(0,rawLast), maxSeen)`；
  **复跑 48/48 pass**
- 再审查（agent 7698d351-ca4f-4e30-aac2-6a4c93d10477）：**三条全部 ADDRESSED，无新 Critical/Important**
  - reviewer 核对 SDK 声明：`@ohos.buffer.d.ts:155` `from(arrayBuffer, byteOffset?, length?)` 默认解全量、
    `:49` BufferEncoding 含 `'utf-8'`、`:829` `toString(encoding?)` → **不是等价错误**
  - 全仓库 grep `String.fromCharCode|Uint8Array|TextDecoder` under `entry/src` = **0 命中** → 旧路径无残留
  - `maxSeen` 遍历的是 Ruling 18 过滤后的 `valid`（`claimStore.ets:56-59`），空数组 → 0，边界正确
  - `load()` 全路径有返回（`:40`/`:63` try、`:65` catch）；`Math.max` 语句完整（reviewer 直读提交文件确认）
  - 无新消费者引用 `data/claimStore`（仅 `ClaimPage.ets:3` import `{ ClaimStore, pickPhotos }`）→ 48/48 Node 套件不受影响

- **Task 6: complete (commits 3fea687..fbc85c3, review clean)** —— 1 个 fix 轮，0 条 parked

### Task 7: 滑动卡片（原生手势 + 弹簧回弹 + 埋点）

- BASE: `fbc85c3`
- 状态: implementer 已派发
- brief: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-7-brief.md`
- **brief 含控制器三处修正**（计划里有错）：
  1. `settle()` 的 `const w = 360` 是**硬编码**（计划注释写"用真实宽度替换"却从未兑现）
     → 改为 `@Prop cardWidth` 由父组件经 `onAreaChange` 传入真实宽度。**这条最影响手感**
  2. `QueueItem` 定义在 `SwipePage.ets` 但 `CardStack.ets` 要用它、计划漏了 import → 移到 `ui/CardStack.ets` 并导出
  3. `CardStack` 有 `startT` 却从不读（度量由 `SwipePage.shownAt` 承担）→ 删除死状态
- **真机验收清单新增一条**：请用户**取消一次选择器**，确认提示是中性文案而非红色报错（Ruling 25 的 Minor #5）
- **前向要求（写入 Task 8）**：Ruling 25 Minor #4 —— `save()` 加 `hilog.warn` + 原子写（临时文件 + rename）

### Task 7 结果

- 状态: DONE_WITH_CONCERNS，commit `c7b254b`（新增 `ui/CardStack.ets` 107 行、`pages/SwipePage.ets` 82 行；
  改 `main_pages.json`、`ClaimPage.ets`；`core/`、`claimStore.ets`、`EntryAbility.ets`、`module.json5` 未动）
- clean 后全量重建 → `BUILD SUCCESSFUL`，ERROR 0 次；**六个守卫 protoBin 全在** + 新增 `SwipePage`/`CardStack` protoBin
- 单测基线 48 全 pass（控制器将复跑确认）
- 解包 HAP 抽查：`main_pages.json` 含 SwipePage、`bundleName=com.example.photospike`、`modules.abc` 含 `cardWidth`/`onAreaChange`/`commitDist`
- 三处修正落地：① `onAreaChange` 主路（未用 display 退路）② `QueueItem` 定义并导出在 `ui/CardStack.ets` ③ `startT` 已删
- **一处必要偏差**（编译硬约束）：brief 的 `map((p) => ({...}))` 触发 `arkts-no-untyped-obj-literals`
  → 改为显式类型局部变量（`SwipePage.ets:25-28`），语义零差异，已就地注释

#### Ruling 26：阈值分母错位（页面宽 vs 卡宽）—— 修

控制器读码核实（`SwipePage.ets:55-59` + `CardStack.ets:43,70-71`）：

```
onAreaChange 挂在 .width('100%') 的 Stack 上 → cardW = 页面宽
卡片自身 .width('86%')
settle(): commitDist = cardW * 0.28 = 页面宽 * 0.28
```

→ **实际阈值 = 0.28/0.86 ≈ 32.6% 卡宽**，比 spec 的 `COMMIT_DISTANCE_RATIO = 0.28` 语义（卡宽比例）大 16%。
实施者称"360vp 机上与旧魔数结果相同"是**该设备上的数值巧合**，不改变缺陷性质：阈值以页面宽为基准，
在宽屏/分屏下会进一步偏离。

**裁决 26：修**。做法（取卡宽为基准，且不引入重复魔数）：
`SwipePage` 里把卡片宽度比例提为具名常量，`onAreaChange` 里 `cardW = Stack宽 * CARD_WIDTH_RATIO`，
并在注释写明"阈值以**卡宽**为基准（spec 的 0.28 语义是卡宽比例）"。
一行等价方案（`cardW = newVal.width * 0.86`）若更简洁亦可，但**必须具名常量、不得散落字面量**。

代价（若判断有误）：改动阈值语义使实际触发距离变小 14%，手感需在真机上重新确认（本来也要确认）。

#### Ruling 27：`animating` 只写不读 —— 改成真正的闸门

`CardStack.animating`（`CardStack.ets:25,85,95`）只被写、从不被读（与已删的 `startT` 同类）。
**但它的缺失有实际后果**：卡片飞出的 230ms 里手势仍可被受理，用户快速连划会让**同一张卡片被决策两次**
（`handle()` 被调两次 → `idx` 前进两格 → 跳过一张照片）。

**裁决 27：改成真正的闸门**（既消除死状态、又堵住重复决策）：
- `onActionStart` 里：若 `this.animating` 为真则忽略本次手势（不改 `lastX/lastT/velocity`）
- `onActionUpdate` / `onActionEnd` 同理加守卫，或在 `settle()` 开头早返回
- 回弹路径不设 `animating`（回弹期间用户本来就该能继续操作）

代价（若判断有误）：极快连划时有一次手势被忽略（比"跳掉一张照片"好得多）。

#### Ruling 28：飞途中退出页面的 timeout —— 加 clearTimeout

`flyOut` 的 `setTimeout(...,230)` 在组件已卸载（用户 230ms 内返回上一页）时会对已卸载组件调一次 `handle()`。
控制器判定为 no-op 级（不崩），但**顺手加 `aboutToDisappear` 里 `clearTimeout` 更干净**。
**并入 Ruling 26/27 同一 fix 轮。**

#### 其余疑虑处置（记录，不在本 fix 轮）

- **`flyOut` 220ms/230ms、`rotate` 系数 `/24`**：属**真机手感调参**，正是 Task 12 的范围 → 记录，Task 12 一起看
- **3 条 deprecation WARN**（`animateTo`×2 / `pushUrl` / `getContext`）：控制器接受，**单独 chore 统一迁移**，不在功能任务里混改

#### ✅ Task 7 真机验收通过（用户实测）

用户实测反馈：**「手感挺好的」**；左/右滑甩得出去、轻甩能过、拖了弹回、指标在动。

#### fix 轮 1（Ruling 26/27/28）与分析

- FIX_BASE `c7b254b` → `ad6e22a`（`CARD_WIDTH_RATIO` 具名常量 + 换算；`animating` 三处守卫；`flyTimer` + `aboutToDisappear`）
- re-review（agent c05f83c9-e95d-4718-b739-9889dc5e82a5）：三条 **全部 ADDRESSED**，但**新引入 1 条 Important**
- **Important（控制器的裁决引入了缺陷）—— 陈旧手势基线泄漏**：
  控制器把 `if (this.animating) { return; }` 放在 `onActionStart` **首行**，于是**早退跳过了 `lastX`/`lastT`/`velocity` 的赋值**。
  一次跨越 230ms 边界的拖拽（按下在飞出后、按住越过边界）会在解禁后的首个 update 用**陈旧 `lastX`** 算速度
  → `|Δ| > 0.8×dt` 极易满足 → `|velocity| > 800` → **新卡片在几十 vp 拖动下被误判 fav/archive**（无回滚入口）。
  **这是 Ruling 27 指定写法本身的副作用，不是实施者偏航** —— 控制器只想了"要挡住手势"，没想到"早退跳过初始化"。

#### Ruling 29：回弹上报防抖（修）

`rolledBack` 是 spec §5.3「回弹率 < 3%」的**唯一数据源**。回弹路径不设 `animating`（有意，保证回弹期间可继续操作），
但快速连划会**重复上报同一次回弹** → **指标被污染，验收失去意义**。
修法：`SPRING_BACK_MS` 窗口内重复 `springBack()` 只归位、不重复上报；`flyOut` 时清 `springTimer`。
实施者指出该清理「当前不可达」（150 < 230 使残留窗口自然过期），但**保留**，理由是：
正确性目前依赖 `SPRING_BACK_MS < flyTimer` 这个**跨常量不等式**（两常量相隔 100 行），
一旦调参就会**静默漏报下一张卡的首报、让回弹率偏低** —— **「自证清白型失真」**，最难发现。控制器采纳。

#### Ruling 30：回弹率口径确认（不改，加注释）

实施者质疑 `core/metrics.ts` 的 `rollbackRate` 分母是**事件数**而非**卡片数**，疑与 spec 口径有偏差。
**控制器裁断：当前口径正确。** spec §5.3 的指标是**误操作率**——「滑动尝试里有多少次被中途放弃」，
不是「多少张卡片曾出现过回弹」。一张卡被回弹后成功滑出会贡献 2 个事件，正是"消耗了 2 次尝试"的忠实反映。
且防抖保证同一次回弹不重复计数，故前提成立。
**动作**：给 `rollbackRate` 加口径说明注释（`b49dd74`，仅注释、未改逻辑），防止后人按卡片数改错。

#### fix 轮 2（`0d1eeb0`，控制器直接执行）

- 手势基线改回**无条件刷新**（守卫移到赋值之后），闸门职责仍由 `onActionUpdate` 与 `settle()` 承担
- `animating`/`dx`/`dy` 的归位**提到 `onDecide` 之前**（若回调抛错，闸门留在 true 会让**整页手势死锁**，因实例被复用）
- 控制器核实：单测 48/48、`BUILD SUCCESSFUL`、六个守卫产物齐全
- re-review 已派发（agent 99acf010-c36e-4d27-86ca-df4e3d416138）；
  特别要求它独立推理「`onActionUpdate` 的守卫是否造成**同类**陈旧基线问题」

- 遗留 Minor（潜伏）：闸门可被异常永久置真 —— 已由 fix 轮 2 的"归位提前"消除主要路径

### Task 8: 决策落盘 + 收藏页 + 上墙窗口期

- BASE: `0d1eeb0`
- brief: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-8-brief.md`
- **brief 含五项修正**（计划的 `decisionStore.ets` 是从 `claimStore` 复制的，把三个已修缺陷也带来了）：
  1. 包名 `com.example.photospike`（计划写 `photowall`）
  2. `loadAll()` 必须用 `buffer.from(buf).toString('utf-8')`（**同为 Ruling 24 的 UTF-8 缺陷**）
  3. `pathOf` → 命名与 `claimStorePath` 一致的本文件私有函数
  4. `loadAll()` 必须校验形状（Ruling 18 同类要求）—— 尤其 `state` 非法者**必须跳过**，
     否则会流入 `buildQueue`（它对非法 state 会**静默移除照片**）
  5. `saveAll()` 改**原子写**（tmp + rename）+ `hilog.warn`（Ruling 25 Minor #4 的前向要求）
- **brief 另补一项计划漏掉的必需改动**：`SwipePage` 载入时必须**跳过已决策的照片**，
  否则杀掉 App 重开后已刷过的照片会全部重新出现（用户会认为决策没保存）

#### Task 8 实现结果

- 状态: DONE_WITH_CONCERNS，commit `35194a5`（5 文件 +254/−5）
- 全量重建 → `BUILD SUCCESSFUL` / 0 ERROR；六个 core 守卫产物 + `decisionStore`/`FavPage` 产物齐全；单测 48/48
- 六项修正全部落地；`Array.isArray` / `hilog.warn` / `fileIo.renameSync` / `as DecisionState` **四个全部按预期编译通过**，无降级
- **implementer 自查抓到一个编译期看不出的缺陷**：`private dStore = new DecisionStore(this.ctx)` 若声明在 `ctx` 之前，
  字段初始化顺序会让 `ctx` 为 `undefined`（**编译器不报错**）→ 已放到 `ctx` 之后并核对转译产物行序
- **implementer 指出控制器 brief 自相矛盾**：修正说明 ③ 要求 `decisionStorePath` 不 export，而 Step 1 代码块写了 `export`
  → 它按修正说明走（不 export）并标注。**这是控制器的疏忽**（Ruling 31 确认以修正说明为准）
- 跳过已决策的方式：简单 filter（`d === undefined || d.state === 'unseen'`）+ 现有认领倒序，
  **不用 `buildQueue`**（它要 `takenAt`，而 `ClaimedPhoto.takenAt` 全是 0 → 排序退化、假装严谨）。控制器认可该判断。

#### Ruling 31：brief 自相矛盾以修正说明为准（确认 implementer 的处置）

`decisionStorePath` 不 export。控制器承认 Step 1 代码块与修正说明 ③ 冲突是自身疏忽；
implementer 按"说明是主要意图"处置正确。

#### Task 8 审查结果

- **APPROVED**（无 Critical、无 Important，5 条 Minor）
- reviewer 独立验证四项风险，**控制器最担心的数据丢失模式被证明结构上不存在**：
  `this.decisions = existing` 是**完整盘上 Map**（`loadAll` 返回全部合法记录），
  且 `set()` 每次写前重读文件 → **任何内存子集都不可能被写回**
- 其余三项也逐一验证：① `loadAll` 的 UTF-8 解码与形状校验正确完整（所有跳过路径都精确计数、非法 state 到不了 `buildQueue`；
  畸形输入不会抛穿——整个第二段 try 包住了 stat/open/read/decode/parse/loop；空文件 `JSON.parse('')` 抛错被 catch）；
  ② 原子写正确（tmp 与目标**同目录**、`renameSync` 是最后一步；句柄在所有路径配对，无泄漏）；
  ④ 窗口时序正确（仅 `fav` 开窗、重复收藏先清旧 timer、`promoteToWall` **先落盘再清提示**、双击幂等）
- 额外独立验证（控制器未要求）：`Alignment.Bottom` 在该 SDK 下等价于 Stack 的 `alignContent`，
  且卡片居中 62% 高、按钮占底部 42+32vp → **不会重叠**，不存在"按钮可见但点不到"的模式

#### Ruling 32：批 6（并入在途的防抖修复）

reviewer 的 Minor 中两条要修，**与在途的防抖修复同文件、正好一并做**：

1. **Minor C（潜在数据丢失）**：`decisionStore.ets:51` 丢弃了 `readSync` 的返回值。
   若文件在 `statSync` 与 `readSync` 之间**变小**，尾部会被 NUL 填充 → `JSON.parse` 抛错 → catch 退化为**空 Map**
   → **所有照片回到队列**（正是验收标准 5 要防的症状）。
   `claimStore.ets:26-36` 有**同一模式**（Task 6 遗留）。→ **两个文件一起修**：用 `readSync` 的实际读取字节数，
   或读取后按返回值截断；并让"截断/短读"走 warn 而非静默空 Map。
2. **Minor E（未来调用点的静默归档）**：`SwipePage.ets:125` 的 `action === 'fav' ? 'fav' : 'archive'` 现在喂给**持久化状态**；
   未来某个调用点传未知 action + `rolledBack=false` 会被**静默归档写盘**。→ 加守卫：非 `fav`/`archive` 直接 `return`。
- 不修（记录）：Minor A（timer 回调未复位 `-1`，今日无害）、Minor B（写失败留下 `.tmp`，下次 saveAll 会 TRUNC 自愈）、
  Minor D（报告行号引用陈旧，但编译日志锚点与提交一致 → 构建证据可信）。
- **Ruling 32 附带约束**：在途修复后 `DecisionStore.set()` 将无调用者。
  **不要删它** —— 它是"读-改-写完整 Map"的路径；防抖修复直接把内存 Map 写盘，
  保留 `set()` 不影响正确性，删除则减少一条已知安全的写入路径。若 implementer 已删，要求恢复。

#### fix 批 5 结果（`446196a`）—— 两处主动偏离均优于控制器的方案

- throttle 实现正确（`saveTimer === -1` 才开表）、`onPageHide` flush 已加、`set()` 已删并留说明注释
- 单测 48/48、`BUILD SUCCESSFUL` 0 ERROR、六个守卫产物齐全
- **偏离 A（控制器设计缺陷，implementer 推翻正确）**：控制器要求"每次 `clearTimeout` + `setTimeout`"的**纯尾部防抖**。
  implementer 指出：连滑间隔 <1s 时会把落盘**无限推迟**（连滑 30 张期间零写盘），
  被杀丢的不是"1 秒内的决策"而是**整段连滑** —— 直接违背任务自己写的前提。
  → 改为 **1 秒合并窗口（throttle）**：只在 `saveTimer === -1` 时开表，同时给出"每秒至多 1 次 + 至多滞后 1 秒"两个上界。
  **Ruling 33：采纳。** 控制器的方案在"持续操作"场景下失效，implementer 的方案严格更优。
- **偏离 B（控制器漏掉的真实回归）**：控制器只要求 `aboutToDisappear` flush。
  implementer 指出 `SwipePage.ets:106` 的「收藏」按钮走 `router.pushUrl`，
  旧页面只是被**盖住不销毁**（`aboutToDisappear` **不触发**），而 `FavPage.aboutToAppear` 从**盘上**读
  → **右滑收藏后 1 秒内点「收藏」，收藏页看不到这张**（真实可见回归）。
  → 额外加 `onPageHide()` flush（`aboutToDisappear` 原样保留、只追加）。
  **Ruling 34：采纳。** 这是用户能看见的 bug，控制器的设计有盲区。
- **Ruling 35：批准删除 `set()`（撤回 Ruling 32 的保留要求）**。
  implementer 的 grep 证据：改造后零调用者；`data/*.ets` import `@kit.*`，Node 测试无法加载，无测试引用。
  其理由**强于控制器的保留理由**：「`set()` 的方法体就是这个性能 bug 本身，
  留着它会让下一个人用『看起来无害的单条写 API』把问题原样复发在别的页面」。
  → **控制器接受删除**（并原地留 4 行注释说明为何刻意没有单条写入口）。
- **Ruling 36（修正后仍待做）**：评审的 Minor C（短读退化为空 Map，**两个存储层都有**）与 Minor E（未知 action 静默归档）
  → 批 6 已派发（agent 5a753d25-ec1a-47a2-9688-2a907abaac71）
- 遗留：防抖时序无自动化测试覆盖（`SwipePage` 是 ArkUI 组件 + `setTimeout`，Node 进不去）；
  掉帧本身仍无真机帧时间数据（结构性 I/O 问题已消除）

#### fix 批 6 结果（`5201332`）

- 两处存储层（`decisionStore.ets` / `claimStore.ets`）改用 `readSync` 实际字节数解码；
  `SwipePage` 加 action 守卫。三文件 +20/−4，48/48 pass，`BUILD SUCCESSFUL` 0 ERROR
- **implementer 在 Node 里忠实复现了那个读侧竞态**（stat 旧 size=126 / n=65）：
  旧写法 `buffer.from(buf)` **THROW SyntaxError → 静默空 Map**；新写法 OK 且解出内容 == 磁盘最新完整内容
  → **这是"缺陷真实存在"的直接证据，而非只靠推理**
- 它选的写法有额外优点（控制器未要求）：`buffer.from(Uint8Array)` 把"只取前 n 字节"**具名化**，
  后续改动无法悄悄扩大解码范围；且候选重载唯一（`(buf,0,n)` 会与 `from(object, offsetOrEncoding, length)` 竞争）
- **Ruling 37：采纳疑虑 3 并升级** —— 守卫原在指标记录**之后**，未知 action 会先进 `metrics.events`
  → 污染 `medianDecisionMs` 样本与 `rollbackRate` 分母 → **指标自证清白式失真**（本项目第二次遇到同类：
  第一次是 `SPRING_BACK_MS < flyTimer` 那条跨常量不等式）
  → 批 7：守卫上移到 `recordSwipe` 之前，用 `!rolledBack && action !== 'fav' && action !== 'archive'`
  一次表达"回弹放行、其余拦下"

#### fix 批 7 结果（`e717eb3`）

- `SwipePage.ets:152` 守卫上移到位；旧守卫与注释已删（`action !== 'fav'` 全文仅 1 处匹配，旧注释标记 0 处 → 非两个守卫）
- **implementer 在两个调用点做了独立真值表推导**，其中一条是**控制器未曾点明的关键**：
  > `springBack` 的 `'none' + rolledBack=true` 必须放行 —— 它是「回弹率 <3%」的**唯一数据源**
  >（`CardStack.ets:126-130` 显示 springBack 每个回弹窗口只上报一次，Ruling 29）。
  > **若守卫漏了 `!rolledBack`，回弹率的分母会归零、指标读成 "0%"** —— 正好造出本批要修的那种"看起来总是达标"的失真。
  → **它在核验控制器的修法时，验证的是"这个修法会不会制造同类问题"**，比"照做"高一层
- **Ruling 38：采纳其疑虑 1，批 8 做类型收紧**
  `onDecide`/`handle` 的 `action` 是 `string`，编译器帮不上忙；未来第三个手势出口传未知 action 会
  **静默丢决策**（卡片飞走、用户看到"滑了但没反应"）。
  → 批 8：定义 `export type SwipeAction = 'fav' | 'archive' | 'none'` 并收紧两处签名，
  使未知动作**编译期报错**；批 7 的运行期守卫**保留**（作 `as` 断言绕过的防御）并加注释说明
- 遗留（记录）：守卫的运行期分支无自动化测试覆盖；六个 `core/*.protoBin` 是增量产物（时间戳早于本次编译）
  → 控制器将在批 8 后安排**一次全量重建**核验其新鲜度

#### 批 5/6 再审查结果（agent be7d54ec-caa8-4f14-9fe3-3edc00989f63）

- **9/9 ADDRESSED，无 Critical/Important**
- 关键项 4（`this.decisions` 完整性）：**ADDRESSED，无 Critical**。reviewer 独立核实 `loadAll` 对每条合法记录都 `set`、
  四态无过滤；队列过滤对 `existing` **只读**；`this.decisions = existing` 整表赋值；全仓唯一写者是 `flushSave→saveAll`，
  `FavPage` 纯读 → 无第二写者 lost update。唯一被丢的是 `loadAll` 跳过的**非法行**，
  而旧 `set()` 本身也是 loadAll+saveAll（每次写盘同样清洗）→ **语义等价、非新丢失面**
- 关键项 3（`onPageHide` 语义）：**⚠️ 无法从 diff 判定，需真机** —— 且 reviewer **纠正了控制器的判断**：
  > **编译通过不构成存在性证据**：struct 上未识别的生命周期方法名会当普通成员**编译通过、永不回调**。

  → 若 `onPageHide` 不触发，**偏离 B 失效**，`FavPage` 从盘读会漏掉 1 秒内刚收藏的那张。
  **Ruling 39**：这是可精确检验的 → **写入真机验收清单**（见 Task 8 验收第 6 条）。
- 附注（reviewer）：`claimStore` 与 `decisionStore` 的 I/O 全在 UI 线程，进程内无可交错写者
  → 短读修复属**防御性正确性而非活 bug**（成本为零，仍值得）
- 新发现 Minor（理论性、低置信）：`aboutToDisappear` 只清当时那个 timer；若销毁后仍有迟到 `onDecide`
  → `scheduleSave` 会在已销毁 struct 上再排 1s timer；快照式全量写意味着该窗口内若另一实例写过盘，
  迟到 flush 理论上会覆盖其 1s 内的决策（**旧 `set()` 因先 `loadAll` 合并反而不会**）。
  需「销毁后回调 + 页面重建 + 1s 内新决策」三重条件；已知两调用点在存活期内产生不了。
  **Ruling 40：记录不修**（三重条件、当前不可达）。但它是**快照式写入相对 `set()` 的真实权衡**，交最终整分支审查三方裁决。

#### 批 7 再审查结果（agent 95033935-f621-4580-8bf4-27b5092eaeef）

- **All findings addressed，无新 Critical/Important**（仅 1 条 Minor 注释瑕疵）
- 五项逐条 ADDRESSED，其中第 4 项（`!rolledBack` 是否必要）有**完整的反事实验证**：
  > 若守卫写成 `if (action !== 'fav' && action !== 'archive')`（不带 `!rolledBack`）：
  > `springBack` 传 `'none'` → 两比较均 true → 在 `recordSwipe` **之前** return；
  > 而 `recordSwipe` 在本文件**只有这一处**，`rolledBack=true` **只由 `springBack` 发出**
  > → metrics 里**永不出现回弹事件** → `rollbackRate` 分子**结构性恒 0**
  > → 「回弹率 <3%」**恒为达标，即使手感极差** —— 正是"指标偏好看最难发现"的那一类。
  > **且 48 个 core 用例直接调 `recordSwipe`、绕过了 `handle`，照样全绿、测不出。**

  → 即：reviewer 在验证控制器修法时，**把"若不这么写就会制造同类失真"也一并证了**
- 它同时确认：被拦的唯一组合是 `rolledBack=false ∧ action ∉ {fav,archive}`，当前无此调用点

#### Ruling 41：新注释会误导后人重犯同一个 bug（批 8 一并修）

批 7 新增的注释（`SwipePage.ets` 约 :151）写「位置必须在 `rolledBack` 早返回之后」，
但那道 `if (rolledBack) { return; }` 实际在 `:162` —— **守卫其实在它之前**（正确位置）。
**按注释字面执行会把守卫挪到 `recordSwipe` 之后，正是本次要修的缺陷。**

→ **裁决：改为准确表述**（"必须在 `recordSwipe` 之前，并用 `!rolledBack` 放行回弹路径"），批 8 一并处理。
代价（若判断有误）：一行注释文案。

- 附注（reviewer 观察，非 finding）：读取期间看到批 8 的 implementer 在做**变异实验**
  （`CardStack.ets:129` 的 action 临时改成 `'nope_probe'` 字面量）
  → 目的是验证 `SwipeAction` 联合类型能否**真的在编译期**拦下拼错的 action。
  **控制器认可该实验设计**：若编译能过 → 类型收紧无效；若编译失败 → 保证为真。

- **控制器操作记录（避免并发冲突）**：批 8 进行期间，控制器试图直接修 Ruling 41 的注释，
  但**文件正被 implementer 改写**（读到的是中间态）→ 编辑被拒。
  **控制器正确处置：放弃抢改，改为批 8 之后的补充修复**（不在 implementer 工作期间并发写同一文件）。
  核实结果：`SwipePage.ets:148` 的 `SwipeAction` 签名已落地，**误导性注释仍在 :151**。

#### 批 7/8 合并再审查结果（agent 4aa0f571-36fd-4fb3-974b-1bf4ff6e8822）

- **All findings addressed，无新 Critical/Important**（唯一未落实项是 Ruling 41 的注释改文，属 Minor）
- 六项逐条核验，其中第 4 项（批 8 是否改变运行时行为）给出**可闭合的逐行归因**：
  > 批 7（+5/−3，仅 SwipePage）+ 批 8（+17/−4，2 文件）= package stat 的 +22/−7，
  > **两者无缝划分本区间、无未归因行**。扣除后只剩 import 说明符、3 处类型注解、1 个 `export type`、11 行注释、1 空行
  > → **零可执行语句、零分支、零实参变化**；`recordSwipe` 的入参、`rolledBack` 早返回、`nextAction`、落盘、上墙块全为 context 行
- 第 3 项（`SwipeAction` 是否恰好等于旧值域）也给双向核验：三成员都有真实出处、无幻影成员、无排除旧可达值
  → **收紧为真，非假收紧**

#### Ruling 43：控制器高估了字节码等价性证据的价值（reviewer 去魅，采纳）

控制器此前称 `ark_disasm` 比对"把'我觉得没变'升级成'编译产物证明没变'"。reviewer 纠正：

> (i) 应作**顺带旁证**而非行为等价证明 —— 承重的是源码 diff；
> **类型/注释在 ArkTS 下被擦除，故"opcode 直方图零差异"是预期结果、新增独立信息量很小**；
> (ii) 其适用范围**只有批 8 自身**，**不覆盖**批 7 的刻意运行时变更；
> (iii) 三个方法的归一化比对用实施者**自写**的归一化，最可能掩盖真实操作数差异 → 权重最低；
> "opcode 直方图 + literal 多重集"（不依赖该归一化）权重最高；
> (iv) 构建脚印真实（`.abc` 大小/哈希/时间戳与日志相符）。

**采纳。** 该证据**证明的是一个已知为真的命题**（擦除类型后产物相同），不应作为行为等价的主要依据。

#### Ruling 44：批 8 注释里第二处不实表述（批 9 一并修）

`SwipePage.ets:152-154` 写着「`'none'` 必带 `rolledBack=true`」由**类型层面保证** —— **这不是类型提供的保证**：
`SwipeAction` 与 `boolean` 相互独立，`onDecide(id, 'none', false)` **无需任何 `as` 断言即可编译**，
唯一防线是 `:155` 的运行期守卫。

**危害比位置错误更隐蔽**：它让读者**低估守卫的作用**（"类型都保证了，守卫大概冗余"）→ 然后有人删掉它。
→ 批 9 改为「配对由当前两个出口维持，**非类型所保证**」。

#### 批 9 结果（`1ea3793`）—— implementer 推翻控制器给定的类型写法（编译器硬拒）

- 控制器指定的**内联对象联合**在 ArkTS 下**编译硬拒**：
  `arkts-no-obj-literals-as-types`（内联对象字面量不能作为类型声明）+ `arkts-no-untyped-obj-literals`
  → `COMPILE RESULT:FAIL {ERROR:5 WARN:13}`
- **Ruling 45：追认偏离**。implementer 改用具名 interface + 联合：
  `SwipeDecision { kind:'decision'; action:'fav'|'archive' }` / `SwipeRollback { kind:'rollback' }` /
  `SwipeOutcome = SwipeDecision | SwipeRollback`（`CardStack.ets:31-33`）
- **负向探针 4/4 全拒**，其中 **P3 正是批 8 残余漏洞的原文形态** `('none', false)` → `Expected 2 arguments, but got 3` ⭐
  探针前后 diff SHA256 相同 → 还原干净
- 控制器核实：**`SwipeAction` 已完全移除**（无竞争契约）；两处注释均已改准；复跑 48/48；
  **全量重建后六个守卫产物均为 4 秒前重新生成**（产物新鲜度疑虑关闭）

#### 批 9 再审查结果（agent 6c83e2c2-7d63-430a-8565-061777958ee8）

- **All findings addressed，无新 Critical/Important**（3 条 Minor，均非行为缺陷）
- **reviewer 用 SDK 自带 tsc（与产出 10505001 同源）独立复现探针**：逐字复制类型跑 fresh-literal、`action:string`、
  `kind:'none'`、3 参形态 → **4/4 被拒**（不采信 implementer 日志）
- 口径澄清：探针日志 `{ERROR:6}` 而正文列 5 条，是**计数把 header 算进去的系统性差 1**，非隐藏错误

#### Ruling 46：判别联合的绕过路径 —— 存在但当前无害；**且控制器给的形态同样有洞**

reviewer 找到一条真实存在的绕过路径，并用**对照实验**证明它与形态选择无关：

> **绕过路径**：把带多余 `action` 字段的**变量**传给 `SwipeRollback` → **编译通过**。
> implementer 的 P4 **未覆盖该路径**（P4 的变量初始化式是**新鲜字面量**，被拒的是初始化式的多余属性检查 TS2322）。
> **对照实验**：把**控制器的内联字面量形态**喂给同一 tsc，`interface SneakyRollback { kind:'rollback'; action:'none' }`
> 变量传入**同样被接受** → **"内联精确 / 具名开放"的差异对这条例外路径不存在。**

**即：控制器要求的写法在这条路径上一样有洞** —— 这是 TypeScript 结构化类型的固有行为
（多余属性检查只作用于**新鲜**字面量），不是 implementer 偏离造成的。

**当前无害，且防护来源不是类型而是解码方式**：
- 可达性 = 0（全仓 `onDecide(` 仅两处，均不带多余字段）
- 后果 = 无：`SwipePage` 只按 `kind` 解码（单向），`outcome.action` 仅在 decision 分支被读；
  **回弹分支的 action 恒为常量 `'none'`，杂散字段不可能回流**
- `(fav,true)` / `(archive,true)` / `(none,false)` 三种非法配对**仍不可表达** ✓（本批目标达成）

**Ruling 46（修措辞）**：`CardStack.ets:29/:40` 与报告把"**新鲜字面量**不可表达"说成"不可表达"，
属**过度概括**。→ 限定为"字面量/直赋形态不可表达，变量形态可绕过但被 `kind` 解码消解"。
理由：后续任务（Task 8 的删除手势）会扩展这个联合，**必须知道真实边界在哪**，否则会以为类型已封死一切。

#### Ruling 47：`SwipePage.ets:164` 守卫已是"类型契约意义上的死代码"—— 保留

reviewer：该守卫对任何 `SwipeOutcome` 取值不可达，**但非"可证不可达"**
（`{kind:'none'} as Object as SwipeOutcome` 其探针编译通过）→ 按注释保留作 `as` 防御**正当**。
**裁决：保留**，与批 8/Ruling 38 的处置一致。

#### Ruling 48：失败证据被覆盖（流程教训，非缺陷）

`fix-batch-9-report.md` 自称构建 A 日志为 `fix-batch-9-build-A.log`，但**该文件已被 A2 覆盖为成功日志**
→ **内联形态编译失败的磁盘证据已丢失**（只剩正文引文 + 探针日志中存活的错误码）。结论不受影响。
→ **流程约束**：后续批次**不得复用日志名覆盖失败证据**；失败日志须以独立名（如 `-FAILED.log`）留存。

#### 批 10 结果（`d7d2d20`）—— 纯注释订正

- `CardStack.ets`：主声明限定为「**字面量/直赋值形态**的非法配对在编译期报错」+ 新增「边界」段（三件事齐备：
  ① 多余属性检查只作用于新鲜字面量 → 变量形态可绕过，属结构化类型固有行为、与联合形态无关
  ② 真正防线是消费侧按 `kind` 单向解码 ③ 只编码 action↔rolledBack，**不编码「出口↔kind」对应**）
- `SwipePage.ets`：守卫旁补"挡的是经 `as` 断言洗过的值、不是正常路径、**不要因为「类型已保证」就删掉它**"
- **零可执行变更的三重证明**（最有说服力的一重）：
  > 剥离块注释与行尾 `//` 后逐行比对 `d7d2d20^` vs `d7d2d20`：
  > **CardStack `code_lines 107→107, diff_entries=0`；SwipePage `139→139, diff_entries=0`**

  → **剥掉注释后代码逐行相同**，强于"我读过、都是注释"
- 单测 48/48；`BUILD SUCCESSFUL` 0 ERROR
- **Ruling 49：批准保留 ArkTS 硬约束段**（implementer 疑虑 ①）。控制器给定的示例文案里没有该段，
  但 `arkts-no-obj-literals-as-types` 是本工程踩过的**真实约束**，保留它是有价值的资产，删除才是损失。
- **Ruling 50：控制器做了最终全量重建**，六个守卫产物**全部 4 秒前新鲜生成**（批 10 的 mtime 疑虑 ③ 由此关闭）；
  HAP 294.8 KB（18:08:40）；复跑 48/48 ✓

- **Task 8: complete (commits 3fea687..d7d2d20, review clean)** —— 6 个 fix 轮，0 条 parked
  - **待真机验收**（6 条，含 `onPageHide` 语义判定）

### Task 8 首轮真机反馈（用户实测）—— 3 条交互/视觉缺陷

**控制器直接读设备文件取证**（`hdc` 可用）：

```
faved: 2    walled: 2    archived: 21     ← 25 条决策真实落盘
```

→ **验收标准 2/3/4/5 实际通过**（上墙、归档、收藏都落了盘）。三条反馈全是**交互与视觉**问题。

| # | 用户原话 | 根因（控制器读码确认） |
|---|---|---|
| 1 | 看收藏 照片展示都是一个长竖条 | `FavPage` 的 `Grid` **只定义列、没有行高** → `Image.height('100%')` 撑满整屏高 |
| 2 | 右滑一下 照片没消失 | `CardStack` timer 回调**先归位再换卡** → 换卡前有一帧"旧卡弹回中央"；**用户相册全是连拍**（数据里大量相隔 1–3 秒的 IMG），新旧卡视觉几乎一样 → 感知为"没消失" |
| 3 | 然后弹出来 挂上墙 交互有点奇怪 | 4 秒窗口期按钮用 `.align(Alignment.Bottom)` 叠在 `Stack` 上 → **等价于覆盖 alignContent，落在照片正中**（截图为证） |

- **Ruling 51（用户裁决）**：上墙入口改为「**不打断：常驻小按钮、不过期**」（A 方案，控制器推荐项）
- `fix f5ff02c`：
  1. `FavPage.ets:47` `.aspectRatio(1)` —— **implementer 拒绝了控制器示例中"去掉 Stack"的写法**，
     因为那会**弄丢「墙上」角标**（`GridItem.alignContent` 是"格内对齐"不是"叠加"）。
     **控制器示例只盯着"长竖条"一个症状、没兼顾角标，implementer 按任务整体意图执行，正确。**
  2. `CardStack.ets:153-158` **先 `onDecide` 再在 `finally` 里归位** + 飞出距离改 `1.4 × 卡宽`（原硬编码 600）
  3. `SwipePage.ets` 删 `WALL_PROMPT_MS`/`wallTimer`/浮出按钮，改 `@State lastFaved` + 顶部常驻小按钮
- 控制器核实：旧三个符号**彻底删除**（`SwipePage.protoBin` 里 `wallPromptFor`/`WALL_PROMPT_MS` 命中 **0**，
  `lastFaved` 命中 **25**）；三处 `flushSave()` 都在；全量重建 + 48/48 + 九个产物 6 秒前新鲜生成

### Ruling 52：用户推翻"先收藏才能上墙"这个设计前提（产品结构变更）

**用户原话**：「照片出现的时候 就应该有挂上墙的选择 不是说必须先收藏才能上墙」

控制器自陈设计错误：
> 早先定"收藏 → 再上墙"，理由是"滑动是本能判断、上墙是再决定一次是否陈列，**认知层级不同**"。
> **"层级不同"是对的，但"必须分两步"是错的** —— 层级不同说明**该给不同的入口**，
> 不说明**该串行**。我把前者推成了后者，结果强迫用户把一个已经做出的决定拆成两步，
> 中间还夹着"记得回来点"这个负担。

- **Ruling 52（用户裁决）**：入口形态 = 「**卡片上放一个「上墙」按钮**」
- 派发：`CardStack` 新增 `SwipeWall { kind: 'wall' }` 分支 + 卡片底部半透明「上墙」按钮；
  `SwipePage.handle()` 四态解码（`fav`/`archive`/`wall`/`rollback`）、守卫放行 `'wall'`、
  `nextAction` 映射不能把 `wall` 误当归档
- **语义决定（不改）**：`favedIds()` 返回 `faved || walled` → **直接上墙的照片也出现在收藏页**（带「墙上」角标）。
  一致且合理：上墙是从收藏里精选，墙上的东西本就该在收藏池里可见。

#### fix `c7823eb`：卡片「上墙」按钮

- `CardStack.ets:46` 新增 `SwipeWall { kind: 'wall' }`、`:48` 联合三支、`:90-110` 卡片内底部半透明按钮
- `SwipePage.ets:142-144` 四态解码、`:161` 守卫放行 `'wall'`、`:181-183` 映射不落 archive、`:191` 仅 `fav` 设 `lastFaved`
- **implementer 挡下控制器两处错误**：
  1. 控制器给的 `Stack(...).justifyContent(...)` —— **本 SDK 的 `StackAttribute` 只有 `alignContent`**，
     实测 `Property 'justifyContent' does not exist on type 'StackAttribute'`；且去掉后按钮离卡片空出约 87vp、
     卡片被压到页底（**正是之前踩过的坑**）。→ 改为放在**卡片内底部**
  2. 控制器给的 `let nextAction: string = 'archive'` —— **编译不过**
     （`Argument of type 'string' is not assignable to parameter of type 'Action'`）。
     **这是控制器画蛇添足**：原代码 `const nextAction = action === 'fav' ? 'fav' : 'archive'` 无标注、
     TS 推断字面量联合所以能过；加 `: string` **反而把类型放宽**了。
     → 收窄为 `'fav' | 'archive' | 'wall'`（与批 8 的 `SwipeAction` 同类教训：**显式标注可能更弱**）
- 负向探针：`Type '{ kind: "wall"; action: string; }' is not assignable to type 'SwipeWall'` ✓ 判别力仍真

#### fix `5c24f16` + `8f1332a`（批 12）—— 两条控制器判为**必修**的缺陷

- **必修正 ①：按钮可致静默跳过照片**。按钮 `onClick` 无 `animating` 守卫；
  右滑提交后卡片视觉已飞走、但 `animating` 仍真 → 此时再点 → **同一张上报两次 → `idx` 进两格 → 跳过一张**。
  修法：按钮加与手势同口径的闸门 + `handle()` 同 photoId 去重（第二道防线）。
  implementer 独立核实去重**不误伤 defer**（`'skip'`/`'unfav'` 在 production 无调用点，
  `!== 'unseen'` 恰好为将来 defer 的有意重决策放行）
- **必修正 ②：`rollbackRate` 分母必须排除 `wall` 事件**（第三次"自证清白型失真"）。
  点按钮**不是滑动尝试**，不该进分母。控制器算过偏差：设 s 次滑动、r 次回弹、w 次上墙点击：

  | w | 指标读数 | 真实值 | 偏差 |
  |---|---|---|---|
  | 0 | r/s | r/s | 0 |
  | s | r/2s | r/s | **偏低 50%** |
  | 3s | r/4s | r/s | **偏低 75%** |

  → **越常上墙，指标越好看**；而"上墙"正是本产品核心动作。
  修法：`rollbackRate` 与 `medianDecisionMs` 均跳过 `action === 'wall'`（中位数同理：点按钮的"决策耗时"与滑动不同质）
- **新增 4 个 metrics 用例**（48 → **52 全 pass**），现有 9 个期望值**零调整**
  （仅把用例名 `回弹数 / 总数` 改为 `回弹数 / 滑动尝试数` —— 旧名里的"总数"正是本批修正的错口径）
- **implementer 的诚实披露**：4 个新用例中「全 wall → 0」在修复前**即为绿**（它守的是新的 `n===0` 分支），
  红→绿证据来自另外 3 个。**控制器认可这种披露**：说清哪些证据是真红绿、哪些只是护栏，比笼统说"4 个新用例"可信。

#### fix 批 13（`da9788ef`）—— 第四次"指标偏好看"失真

implementer 疑虑 1（控制器采纳）：**「上墙」是唯一不走 `flyOut()` 的决策出口，因此不清 `springTimer`**：

> A 回弹（t=0，开了 150ms 窗口）→ t=50 点上墙（不清 timer）→ **B 在剩余窗口内回弹会被判"已上报"而静默丢弃**
> → `rollbackRate` 偏低

**控制器注（系统性风险）**：这是本项目**第四次**遇到"指标向好看方向偏"的缺陷，
且它是在第三次（守卫位置）刚修完后立刻浮现的 → **该失败模式在此代码库是系统性的，不是偶发**。
修法：把"结束回弹窗口"提为 `endSpringWindow()`，**所有"这张卡已定案"的出口都必须调用**
（现有：`flyOut()`、上墙按钮），并要求用 grep 证明 `clearTimeout(this.springTimer)` 全文只剩一处。

- **implementer 又纠正控制器一处假设**：控制器裁决里括号写「新卡的 `dx` 本来就会是 0（`@Prop item` 变了）」
  —— **不成立**：`@State` 不随 `@Prop` 重置、`CardStack` 实例跨照片复用（证据 `CardStack.ets:181`/`:198`），
  **显式归零是必需的**。控制器写裁决时顺手做的推测被代码证伪。

#### fix 批 13 结果（`1c55ee2`）

- `endSpringWindow()` 落地：**`clearTimeout(this.springTimer)` 全文仅 1 处**（`:93`，方法体内）
- 四个出口全覆盖：上墙按钮（`:126`）、`flyOut`（`:197`）、`springBack`（`:234`）、卸载（`:82`）
- 控制器核实：结构、编译、**52/52 pass**、六守卫产物齐全
- **implementer 又指出控制器一处事实错误**：控制器任务里写「全文件只剩一处」，
  但**起始状态本来有 3 处**（`aboutToDisappear` / `flyOut` / `springBack`），
  控制器**写这句时没有核实起点**。implementer 按**指令的意图**（收口到单一出口）执行，
  把另外两处也收编并逐条说明等价性 —— **正确处置**（停在"任务只让我改 flyOut"上反而会留下不一致）
- **Ruling 53**：批 13 造成 `CardStack.ets:129` 一处**悬空交叉引用**（控制器给的替换文本删掉了
  `flyOut` 里含「实例复用」字样的注释）→ 批 14 修（纯注释）

#### 全分支审查（区间 `f5ff02c..1c55ee2`）

- 控制器派发（agent 4d36252c-646f-4335-86a8-f80f14a6407f），包 509 行 / 27.4 KB
- 要求独立验证五组重点：① 按钮三条并发/时序风险是否真堵住（含去重是否误伤 defer）
  ② 指标口径修改是否真正确、**有没有别的指标也吃了 wall 事件**、4 个新测试是否真能捕获回归
  ③ `endSpringWindow` 收口是否完整且语义未变 ④ 「先换卡再归位」是否真消除了那一帧
  ⑤ 「上墙」路径端到端一致性（有没有哪环把上墙误当归档或反之）

### 观察：本项目已**四次**遇到"指标偏好看"的失真（系统性风险）

| # | 位置 | 失真方向 |
|---|---|---|
| 1 | `SPRING_BACK_MS(150) < flyTimer(230)` 跨常量不等式 | 回弹率偏低 |
| 2 | action 守卫放在指标记录**之后** | 中位数 + 回弹率被污染 |
| 3 | `rollbackRate` 分母含 `wall` 事件 | 越常上墙偏低越多 |
| 4 | 「上墙」出口不清 `springTimer` | 下一张的首个回弹被吞掉 |

**第 4 条是在第 3 条刚修完后立刻浮现的** → 该失败模式在此代码库**是系统性的，不是偶发**。
根源：这三个指标**同时是"给用户看的状态"与"验收的裁判"**，任何让它们偏离真实的东西都表现为"看起来达标"，
而"看起来达标"不触发任何报警。

**做法调整（Ruling 54）**：此后每次动到 `handle()` 或任何计时器，控制器**必须专门问一句
「这会不会让某个指标偏好看？」**，而不是等它在下一轮冒出来。

### 交互迭代全区间审查结果（agent 4d36252c，区间 `f5ff02c..1c55ee2`）

- **Approved**（无 Critical，1 个 Important + 5 个 Minor）
- **范围更正（控制器核实：审查正确）**：控制器派发时把区间写成 `f5ff02c..1c55ee2`，
  但 **`f5ff02c` 自己就是那三条反馈的修复**（git 不含端点）→ 反馈 1 的四条修法**落在区间之外**。
  **代码没问题，是控制器的区间标注与 commit 计数（写 5、实际 4）错了。**
- 独立验证结论：
  - ① 闸门与去重**真的堵住**：右滑后 230ms 内点击在 onClick 首行返回；
    同帧双击由 `handle()` 去重兜住；**判据 `state !== 'unseen'` 恰好正确**
    （`core/queue.ts:27-43` 只有 `skip`/`unfav` 回到 unseen，而 SwipePage 入队过滤用同一判据 → 两处语义对齐）
  - ② **`core/metrics.ts` 没有别的指标吃 `wall`**（该文件整个都在 diff 里可见；`events` 消费者只有
    `medianDecisionMs`/`rollbackRate`，`wallConversion` 只吃标量）—— **控制器最不确定的一条，清白**
  - ② 4 个新测试按**旧实现逐个重算**：`:74`(0.5 vs 旧 0.25)、`:91`(1500 vs 旧 2000)、`:100`(0 vs 旧 1000)
    三个**真红→绿**；`:84` 全 wall→0 **修复前即绿** → **implementer 的自陈披露准确**
  - ③ `endSpringWindow` 收口完备，`clearTimeout` 全文仅 1 处；`springBack` 防抖语义 0 改动
    （`alreadyReported` 仍在结束窗口前读取）；**无第五出口**（全仓 `idx` 只有一处递增）
  - ⑤ 上墙端到端**十环逐一核对，无一处误判为归档**
- **Ruling 55：审查给出一条比控制器更本质的解释**
  > ④「先换卡再归位」能消除那一帧，**承重的是"平赋值归位"这一点，而不是上报顺序**。
  > 若归位写成 `animateTo`，被复用的节点会在**照片已换新之后**继续渲染 150ms 插值位姿
  > —— 那正是产品看到的"照片弹回中央"。
  > **而新加的上墙路径用的恰恰是 `animateTo` 归位** → 同一 bug 形态在新代码里复现。

  → 控制器要求所有归位一律用平赋值（Ruling 56），并据此审查新重构。

- **Important（审查发现，控制器核实为真，批 15 修）**：上墙路径刻意不置 `animating`，而手势侧只由它把关
  → **双指场景**（一指拖卡、一指点上墙）下，`idx++` 后另一指继续写 `dx`，
  抬手 `settle()` 会以**新 photoId** 上报 → **用户没打算决定的那张被静默消耗**；
  同 photoId 去重**无效**（id 已变）。修法：`decidedId` + 手势入口比对（`@Prop` 换卡自动解除）
- Minor 中控制器采纳两条：**上墙归位改平赋值**（与 `flyOut` 对齐）、
  **去重提到 `recordSwipe` 之前**（今天是潜伏项：被挡的重复事件仍进 metrics）

### 交互模型重构（用户第三次真机反馈，`Ruling 57`）
**用户原话**：
> 上滑是跳到下一张  下滑需要能返回上一张刷过的  跟抖音一样  能上滑继续看刚看过的  
> 避免刚划走的还想再看一下是否要上墙或者收藏或者删除  
> 卡片上面的挂上墙不要了  只保留上墙就好

**用户两次裁决**：① **动作全变按钮，上下滑只管翻页** ② **去掉顶部 chip**

**新模型**：
| 手势/入口 | 含义 |
|---|---|
| 卡片上滑 | 下一张（内容上翻，新卡从下方进） |
| 卡片下滑 | 上一张（**可重新决策**） |
| 卡片上【← 返回】/【归档】/【上墙】/【收藏】 | 四个动作按钮 |
| 顶部 chip | **删除**（`lastFaved` 与 `promoteToWall()` 一并移除） |

- **控制器识别并说明的手势冲突**：垂直手势与"左滑归档/右滑收藏"共用同一 `PanGesture` 会打架
  （斜着滑到底算哪边无法判定）→ 这是"动作全变按钮"这个裁决的**技术原因**
- **控制器主动指出的三个未定细节**：
  1. 上滑 = 下一张（按抖音，内容上翻）
  2. **「返回」必须撤销那张的决策**：光减 `idx` 不够，那张在盘上已是"已决策"、回去也改不了
     → 需 `DecisionStore.remove()`
  3. **语义风险（已向用户说明）**：已上墙的照片返回后改用【归档】，**它会从上墙列表消失**
     （控制器判断这是"用户明确改主意"的正确结果）
- **控制器同时确认**：【删除】尚未实现（spec 里在长按菜单，属后续任务），本轮做四个
- **硬要求**：`SwipeRollback` 分支在此次重设计中被移除，但 **`rolledBack` 是回弹率指标的唯一数据源，
  不能丢** —— 必须明确保住（另设分支或在 SwipePage 保留处理）

## 并发事故：控制器过早派发重构（Ruling 58）

控制器在**批 15 尚未提交**时就派发了垂直导航重构，虽在指令里写了"工作树不干净就停下回报"，
但**没预见到"另一个 agent 正在写同一文件、必然出现脏树"这个中间状态**。

重构 agent（agent b3231b77）**正确处置**：HEAD = `0522782`（不含批 15）、工作树脏（`CardStack.ets` +48）
→ 停下回报 NEEDS_CONTEXT，并列出三个具体危害，其中第 1 条最实际：

> 第 7 步是 `git add -A` → 会把批 15 的 +48 行**以我的提交信息落库**，归因错误，
> 且把**未审查、可能未通过编译**的修复当成已验证成果提交。

它还给了可核实的事实：`git stash list` 空、无未跟踪文件、`0522782` 后无新提交；
并以 12 秒静置窗口复检 SHA256/mtime 一致 → 写入者已停手但未提交。
**全程只读（未 add/commit/stash/checkout，未编辑任何源码）** —— 处置完全正确。

**Ruling 58（流程约束）**：**涉及同一文件的修复必须串行** —— 等前一个 agent 提交后再派下一个。
控制器的"并发保护"提示只能防"不知道有并发"，**不能防"知道有并发但仍然过早派发"**。

### 批 15 的改动质量（控制器读码核实，等待其提交）

批 15（agent a26632a7，仍在跑）的实现**优于控制器给的方案**，两处超出要求：

1. **用 `gestureId`（手势起始那张）判定作废，而不是 `item.photoId`**。
   控制器的方案是 `if (this.item.photoId === this.decidedId) return;` —— 它会**漏掉要防的那个手势本身**：
   > 定案后父组件重渲染会在约一帧内把 `@Prop item` 换成下一张，此后 `item.photoId` 已经不是那张卡了，
   > 而**在途手势仍属于它**：拿 `item` 去比会漏掉这个手势，**那正是本缺陷的形态**。

   → 记"本次手势在哪张卡上开始"（`gestureId`）才是正确判据；`isGestureVoided()` 用两条互补判据：
   ① 手势起点卡 = 刚定案的那张（覆盖换卡前约一帧的窗口）
   ② 手势起点卡 ≠ 当前显示的那张（跨换卡继续有效，且覆盖"两指连点两次上墙导致 `decidedId` 被覆盖"的情形）
2. **`onActionStart` 仍然不早退，且给出两条理由**：
   (a) 跳过基线刷新 → 陈旧基线泄漏重演；
   (b) **跳过 `gestureId` 刷新 → 作废自持**：`gestureId` 停在旧卡、`item` 已是新卡，判据恒真，
   连新手势也在守卫处被挡，`gestureId` 再也刷不了 → **整页手势永久死锁**。
   → **这是"守卫本身制造死锁"的真实路径，由 implementer 自行推出**。

### 重构的解阻方案

等批 15 提交（HEAD 前进）后**重新派发**重构，并把两件事写进新指令：
① 批 15 的 `gestureId` / `decidedId` / `isGestureVoided()` 守卫**必须保留并并入垂直手势模型**
（两个 agent 的插入点在 `onActionStart` / `onActionUpdate` / `settle()` / 上墙按钮上**逐行重叠**）
② 明确基线为新 HEAD

#### Task 7 再审查结果（fix 轮 2）

- **All findings addressed, no new Critical/Important breakage**
- 三条裁决逐条 ADDRESSED（基线无条件刷新 / 归位提前 / `metrics.ts` 仅注释）
- **必查项的定量结论（reviewer 独立推导）**：`onActionUpdate` 仍在 `lastX` 刷新前的守卫**不构成同类问题** ——
  ① 它只能跳过**同一次手势内**的采样（`onActionStart` 已无条件刷基线，跨手势泄漏已被堵）；
  ② 被跳过的是中间采样而非基线，Δ 与 dt 覆盖**同一段连续区间、同一根手指**，商是该区间真实平均速度；
  ③ **误差有界且恰好落在设计意图内**：`fast` 真而 `far` 假要求 `dt < ≈109ms`，
  即只有"动画最后 ~109ms 内起手并真实持续 ≥800vp/s 划过 <87vp"会被判 fast
  —— **这正是 spec §5.1「轻轻一甩也能过」要的速度维度**，且方向仍由 `dx` 决定、伪速度不能翻转方向
- 残留 Low（非本次引入）：跨界拖拽中动画期间的位移不写入 `dx`，最多影响"解禁后立刻松手"一帧

- **Task 7: complete (commits c7b254b..0d1eeb0, review clean)** —— 2 个 fix 轮，0 条 parked
  - 真机验收通过（用户：「手感挺好的」）
- dispatch 携带的跨任务信息：Task 1 的 NaN 分组教训（要求 geo 的 filter/分组分支穷尽）

#### Ruling 7：撤回 Ruling 6（我方判断有误，implementer 驳回正确）

implementer 实测：brief 指定的 `buildOption.sourceOption.excludes` 在本工具链下**导致编译硬失败**：

```
hvigor ERROR: 00303038 Configuration Error / Schema validate failed
propertyName: 'excludes' 非法；sourceOption 的 allowedValues: [ 'workers' ]
BUILD FAILED in 2s（0 task executed）
```

根因（implementer 读 schema 源码确认，非猜测）：`ohos-module-build-profile-schema.json:442-460`，
`sourceOption` **只接受 `workers` 一个键**。替代位置也已排查：`nativeLib` / `napiLibFilterOption` 的 `excludes`
只过滤 `.so` 库；`arkOptions` 的 16 个键无 `excludes`。→ **本 SDK 的模块级 build-profile 不存在按 glob 排除源文件的能力。**

**Ruling 7：撤回 Ruling 6，`entry/build-profile.json5` 保持与 HEAD 逐字节相同（已还原）。**
- 我错在把"一行零风险配置"当成常识判断，而未验证它在**本工具链的具体 schema** 下是否存在。
- 替代方案（**约定式保险**，写入本 ledger，后续每个 dispatch 的约束段携带）：
  **`core/` 目录不建 barrel/index 文件；`core/*.test.ts` 永不被任何生产文件 import。**
  风险残留：若将来有人加 `core/index.ts` 并 re-export 测试文件，`CompileArkTS` 会失败——但那是显式错误，会立刻暴露，不是静默故障。
- 代价（若判断有误）：该风险从"配置层杜绝"降级为"约定层规避"。

#### Ruling 8：`dedupePins` 不补测试（遵守 implementer 的 brief 约束），改为前向要求

implementer 按 brief 明确指令（"不要自行补测试、不要删函数，这是控制器的裁决范围"）未给 `dedupePins` 补测试，并如实上报。
它确实实现了 spec §6.3 的"用户覆盖优先"，属 spec 关键行为却零覆盖。

**Ruling 8**：**现在不补**。理由：它是纯函数、无消费者，现在补测试是在验证一个可能被改写的接口；等 Task 11 首次使用时有真实调用场景，那时补测试更有意义。
**前向要求**：**Task 11 的 dispatch 必须携带要求——`dedupePins` 首次被使用时补测试。**
代价（若判断有误）：这个纯函数在 Task 11 之前保持未验证状态；它当前的实现是照计划逐字写的（读了 geo.ts 的实现，逻辑本身自洽）。

#### Task 2 其余上报项处置

- **`applyRef` 对未知 REF 一律返回正值**（与 `N`/`E` 不可区分）→ 记录为对 Task 9 的**前向观察**：
  Task 9 的 dispatch 需携带此点，让 EXIF 读取层决定是否对未知 REF 做告警/拒绝。
  当前不修：graceful degradation 是合理默认；南半球写错的场景需真机数据才能判断严重性。
- **`dmsToDecimal` / `applyRef` 的 `undefined`/`null` 判空被 implementer 称为"死代码且防不住"** → **控制器判定该观察不成立**：
  `Record<PropertyKey, string | null>` 的取值在运行期确实可能是 `null`，`=== null` 分支可达；
  至于"传 `undefined` 会抛 TypeError"，那需要调用方违反类型签名，不在防御范围。**保留原样。**
- **`node --test <目录>` 在本仓库假红灯**（Node 默认 glob 不匹配 `.ts`，两个测试文件都不被发现，报 `1..1 / fail 1`）
  → 记录为环境事实：**所有测试命令必须逐文件显式列出**。
- **`node --test <目录>` 假红灯 + `--test` 目录形式的失败信息**：已记，见下条。

#### Task 1 次要观察（ledger 备查，不进 fix loop）

- minor (deferred): `mergeBatch` 在 uris 全空/全重复时仍自增 `lastBatchId`（batchId 在过滤前计算）。
  Tests 未覆盖。实现与 brief 逐字一致。→ 交最终审查三方裁决。
- **环境事实（影响 Task 6）**: 脚手架的 `module.json5` **已声明 `ohos.permission.MEDIA_LOCATION`**
  （因为控制器从已实现的 PhotoSpike 复用；PhotoSpike 的 module.json5 已被改过并提交进探针工程）。
  → Task 6 的 dispatch 必须说明「权限已存在，不要再加一次」，只需补 `reason_media_location` 的 string 资源。
- minor (deferred): `oh-package.json5` 的 devDependencies 含 DevEco 模板自带的 `@ohos/hypium`/`@ohos/hamock`。
  implementer 未新增依赖，运行时 `dependencies` 为空。无影响。

---

## 垂直导航重构及其后续修复（`881e6a1` 起）

### 重构 `881e6a1`（基线 `7df1c99`）

- 3 文件（`ui/CardStack.ets` 296→381、`pages/SwipePage.ets` 225→244、`data/decisionStore.ets` 仅加 `remove()`）
- 上下滑翻页（`navOut`）+ 卡片外下方四按钮（`← 返回/归档/上墙/收藏`）+ `navigate()` 返回即撤销决策
- **批 15 三守卫一行未减**，落到 4 个出口；回弹率仍由 `SwipeRollback` + `springBack()` 供数
- `SwipeOutcome`/`SwipeDecision`/`SwipeWall`/`flyOut`/`promoteToWall`/`lastFaved`/`COMMIT_*`/`cardWidth`/`offsetX`
  **全仓零残留**；`rotate` 删除（垂直拖动无倾斜语义）
- **超规格补充（控制器接受）**：`@Prop canPrev` + `canNav()` —— 否则队首下滑会"滑走又弹回"
- `CardEvent` 最终形态：三个**具名 interface** 的联合（内联对象类型 ArkTS 不接受，项目已有先例）
- 翻出距离取 1.2×卡高（不完全离屏，换取"换卡那一帧仍被旧卡遮住、不露页面底色"）

### fix `29216d7`（批 17）：队尾死角

- **implementer 独立发现的真实死角**：`idx` 走完队列后只有一行文字、无卡片/按钮/手势
  → **用户在最后一张上滑后无法再回看刚划走的那张**，与产品诉求直接冲突
- 修法：队尾完成态加「← 返回上一张」按钮 → 复用现成的 `navigate(1)`（**未新写第二套回退逻辑**）
- 独立核实 `navigate(1)` 在队列耗尽态正确：穷举 `idx` 的 4 个写入点 → **不变量 `idx ∈ [0, N]`**，
  耗尽态精确 `idx === N`，`prevIdx = N-1` 合法，delete/remove 同源 photoId

### fix `a834e82` + `36e3694`（批 18）：`decidedId` 陈旧自锁 + 回弹语义

- **Ruling 59：控制器给的 P1 修法是 no-op，implementer 用代数 + 36 态穷举证伪**
  控制器要求在判据 1 补 `&& item.photoId === decidedId`。implementer 证明：
  > **代数**：判据 2 为假 ⟹ `gestureId === item.photoId` ⟹ 该限定恒真 → **不改变任何状态下的判定结果**。
  > **36 态穷举实测差异 0 处**；加了三步复现**照样锁死**。

  **控制器自陈**：写这条修法时只想了"加上更安全"，**没做代数**。
  正解引入了控制器没想到的维度：**唯一能区分「点击→换卡」一帧窗口与陈旧记录的是时间先后，不是身份**
  → `decidedDuringGesture`（`onActionStart` 清、`commit` 置真）→ 判据 1 只在"定案发生在这一次手势期间"为真
- 队首下滑改 `springBack(false)` **静默弹回不计回弹**（产品负责人裁决）；
  回弹率数据源完整性结论：**完整**（分子分母同减，无"偏好看"方向失真）
- `items` 为空时不显示队尾返回按钮

### Ruling 60：跨修复交互无专门关口（流程缺口）

**批 15（标记已定案作废在途手势）× 批 16（返回时撤销决策）相遇**产生 P1 自锁：

> A 上点「收藏」→ 在 B 上点「← 返回」（回到 A）→ **在 A 上拖一下** → A **不可滑/不可决策/连返回也失效，只能杀 App**。

机理：返回同一张后 `decidedId` 仍停在它身上；且 `idx` 从 1 回到 0 时 `if (idx < items.length)`
分支**没切换** → 组件未卸载 → **实例被复用** → 标记保留。
**两次修复各自都对、审查也各自通过，但它们的交互没人验** ——
批 16 的审查只验了"翻页被父组件拒绝"那一支，**漏了"按钮决策后回退到同一张"**。

**流程约束**：当一次修复**改变了某个状态的生命周期**（如"返回时撤销决策"），
派发/审查时**必须回头检查所有依赖该状态的东西**（如"已定案"标记）。

### fix 批 19（`270bac2` + `4c6f504`）：按钮主流程失效

- `onActionEnd` 里 **`settle()` 在前、`gestureId = ''` 在后**（顺序不可颠倒：`settle()` 要靠它判断本次手势是否该作废）
- **implementer 的验证方式是本批最有价值的部分**：写了**可运行的状态机脚本**
  （`fix-batch-19-sim.mjs`，两版共用同一份 `isGestureVoided`，**只差一行**），实测：
  - 路径 1：上滑 A→B 后点收藏/归档/上墙/←返回 —— **修前四者全「无反应 ❌」、修后四者全「生效 ✅」**
  - 路径 2：双指场景两版逐条一致、抬手零上报 ✅（批 15 防护未退化）
  - 路径 3：批 18 的 P1 两版都解锁 ✅
  - 串联场景 D（上滑→收藏→返回→不拖直接上墙→拖）：修前链路上有死点 ❌、修后全链路 ✅
  - 不变量：静止态 12 态被作废 0 态（修前同空间 36 态里**有 14 态点不动**）
- **`decidedDuringGesture` 判断为不清**（4 条理由），其中最本质的一条：
  > `onActionEnd` 是手势「状态」的终点，但**不是「定案发生在这次手势期间」这个历史事实的边界**，
  > 清它等于把真值改写成无读者的假值。

  并**诚实补充**：加清空**不会**造成安全回退 → 理由是「无用 + 维护成本」而非「有害」。
  另：它**拒绝「回调对称⇒清理对称」**作为理由。
- 顺手纠正上批报告的计数笔误（实况 12 条 ArkTS 告警、无汇总行；批 18 报「11 条 + 1 汇总行」）
- `core/metrics.ts` 注释跟上按钮化语义（`'fav'/'archive'` 由**按钮**触发、`'none'` 唯一来源是
  `springBack(true)`、口径判据为 `action !== 'wall'`），**非注释新增行 0**

### fix 批 20（在途）：`onActionCancel`

批 19 疑虑 1（控制器核实 **SDK 确有支持，故为真实缺口**）：

> `onActionCancel` 未注册。若 `PanGesture` 被取消时走 `onActionCancel` 而**不走** `onActionEnd`，
> `gestureId` 不会被清 → **与刚修的缺陷同形态的死锁**。

**SDK 证据**：`sdk/.../ets/component/gesture.d.ts:1697` 与 `:1710`
—— `PanGestureInterface` 有 `onActionCancel(event: () => void)` 与 `onActionCancel(event: Callback<GestureEvent>)`。

修法：注册它，内部 `springBack(false)`（**不上报**：取消不是一次滑动尝试，与"队首下滑静默弹回"同口径）
+ `gestureId = ''`；**不用 `settle()`**（那会按位移/速度判定翻页或回弹，而"取消"不是用户的翻页意图）。

---

## 第二次交互重构：会话式刷照片（用户在 Task 8 后的反馈，`Ruling 61`）

### 用户反馈（原话）

> 每次认领照片 都不记得有哪些已被认领 特别是之前的照片 要下滑很久才能找到认领  
> 我想改一下产品设计  
> 没有认领操作，开始刷照片，可以指定刷的张数，默认 100，自动认领这个张数给到用户，
> 刷完跟用户确认是否继续， 继续的话重复上面流程：指定张数（默认 100），自动认领，
> 并且用户可以指定刷到的照片不重复进入新的池子或者可以重复

**控制器识别的根因**：系统选图器**不显示"本 App 已认领过哪些"**——它每次从头展示整个相册。
`preselectedUris` 只对"已认领未刷过"有用；一旦刷完就散落几千张中间，只能下滑去找。
**这是平台约束的直接后果**（无 `READ_IMAGEVIDEO` → App 不能自己列相册 → 不能给"我已认领"的视图）。

### 用户澄清与裁决

- **"可重复" = 放回抽样**（原话：「就是前面刷过的照片可以继续放到整个照片池子里被抽中，属于放回抽样」）
- **张数可调**：默认 100，可选 20/50/100/200
- **不加显式「加照片」按钮**（靠"池子 < 张数"时自动弹选图器）
- **下一批优先避开上一批**（控制器发现池子≈张数时会退化成"每次同一批"）

### 语义变更（控制器主动指出并获用户默许）

**"归档"不再是"丢进抽屉"**：放回抽样下，已归档照片**仍会被抽中**、明天可能再看到。
→ 更接近"回忆馆"（回忆本就该被反复看见），但**归档不再等于"我不再想看它"**。
→ 控制器建议将来可加"不再抽中"的开关（如长按归档 = 彻底排除），**本批不做，等用户用过再判断**。

### Task A（`a26dc4f`）：纯逻辑 `core/session.ts`

- `sampleSession(pool, size, seenIds, prevQueue, seed)` / `isSessionDone` / `currentPhotoId` / `advance`
- **三层优先级**：① 没见过 ② 见过但不在上一批 ③ 上一批（层内按同一 seed 流打散）
- **`seenIds` 只用于分桶、绝不排除** —— 这是"放回"的实现要点
- 自带 **xorshift32 + 可注入 seed**（不用 `Math.random()`：无种子 → 不可复现、CI 随机红灯、线上 bug 无法重放）
- **13 个单测**（73 总计）
- **implementer 做了变异检验**（临时副本）：丢掉优先级 → 2 红；**把 `seenIds` 当排除集（最危险的误读）→ 2 红**；
  `advance` 刷完返回同一引用 → 1 红
- **诚实结论**：`session.protoBin` **不存在**（尚无页面在值位置引用）→ `BUILD SUCCESSFUL` 对它**无证明力**，
  它**不主张"编译通过"**。控制器认可这种披露。

### Task B（`6163d7e`）：页面改造

- 新增 `data/sessionStore.ets`（`seen.json` 持久化 + 会话内存存取；`MAX_SEEN_ENTRIES=5000`，超出按 `lastSeenAt` 淘汰到 4500）
- `ClaimPage`：张数选择（`ForEach(SESSION_SIZE_CHOICES)`，**顺带成为 `core/session` 的值位置引用**）+「开始刷照片」
  （读池子 → 不够就补货 → 重读 → 抽样 → 存会话 → 跳转）；删掉「认领照片」按钮
- `SwipePage`：数据源改为 `takeSession()`；`@State idx` → `@State session`；完成态「本会话刷完」+「继续刷 N 张」+「← 返回上一张」
- **"看过"标记点**：`goTo()` 内（覆盖 5 条离开路径：决策 / 上滑 / 下滑回看 / 重复上报自愈 / 完成态返回）
  —— **不在点击动作按钮时标记**，否则"滑过去没做决定"的照片不会被记为看过、优先级失真
- **`navigate(1)` 不撤销看过标记**（`sessionStore` 根本没有取消看过的接口；且撤销决策的是 `items[cursor-1]`、
  记账的是 `items[cursor]`，不是同一张）
- **硬指标达成**：`session.protoBin` **存在**（19394 B，全量重建新生成），六个守卫产物 `ANY STALE: False`

### fix `b82f53f`（批 25）：抽样避开上一批

- **控制器发现的缺陷**：池子 ≈ 会话张数时抽样退化成"每次同一批"
  （池 100 / 选 100 / 全看过 → "优先没见过的"**完全失效**）→ 用户会以为 App 坏了
- **缺陷量化（implementer 实测）**：池 200 / 每批 100 / 全看过 → 第 2 批与第 1 批重叠
  **旧实现 54,54,51,46,54**（≈ 随机水平）；**新实现 0,0,0,0,0**
- **向后兼容的三重证明**（本项目最强的一次）：
  ① 既有 13 用例期望值**原样保留**、只补 `[]`；
  ② 测试内"旧两层实现逐字转写"差分 2520 组 deepEqual（含顺序）；
  ③ **从 git `6163d7e` 取出真实旧 `session.ts`** 与新实现差分 **18816 组、0 mismatch、队列顺序逐位一致**
- 存储兼容：用**真实 `sessionStore.ets` 源码** + 平台桩跑 **14 项形状矩阵**全过
  （v1 裸数组 / v2 / 缺 `prevQueue` / 非数组 / 非法条目 / 坏文件 / 不存在 / 原子写无 `.tmp` 残留 / 冷启动 / v1 升级不丢 entries / …）
- **73 单测全绿**；`session.protoBin` 21514 B + 六守卫全部本次新生成

### 遗留（用户已知，非阻塞）

- **池子张数 == 会话张数时，"每轮不同"是数学必然做不到的**（一批 = 整个池子）。
  出路是往池子里加照片；按用户选择，补货只在"池子 < 张数"时**自动**触发。
  → 控制器已告知用户"把张数选得比池子大即可触发"，并说明可随时加显式入口。

---

## Task 9 开始：EXIF（时间 + GPS）+ 地点索引

- brief: `.superpowers/sdd/2026-10-08-photo-wall-m1/task-9-brief.md`
- **计划里第四份"已知缺陷的复制粘贴"**（`locationIndex.ets` 又是 `String.fromCharCode` 按字节拼串，
  前两份在 `claimStore` / `decisionStore`）→ brief 修正为 `buffer.from(bytes).toString('utf-8')`
- **brief 的六项修正**：① UTF-8 解码 ② 形状校验 + 区分首次运行/损坏的告警（Ruling 18）
  ③ 原子写 `.tmp` + `renameSync` ④ `readSync` 返回值 + 短读（Ruling 32）⑤ 删死 import `BusinessError`
  ⑥ `exifReader` 的扩展名 `.ts` vs `.ets` 以实际编译为准
- 另要求：`parseExifTime` **不得依赖 `Date.parse` 对溢出日期的宽容行为**，要自己校验

### Task 9 结果（`39b7d03`）与三条发现

- 交付：`core/exifParse.ts` + `core/exifParse.test.ts`（**+22 用例，95 总计**）、`data/exifReader.ts`、
  `data/locationIndex.ets`、`SwipePage` +23 行
- 全量重建后 **`exifParse` / `exifReader` / `locationIndex` 三个 `protoBin` 都在**（11988/13261/26181 B）
- 六项修正全落；`exifReader` 保持 **`.ts`**，并用**负向探针**证明 `.ts` 被完整 ArkTS 类型检查
  （报错原文指名 `@ohos.multimedia.image.default.PropertyKey` 不可赋给 number）→ "不被当 ArkTS"的 fallback 条件不成立
- **额外验证**：因 `locationIndex.ets` 进不了 Node 单测，它写了 `task-9-location-sim.mjs` ——
  **只替换 6 处 import 说明符（并自校验除这 6 行外逐行不变）后真跑源码文本**，**25 PASS / 0 FAIL**，
  覆盖 UTF-8 往返、非数组/截断/短读/写失败原子性、增量不重读不重写、进度回调

#### Ruling 62：控制器对 Ruling 24 的机制描述不准确（implementer 实测纠正）

控制器在 brief 里写「Latin-1 解码 → **JSON 解析失败**」。implementer 实测指出：

> **Latin-1 解码不会让 `JSON.parse` 失败** —— `0x80-0xFF` 都是合法字符。
> 真后果是 **photoId 静默 mojibake → 记录永远命中不了**。

**修复方向不变（仍必须改 UTF-8），但理由更重**：不是"会报错"，而是"**静默失配**"——
比解析失败更难发现（解析失败至少会被 catch 住并告警）。

#### Ruling 63：`claimed.photos` 在 SwipePage 已不存在（implementer 发现），但它给的替代错了范围

`SwipePage` 在 Task 8 后不再读 `ClaimStore`，故 brief 里的 `claimed.photos` 编译不过。
implementer 改用 `session.queue` 并说明理由 —— **编译问题解决了，但不是控制器的意图**：

> `session.queue` 只是**本会话抽中的那几十张**。而地点索引必须覆盖**整个已授权池**，
> 否则 Task 10 的地图页上，**没被本会话抽中的照片没有坐标 → 地图上不出现**。
> 放回抽样下每局样本都不同，索引永远只覆盖"最近几局"。

**`ClaimPage` 里已经构建了完整的池子**（`pool`）→ 索引构建移到那里（`SwipePage` 那段删掉）。
**Ruling 63**：控制器的 brief 引用了**已不存在的变量**（brief 是照计划写的，而计划成文于 Task 8 之前）。

#### Ruling 64：implementer 修掉了控制器骨架里的一个 fd 泄漏

brief 的 `readExif` 骨架：`openSync` 成功而 `createImageSource` 抛错时，
原骨架的 catch **直接 return**，第二个 `try` 的 `finally` 还没进入 → **fd 泄漏**。
它改为单一 `try/catch/finally`，且只持有 `fd: number`（`File` 未被 `@kit.CoreFileKit` 具名导出，
作类型注解有编译风险；`closeSync` 接受 `number | File`）。
**另一处更细的判断**：**先 `await src.release()` 再关 fd** —— SDK 里 `ImageSource.release()` **只有 Promise 形态**
（没有 `releaseSync`），不 await 就关 fd 会有竞态。**这两处都超出控制器给的骨架。**

#### fix `38e93fb`（批 26）+ `af863db`（批 27）：索引范围与并发

- **Ruling 63 落地**：索引构建从 `SwipePage.aboutToAppear` 移到 `ClaimPage.startSession`（传整个 `pool`），
  `SwipePage` 那段整段删除并清掉两个死 import
- **方向性铁证**：`ClaimPage.protoBin` **+4224 B**、`SwipePage.protoBin` **−4217 B**、**其余 19 个逐字节不变**
  → 证明"引用真的换了模块、且只影响了这两个"
- **批 27**：`ClaimPage` 加 `@State starting` 重入闸门 + `try/finally`（**先列出 5 条出口**，
  证明无"按钮永久禁用"路径）；`locationIndex` 加模块级 `building` 标记

#### Ruling 65：控制器给 Task 10 留的前向要求本身是错的（implementer 发现）

控制器在批 27 的任务里写：地图页"应自行 `await buildFrom(pool)` 一次 —— **pending 为空时立即返回**"。
implementer 指出这**不成立**：

> `building` 闸门让**并发时的那一次**返回**部分快照**，所以 `await buildFrom(pool)`
> **不足以保证完整** —— 而"首页构建还在跑时进地图页"**正是它要修的场景**。
> Task 10 会**看起来等过了、实际拿到局部数据** → **地图上少照片，且没有任何报错**。

**取舍（控制器裁决）**：**采纳 (b) 加访问器**，而非 (a) 让 Task 10 自校验重试。
理由：自校验重试要 Task 10 **知道 pool 是什么**并比对，把"完整性"这件事**泄漏到每个调用方**；
而"等索引稳定"是 `LocationIndex` **自己的职责**。
→ 批 28 新增 `awaitIdle()`：**`buildFrom` 保持"并发返回快照"（不阻塞、不抛错）**，
`awaitIdle()` 则**诚实承诺"返回时没有别的构建在跑"**，且**别人的构建失败不让它抛错**。

**这条的教训（Ruling 66）**：非阻塞 + 静默降级（返回快照而不报错）**必须配一个"我需要真的完成"的接口** ——
否则调用方**没有办法表达"我要完整的"**，只能得到一个看起来成功、实际不全的结果。

#### fix `bb39be8`（批 29）+ `cbf7e54`（批 30）

- **批 29**：消除 `pending` 遮蔽（模块级 `pending` → **`pendingBuild`**、`doBuild` 内 → **`todo`**）。
  **implementer 推翻了控制器建议的等价性证明方法**：
  > 任务书建议的"统一占位符后比对"**有致命漏洞** —— 若把 3 个名字都映射到同一占位符，**漏改一处仍会相等**。

  改为三层证明：① **站点 `(行,列)` 逐个相同**（列号相同堵死任何 token 增删）② 归一化后**逐字节** sha256
  ③ 逐行账目 253 未变 / 15 改名 / 3 注释 / **0 未归类**；另有 **4 个反向对照**证明**检查器会红、非恒真**。
  **Ruling 67**：**只能变绿的检查器等于没有检查器。**
- **批 30**（Task 9 审查的 1 Important + 4 Minor）：
  - **写侧短写**（Important）：`writeSync` 返回值原本被丢弃、`renameSync` 无条件执行
    → 短写会让**截断的 `.tmp` 覆盖好索引** → 下次 `load()` 解析失败 → **空索引**（读侧已修的同一最坏后果，换到写侧）
    → 修法按 **UTF-8 字节数**比对（**不是 `payload.length`** —— 非 ASCII photoId 会让两者不等）
  - **验证含因果链实证**：④ 用 HEAD 版源码复现 → 照样 rename → 文件截断 → `load()` 返回空索引 + 仅固定文案告警；
    ③b **短写但回报值恰等于 `payload.length`** 时仍被检出（若按字符数比对就会 rename 截断文件）
  - 另三处：`building = true` 移入 `try` 第一行、`@param uris` 注释改为"整个已授权池"
    （**原文写"通常是本次会话的队列"，Task 10 照它实现就会复现批 26 的缺陷**）、`exifParse` 交叉引用改到真实位置
  - **控制器批准其超范围一处**：审查说"四条告警"，文件实有 **5 处**（第 5 处在 `awaitIdle` 的 catch），
    它一并修了 —— 同一缺陷类、同文件，不修则那处成为"唯一没有上下文的一条"

---

## 产品转向：地图墙 + **手动选地点**（用户裁决，`Ruling 68`）

### 真机数据（控制器直接从设备读取）

```
池子 239 张  →  索引 239 条      ✅ N 完全正确（批 26 的范围修复生效）
takenAt == 0 的只有 19 条（8%，全是截图与微信导出图）
lat == 0 的：238 条              ⚠️ 只有 1 张带 GPS
唯一带 GPS 的：IMG_20261008_144849.jpg  (31.24995, 121.48135) = 上海，小数度转换正确
时间分布：只有 2026-08（3）、2026-09（84）、2026-10（133）—— 这台设备是新的
```

**结论**：`readExif` / `parseExifTime` / GPS 解析**全部工作正常**；**问题是照片本身没 GPS**。
→ 地图墙上只有 **1 个钉子**，spec 说的"手动指定地点"退路从"退路"变成**主路径**。

### 用户裁决（原话）

> 还是地图墙   用户选择上墙的时候  如果获取不到地址信息，提供用户选择地点   具体到县/县级市  下拉选择

**控制器的评价**：这把"没 GPS"从**缺陷**变成了**产品特性** ——
手动选的地点比 GPS 更可控（GPS 可能飘到隔壁小区，而你选的是"这张是在**老家**拍的"，那才是记忆的意义）。

### 数据源（控制器核实）

**`xiangyuecn/AreaCity-JsSpider-StatsGov`** —— **MIT 许可**（已读 LICENSE 原文，可打包，需保留版权声明）。
数据源为 国家地名信息库 / 高德 / 腾讯地图，版本 `2025.251231.260403`（2026-04-03 更新）。

| 文件 | 内容 |
|---|---|
| `ok_data_level3.csv` | 省市区三级（`id,pid,deep,name,pinyin,ext_name`）230 KB |
| `ok_geo.csv` | 与上表用 **`id`** 关联的**中心坐标**（`geo` = `"lng lat"`，**GCJ-02 火星坐标**） |

**已知偏差（要写进注释，不做转换）**：数据是 GCJ-02，手机 GPS 是 WGS-84，**差约百米级** ——
对"选到县"完全够用；转换算法本身是加密偏移表、误差也有几十米，**不如把已知偏差写明，比"假装精确"诚实**。

### 三块拆分

| 块 | 内容 | 状态 |
|---|---|---|
| **A. 数据 + 纯逻辑** | `rawfile/china_areas.json` + `core/areaData.ts`（查找/最近县）+ 单测 | 🏃 已派发 |
| **B. 地点选择器** | 上墙时无坐标 → 省→市→县三级级联下拉 | 📋 待 A |
| **C. 地图墙渲染** | Task 10 原计划（还需**中国轮廓路径**，同样要"找可靠数据源 + 说明许可"，不凭记忆画） | 📋 待 B |


---

# Ruling 69–76：整分支终审与其修复（2026-10-10）

**终审范围**：首个提交 … `117acdc`（87 个提交）。审查者**只读**，
在 `$env:TEMP` 里 `git archive` 出只读快照跑测试（**没有 checkout/stash 控制器的工作区**），
临时 ref 用后删除，仓库零写入。

## Ruling 69：终审发现 5 条确定缺陷 + 3 条可疑，全部修复

| # | 缺陷 | 修法 | 提交 |
|---|---|---|---|
| **D1** | `ClaimStore.save()` 无 `.tmp`、丢弃 `writeSync` 返回值、`catch` 是**裸 return** → 一次短写**永久清空 239 张已授权照片池，且无日志** | 统一原子写 + 分级告警 | `49a9e20` |
| **D2** | `decisionStore`/`sessionStore` 短写被忽略却**无条件 rename** → 截断文件覆盖好文件 | 同上，**4 个 store 迁到一份实现** | `49a9e20` |
| **D3** | 动图失败写**永久负缓存**（失败头号成因是**瞬时**的内存压力） | 只对**确定性结论**记结论 | `c527fd0` |
| **D4** | 动态照片瞬时失败后**本会话无重试入口** | 拆状态（`motionForId`/`motionInFlightId`/`motionTries`）+ **有上界的重试** | `26afb82` |
| **D5** | `frameDecodeSize` 降采样分支**只有 1 条用例且预算用错** | 补生产预算档 + **反向判别力证明** | `28c6e6f` |

**可疑（未证伪，不是已排除）**：`@kit.*` 只做类型导入的 9 个文件（已有产物**反证**那一次构建没发生假绿）；
`CardStack.pinching` 抬手那一帧的翻页窗口（**审查者明确说"我证不了"** ——
`fingerList` 是平台给的，伪造序列全走安全分支）；`capEvents` 的零拷贝别名契约。

**审查者的诚实记账（值得记）**：它一度以为找到"假绿"复现与 `scaleAtPinchStart` 未复位，
**两次都用实测推翻了自己**，并写进"已检查无问题"；探针只跑通一半时**明确不下结论**。

## Ruling 70：D1 的危害链条（为什么它是本项目最严重的一条）

```
写入时短写（POSIX 语义下 ENOSPC/EINTR 可以短计数而不抛）
  → 文件被截断 → 下次 load() 的 JSON.parse 抛
  → catch 裸 return emptyClaimState() → photos: []
  → 首页「还没有可刷的照片」
  → 用户逐张点选、经系统选图器永久授权的 239 个 URI 全部消失
  → 无提示、无日志、只能重新逐张选
```

**同一份代码里早有正解**：`locationIndex.save()` 的注释已把危害写出来
（「截断的 `.tmp` 会覆盖掉一份好索引 → 地图墙空白」），**只是另外三个 store 没跟上**。
**"知道该怎么做"与"四处都做了"是两件事。**

## Ruling 71：`writeTextAtomic` —— 让"短写会不会被检出"在 Node 里可测

`fix-batch-36` 把"该写多少字节 / 返回值是否算成功"抽进 **`core/atomicText.ts`**（纯逻辑，零 `@kit.*`），
平台动作经 **`AtomicWritePort`** 注入；`data/atomicWrite.ets::writeTextAtomic` 是唯一一处 fileIo 写盘。

**契约一句话**：**抛错 ⟺ 真身一个字节都没改。**

**这个分层的价值**：短写检测可在 Node 单测里验证 —— **不必真机、不必造磁盘满**。
证据：短写 1 字节/0 字节都被检出且 `Buffer.compare == 0`（真身逐字节未动）；
**非 ASCII 判别性用例证明"用 `payload.length` 会放行截断文件"**。

## Ruling 72：瞬时失败 ≠ 永久结论（三条缺陷的同一个根）

| | 瞬时事件 | 曾被错记成 | 后果 |
|---|---|---|---|
| D1/D2 | 写入被中断 | **文件已损坏** | 把数据删了 |
| D3 | 内存压力 | **这张不是动图** | 那张 GIF 永不再播 |
| D4 | Context 抖动 / IPC 超时 | **这张没有动态照片** | 本会话不再探 |

**"这一次失败了" ≠ "这件事不成立"。** 修复时同时要求：**重试必须有上界**
（否则从"不重试"滑到"每次触摸都发一次 IPC"）。

## Ruling 73：`protoBin` 的字节大小**不是**有效的假绿判据（**取证规范修正**）

`fix-batch-38` 改了 `ClaimPage.ets` 与 `metricsStore.ets`，而两个 `protoBin` 的
**字节长度与改动前完全相同**（80391 / 18770）。**只看大小会得出"没编译"的错误结论。**

**正确取证 = 符号内容检验**：
- `ClaimPage.protoBin` **含 `failureMsg`**（只存在于本次新增代码）
- `metricsStore.protoBin` **含 `writeTextAtomic`**、**不含 `tmpPathOf`**（本次删掉的）

**"文件是新的"（存在 + mtime）与"改动进去了"是两件事。**
控制器此前一路用"存在 + mtime 新"当判据，**这条修正了它**。

## Ruling 74：转化率口径与目标

**口径**：分母 = **收藏池**（`faved ∪ walled`）。因为 `applyDecision('wall')` **直接写成 `walled`**，
只数 `faved` 会让**分母被分子吃掉**（实测读出 **150%** —— 百分比超 100% = 分母选错的典型症状）。

**目标**：`≥ 15%`（只判下限）。spec 原写 15%~30%，**上界已取消**（`35c6f28` + spec 同步 `0c04f79`）：
上界假设"先收藏再挑着上墙"（**两步**），而**「上墙」现在是一步直达的按钮**，**上界衡量的是已不存在的交互**。

**首次真机真值**：`walled 33 / 收藏池 55 = 60%`。**不是缺陷**：能入用户眼的共 55 张（239 的 23%），
而入眼的多半想挂地图上 —— **恰好印证定位「核心是"重新看见"」**。

## Ruling 75：动画/动图的"失败"必须区分瞬时与确定

`animSource` 的负缓存写点**实际是 5 处，不是工单说的 4 处**（第 5 处：平台给不出句柄）。
实现者按**原则**（只对确定性结论写）判定第 5 处也属"没探到"，一并去掉并**显式登记**。
**照抄指令会漏掉这一处。**

## Ruling 76：并发作业的代价（**下次不要再这样**）

两个 agent 在同一工作树并发提交期间：
- 一方首次全量重建 **7 个 ERROR 全在对方的在制文件里**（只能用隔离副本重验）
- 另一方一次编译 `BUILD FAILED`，原样重跑即过
- **DevEco Studio 开着会与命令行争 `entry/build`**（IDE 自行构建会清掉命令行刚建的产物）

**教训**：① 并发作业应隔离工作树（不同 clone 或 worktree）；
② 取证要在"删 build → 构建 → 同一进程内立即取证"；
③ **同一文件集的修复必须串行**（本项已是既有 Ruling，本次再次验证）。

**另记**：一次 `SignHap` 阶段的瞬时签名失败（`CompileArkTS` 已过、配置文件 mtime 未变），
原样重试即成功 —— 判定为环境抖动，但若反复出现需另查。

---

# Ruling 77–84：指标口径修正与"取证"本身的修正（2026-10-10）

## Ruling 77：`protoBin` 的字节**包含注释**（控制器对照实验，A/B/C 三组）

| 组 | 条件 | 结果 |
|---|---|---|
| **A** | `ff28d3f`（注释已改）构建 | 37 个产物 |
| **B** | **同源码再构建一次** | 与 A **差异 0 个** ⇒ **构建字节确定** |
| **C** | 把注释**回退**到 `58ff624` 再构建 | 与 A **差异 3 个** |

C 组细节（**这是关键**）：
```
SwipePage.protoBin  128422 B → 128422 B   大小相同、哈希不同
CardStack.protoBin  212038 B → 212038 B   大小相同、哈希不同
metrics.protoBin     39073 B →  39016 B   大小和哈希都变
```

**推论（三条一起看才完整）**：
1. **注释会进入产物** ⇒ "搜索被删符号"**必须先去掉注释**（否则命中历史注释 → 假绿）
2. **构建字节确定** ⇒ "变了"确实意味着源码变了，**不是随机噪声**
3. **大小可以相同而内容不同** ⇒ **只看大小必然漏判**（batch-38 踩的坑）

**另测**：`protoBin` 字节还**依赖检出路径**（换目录构建 35/35 全不同）⇒ **跨目录比对无效**。

## Ruling 78：`protoBin` 取证的最终规范

- ✅ **可以做**：`grep` 产物里的**新符号**；断言**被删符号不再出现**（**先剥注释**）
- ✅ **可以做**：同路径、**同源码**两次构建，验**确定性**
- ❌ **不可以**：只看**文件大小**判断有没有改动
- ❌ **不可以**：**跨目录**比对产物
- ⚠️ **纯注释批次**：产物会变 ⇒ **不能**用"产物没变"证明"逻辑没改"；
  正确证明是"**去注释后代码逐字节相同**"（batch-40 用的就是这个）

## Ruling 79：回弹率口径反转（真机数据驱动，`58ff624`）

**旧口径**：分母 = 排除 `wall` 的事件数 → 真机 `4/24 = 16.67%`
**新口径**：分母 = **尝试组数**（键 `photoId|shownAt` = "一张照片的一次出现"）→ 真机 `4/47 = 8.51%`

**两处对历史判据的反转，依据都是真机数据而非口味**：
- `b49dd74` 曾写「勿改成按卡片数」，理由是"回弹后成功滑出 = 消耗 2 次尝试" ——
  真机数据显示**那是一次手滑**（用户意图仍是一次），算成 2 次才是失真
- `5c24f16` 排除 `wall` 的理由是"点按钮不是滑动尝试" ——
  真机数据 `none → wall` 显示**回弹就发生在最终上墙的那次尝试里**

**不加字段**：`shownAt` 只在换卡时刷新、回弹早退不换卡、wall 推进在异步 ⇒
同一次出现的全部事件**天然共享同一个 `shownAt`**（由代码结构保证，非调参）。

**附带好处**：分组对重复上报**幂等** ⇒ 即便 150ms 防抖失效，分母也不会被放大。

**控制器的事实订正**：我说过"上墙也是一次上滑"——**在 HEAD 上不成立**（`wall` 唯一来源是按钮
`CardStack.ets:1546/1695`，上滑是翻页 `settle():1583`）。实现者没有照抄，而是**保住了结论、换掉了错误的论据**。

## Ruling 80：`medianDecisionMs` 的残留**有意不修**

一次尝试组内的重试会给中位数贡献多个样本。它与回弹率的旧缺陷同形，**但方向相反**：
**排除 `wall` 对中位数是保守的**（会让中位数偏高），故实测 `656.5 ms` 是**偏悲观的上界**。

改它等于把"**一次决定要多久**"换成"**一次意图持续多久**"—— 那是另一个产品问题。
**结论：留着，并在注释里登记**（`core/metrics.ts:70-77`）。

## Ruling 81：注释即口径 —— 口径变了，全仓注释必须跟上（`ff28d3f`）

`58ff624` 改了口径后，4 处注释与代码矛盾（例如「'wall' 已不参与滑动口径」）。
**行为对、说明错** —— 在本项目「注释即历史 / 口径只有一处定义」的风格下，**它会误导下一个读代码的人**。

**本批还自查出一处自己写错的注释**：把 `if (rolledBack) { return; }` 说成"在下面"（实际在上面）。

**"只改注释"的三重机器证明**（可复用）：
1. diff 逐行分类：47 个内容行，**非注释行 = 0**
2. **去注释后代码与上一版逐字节相同**（三个文件 SHA256 全同）
3. 产物侧：37 个 protoBin 里**只有改注释的那 3 个**变了

## Ruling 82：遗留的真实残留（已登记，未修）

**R1**：`SwipePage.handle()` 的重复上报守卫在 `recordSwipe` **之后** ⇒ "同帧重复点按钮"会让
按新分组键**多算 1 个尝试组**（分母 +1 → 回弹率**略偏"好看"**）。
幅度与旧口径相同、**非本批引入**。修它属逻辑变更（要在 `recordSwipe` 前加"同 `photoId`+同 `shownAt` 已上报"判据）。

**R2**：`core/metrics.test.ts:43` 的**用例名**仍是旧单位措辞（字符串字面量，非注释）。
改它会同时破坏"只改注释"的两项验收，故留给专职批次。

## Ruling 83：控制器第二次犯同一个错（**记下来**）

读取设备文件时**设备断连**，命令返回 75 字符的错误文本，而我在里面数事件 → **0 条 → 算出 `NaN%`**。
**同一个错误（把检测失败当成事实）在本次会话里犯了两次**，而第一次之后我刚把它写进自己的检查规矩。

**唯一可靠的防法**：**先验证命令成功（退出码/内容特征），再解析结果**。

## Ruling 84：并发作业的代价（再次验证 Ruling 76）

本阶段同时派出的批次改到了同一批文件，导致：一方首次全量重建 7 个 ERROR 全在对方在制文件里；
另一方一次编译 FAILED，原样重跑即过；**DevEco Studio 开着会与命令行争 `entry/build`**。
**教训不变：并发作业必须隔离工作树；同一文件集的修复必须串行。**
