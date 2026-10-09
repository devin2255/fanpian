/**
 * 设备侧读 EXIF（拍摄时间 + GPS）。**不可单测**（要真机/模拟器的 fileIo 与 ImageSource），
 * 所以本文件只做「取字符串 → 交给纯层解析 → 组装」这一件事，
 * 所有判定规则都在 `core/exifParse.ts`（有 Node 单测）。
 *
 * 平台事实（本项目已实测，勿改成 MediaLibrary）：
 * - 选图器授权过的照片 URI 是**永久授权**的，`fileIo.openSync(uri)` 可以直接读；
 * - EXIF 走 `image.createImageSource(fd)` + `getImageProperties([...])`；
 * - **不要**用 `asset.get('latitude')` 之类：`PhotoKeys` 里根本没有经纬度（实测报 14000014）。
 */
import { image } from '@kit.ImageKit';
import { fileIo } from '@kit.CoreFileKit';
import { ExifInfo, parseExifTime, buildExifInfo } from '../core/exifParse';
import { parseExifCoord } from '../core/geo';

/**
 * `getImageProperties` 对「文件里没有这个标签」返回 null（SDK 声明 `Record<PropertyKey, string | null>`；
 * 键缺失时运行期还可能拿到 undefined），统一收敛成空串 —— 空串在纯层是"解析失败"的确定输入，
 * 不会像 null/undefined 那样在 `parseExifTime` / `parseExifCoord` 里分别走不同分支。
 */
function propOrEmpty(v: string | null | undefined): string {
  if (v === undefined || v === null) { return ''; }
  return v;
}

/**
 * 读一张照片的 EXIF。**任何失败都退化成 `{takenAt:0, lat:0, lon:0, hasGps:false}`，不抛错**：
 * 打不开（URI 失效/已删除）、不是支持的图片格式、压根没有 EXIF（截图、部分导出图）都是常态，
 * 调用方（地点索引）不该因为一张坏照片而中断整批构建。
 *
 * 资源释放：`release()` 与 `closeSync` 都在 `finally` 里，且**先 await release() 再关 fd** ——
 * SDK 里 `ImageSource.release()` 只有 Promise 形态（没有 releaseSync），不 await 就关 fd
 * 等于让释放操作踩在已关闭的 fd 上。只持有 fd 数值（不再持有 `File` 对象）是等价的：
 * `fileIo.closeSync` 接受 `number | File`。
 */
export async function readExif(uri: string): Promise<ExifInfo> {
  const empty: ExifInfo = buildExifInfo(0, 0, 0);
  let fd: number = -1;
  let src: image.ImageSource | undefined = undefined;
  try {
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    fd = file.fd;
    // SDK 注明 "If the operation fails, undefined is returned"，声明类型却没带 undefined，
    // 所以这里按运行期事实判一次，不让下面的 .getImageProperties 空引用崩掉。
    src = image.createImageSource(fd);
    if (src === undefined) { return empty; }
    const props = await src.getImageProperties([
      image.PropertyKey.DATE_TIME,
      image.PropertyKey.GPS_LATITUDE,
      image.PropertyKey.GPS_LATITUDE_REF,
      image.PropertyKey.GPS_LONGITUDE,
      image.PropertyKey.GPS_LONGITUDE_REF
    ]);
    // parseExifTime 对缺失/非法给 0；parseExifCoord 对缺失/非法给 NaN。
    // 两者归一到 ExifInfo 的规则（含 hasGps 的成对判据）都在纯层，见 buildExifInfo。
    const takenAt: number = parseExifTime(propOrEmpty(props[image.PropertyKey.DATE_TIME]));
    const lat: number = parseExifCoord(
      propOrEmpty(props[image.PropertyKey.GPS_LATITUDE]),
      propOrEmpty(props[image.PropertyKey.GPS_LATITUDE_REF]));
    const lon: number = parseExifCoord(
      propOrEmpty(props[image.PropertyKey.GPS_LONGITUDE]),
      propOrEmpty(props[image.PropertyKey.GPS_LONGITUDE_REF]));
    return buildExifInfo(takenAt, lat, lon);
  } catch (e) {
    return empty;
  } finally {
    if (src !== undefined) {
      try { await src.release(); } catch (e) { /* 释放失败不改结论 */ }
    }
    if (fd >= 0) {
      try { fileIo.closeSync(fd); } catch (e) { /* 同上 */ }
    }
  }
}
