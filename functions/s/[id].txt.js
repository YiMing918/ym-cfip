// GET /s/<短码>.txt：参数预设订阅（v1.24），逻辑在 ../_preset.js
// 与 /s/<id>（内容快照）区别：这里存的只是一组订阅参数，内容每次拉取时
// 按最新聚合数据现算，链接永不过期、池子更新自动跟上。链接以 .txt 结尾、
// 无问号参数，和别家优选源的 TXT 直链同形。
// 注：部署环境中动态段路由 [id].js 可能先于本文件命中 .txt 请求，
// [id].js 对 .txt 结尾的 id 同样转交 _preset.js，两个入口行为一致。
import { handlePresetGet } from "../_preset.js";

export async function onRequestGet(context) {
  return handlePresetGet(context, String(context.params.id || ""));
}
