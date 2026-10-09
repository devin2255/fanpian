/**
 * 省 → 市 → 县 三级地点选择器（照片没有 GPS / 没有手选地点时，由上墙流程调用）。
 *
 * ── 选型：TextPickerDialog + **级联** range（先读 SDK 声明再定）────────────────
 *   声明位置（`D:\software\DevEco Studio\sdk\default\openharmony\ets\`）：
 *   - `component/text_picker.d.ts:1758`
 *     `declare class TextPickerDialog { static show(options?: TextPickerDialogOptions) }`
 *     —— 存在但已 **@deprecated since 18**（`@useinstead UIContext#showTextPickerDialog`）。
 *     本项目 `targetSdkVersion/compatibleSdkVersion = 26.0.0`，所以走**未废弃**的那条：
 *   - `api/@ohos.arkui.UIContext.d.ts:4759`
 *     `showTextPickerDialog(options: TextPickerDialogOptions): void`（@since 10，未标废弃）。
 *   - `component/text_picker.d.ts:64` `TextCascadePickerRangeContent { text; children? }`，
 *     而 `:107` 明确写着 range 传 `TextCascadePickerRangeContent[]` 时是
 *     **多列级联选择器**（Multi-column cascading pickers）—— 省→市→县的**联动由系统组件负责**。
 *
 *   为什么不自拼三个 TextPicker（bindContentCover / CustomDialogController 两条路都不选）：
 *   自己拼就要维护"选省之后刷新市的 range、并把县的 range 一起作废"这套状态机，还要处理
 *   range 动态变更时的选中项复位（SDK 在 `:110` 明确警告：range 的**类型与列数不可动态修改**，
 *   `:99` 又写着动态改成空数组时"当前有效值仍然显示"）。那套东西**只能靠真机手感验证**，
 *   而级联 range 把联动交给系统组件：**联动不是我实现的，也就没有"我实现错了"的可能**。
 *   本文件的职责因此被压到三件事：读数据、把树交给系统、把结果翻译回 CountyHit。
 *
 * ── 数据只读一次 ─────────────────────────────────────────────────────────────
 *   rawfile 105723 字节（≈103.2 KB）：模块级缓存。**成功即永久缓存**（不再读盘、不再解析）；
 *   **失败不缓存**（下次开选择器会重试一次）—— 一次瞬时失败不该让这个功能永久失效。
 *   解码一律 `buffer.from(bytes).toString('utf-8')`：按字节拼串等价于 Latin-1，
 *   中文地名会变成 mojibake（本项目 Ruling 24 踩过两次）。
 *
 * ── 优雅失败 ─────────────────────────────────────────────────────────────────
 *   读不到 / 解析不出来（树为空）时：`hilog.warn` 一行，然后**按"取消"回报**
 *   （`kind: 'cancelled'`）—— 不弹一个空选择器（那会让用户以为 App 坏了），
 *   也不抛错（上墙流程按"这次上墙没发生"处理，卡片仍然可用）。
 */
import { common } from '@kit.AbilityKit';
import { buffer } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { promptAction, UIContext } from '@kit.ArkUI';
import { CountyHit, parseAreaData } from '../core/areaData';
import { AreaPickNode, buildAreaTree, hitFromPick } from '../core/placePick';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';
/** rawfile 里的区划数据（相对于 entry/src/main/resources/rawfile/）。 */
const AREA_RAW_NAME = 'china_areas.json';

/**
 * 一次选择的结局。写成**判别联合**（与 ui/CardStack.ets 的 CardEvent 同一风格）而不是
 * "返回 CountyHit 或 undefined"：调用点必须显式处理"没选到"这一支，
 * 而 undefined 很容易被 `if (hit)` 一笔带过 —— 那正是"取消路径必须干净"最容易出错的地方。
 */
export interface PlacePicked { kind: 'picked'; hit: CountyHit }
export interface PlaceCancelled { kind: 'cancelled' }
export type PlaceOutcome = PlacePicked | PlaceCancelled;

/** 把 catch 到的值转成一行可打印文本（与 data/locationIndex.ets 的 errText 同款）。 */
function errText(e: Object): string {
  if (e instanceof Error) { return e.message; }
  return JSON.stringify(e);
}

/** 选择器回传值的形状描述：真机上"形状不认识"时，日志里必须能看见**实际收到了什么**。 */
function shapeOf(value: string | string[]): string {
  if (typeof value === 'string') { return `string(${value})`; }
  if (!Array.isArray(value)) { return `非数组: ${JSON.stringify(value)}`; }
  return `array(${value.length}): ${value.join(' / ')}`;
}

// ── 模块级缓存（见文件头"数据只读一次"） ────────────────────────────────────
type LoadState = 'idle' | 'loading' | 'ready' | 'failed';
let loadState: LoadState = 'idle';
let tree: AreaPickNode[] = [];
let waiters: ((ok: boolean) => void)[] = [];

function flushWaiters(ok: boolean): void {
  const ws: ((ok: boolean) => void)[] = waiters;
  waiters = [];
  for (let i = 0; i < ws.length; i++) { ws[i](ok); }
}

/**
 * 确保区划数据已装载（首次调用读 rawfile，之后命中缓存）。
 * 并发调用只读一次盘：后来的调用排队等第一次的结果（`loading` 分支）。
 * 失败不抛错：回调收到 `false`，调用方据此优雅失败。
 */
export function ensureAreaData(ctx: common.UIAbilityContext, onReady: (ok: boolean) => void): void {
  if (loadState === 'ready') { onReady(true); return; }
  waiters.push(onReady);
  if (loadState === 'loading') { return; }   // 已有一次在读：排队，不重复读盘
  loadState = 'loading';
  ctx.resourceManager.getRawFileContent(AREA_RAW_NAME)
    .then((bytes: Uint8Array) => {
      // UTF-8 解码（Ruling 24：按字节拼串 = Latin-1，中文地名会烂成 mojibake）
      const text: string = buffer.from(bytes).toString('utf-8');
      parseAreaData(text);           // 幂等，内部失败时静默保持"未加载"
      tree = buildAreaTree();
      if (tree.length === 0) {
        // 读到字节了但树是空的：JSON 损坏、结构不符，或全部县都无坐标。
        // 三种成因在这里长得一样，所以把**字节数**打出来（0 字节 = 文件没打进 HAP）。
        loadState = 'failed';
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `区划数据装载失败：${AREA_RAW_NAME} 读出 ${bytes.length} 字节，但三级树为空（解析失败或无可落点的县），本次不弹选择器`);
        flushWaiters(false);
        return;
      }
      loadState = 'ready';
      hilog.info(DOMAIN, TAG, '%{public}s',
        `区划数据就绪：${tree.length} 个省可选（rawfile ${bytes.length} 字节，仅本次读盘）`);
      flushWaiters(true);
    })
    .catch((e: Object) => {
      loadState = 'failed';   // 不缓存失败：下次调用会重试
      hilog.warn(DOMAIN, TAG, '%{public}s', `区划数据读取失败（${AREA_RAW_NAME}）: ${errText(e)}`);
      flushWaiters(false);
    });
}

/**
 * 弹出三级选择器。**异步**：首次要读 rawfile 才能弹，所以结果走回调。
 *
 * @param ui      `UIContext`（页面里用 `this.getUIContext()` 拿）。用它是为了走
 *                `showTextPickerDialog`（未废弃的那条，见文件头选型说明）。
 * @param ctx     AbilityContext：读 rawfile 用（`resourceManager`）。
 * @param onDone  结局回调，**恰好调用一次**：
 *                `'picked'` = 用户点了确定、且三级能定位到一个**有坐标**的县；
 *                `'cancelled'` = 用户点了取消 / 数据没就绪 / 回传形状不认识。
 *                调用方必须把 `'cancelled'` 当成"这次上墙没有发生"：
 *                **不落决策、不推进队列、不写盘**。
 */
export function pickPlace(ui: UIContext, ctx: common.UIAbilityContext, onDone: (o: PlaceOutcome) => void): void {
  ensureAreaData(ctx, (ok: boolean) => {
    if (!ok) {
      // 优雅失败：不弹空选择器、不抛错，按"取消"回报（调用方什么都不做）
      onDone({ kind: 'cancelled' });
      return;
    }
    const options: TextPickerDialogOptions = {
      // 三级级联：联动由系统组件负责（见文件头选型说明）。
      // 类型上 range 期望 TextCascadePickerRangeContent[]，AreaPickNode 与它**结构一致**
      //（text + children?，见 core/placePick.ts 的说明），所以直接传，不再复制一层。
      range: tree,
      // 三级都默认选中第一项：用户"随便点两下确定"也能得到一个地点（降低操作成本）。
      // 默认值本来就是每列第一项，这里显式写出来是为了让这条产品要求**在代码里看得见**
      //（也有单测盯着：默认三项必须能解出一个带坐标的 CountyHit）。
      selected: [0, 0, 0],
      // 34 个省 / 3210 个县：滚到头回卷只会让人误选（省级列表回卷尤其容易选错）。
      canLoop: false,
      onAccept: (r: TextPickerResult) => {
        const hit: CountyHit | undefined = hitFromPick(r.value);
        if (hit === undefined) {
          // 形状不认识（单列字符串 / 列数不是 3 / 名字对不上）：**不猜**，按取消处理。
          // 带上实际形状：真机上这一行是唯一能看出"平台回传格式和文档不一样"的证据。
          hilog.warn(DOMAIN, TAG, '%{public}s', `选择器返回值不认，按取消处理: ${shapeOf(r.value)}`);
          onDone({ kind: 'cancelled' });
          return;
        }
        onDone({ kind: 'picked', hit: hit });
      },
      // 取消是**必须**有的一支：用户改主意时不该被迫选一个地点（它会被当成用户对这张照片的定性）。
      onCancel: () => { onDone({ kind: 'cancelled' }); }
    };
    // showTextPickerDialog 声明了 @throws（401 参数错误 / 100001 内部错误）。
    // 必须接住：抛出去的话 onDone **一次都不会被调用**，上墙流程就永远悬在那里 ——
    // 症状是"点了上墙，什么都不发生，也没有任何日志"，比弹不出选择器更坏。
    // 接住之后按"取消"回报：与用户自己取消走同一条干净的收尾路径（不写盘、不推进）。
    try {
      ui.showTextPickerDialog(options);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '%{public}s', `弹出地点选择器失败，按取消处理: ${errText(e)}`);
      onDone({ kind: 'cancelled' });
    }
  });
}

/**
 * 提示"正在读取照片地点信息"（上墙流程在等索引构建时调用）。
 *
 * 单独一个具名函数而不是散在调用点：它引入了一个本项目此前没用的 API
 *（`UIContext.getPromptAction().showToast`，`api/@ohos.arkui.UIContext.d.ts:4555 / 741`，
 * @since 10 且未标废弃 —— 废弃的是全局 `promptAction.showToast` 那条老路）。
 * 集中在一处，将来换实现（或某个设备上不支持）只改这里。
 *
 * 内部吞掉异常：toast 只是提示，**弹不出来也绝不能影响上墙流程**（它是在 beginWall
 * 里被调用的，抛出去会让后面的 resolveWallPlace 根本跑不起来 = 点了上墙没反应）。
 */
export function toastReading(ui: UIContext): void {
  try {
    const options: promptAction.ShowToastOptions = { message: '正在读取照片地点信息…' };
    ui.getPromptAction().showToast(options);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '%{public}s', `提示 toast 弹出失败（忽略，不影响上墙）: ${errText(e)}`);
  }
}
