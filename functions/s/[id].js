// GET /s/<id>：读取快照订阅内容（由 /save 存入 KV: SNAP）
// GET /s/<短码>.txt：参数预设订阅（v1.24）——实测部署环境中本动态段路由
// 会先于 s/[id].txt.js 命中 .txt 请求（整个段连 .txt 一起捕获），故 id 以
// .txt 结尾时转交 _preset.js 处理；快照 id 是字母数字、无点号，不会误入。
import { handlePresetGet } from "../_preset.js";

export async function onRequestGet(context) {
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "profile-update-interval": "24" };
  const rawId = String(context.params.id || "");
  if (rawId.endsWith(".txt"))
    return handlePresetGet(context, rawId.slice(0, -4));
  if (!context.env || !context.env.SNAP)
    return new Response("# snapshot storage not configured\n", { status: 501, headers });
  // id 校验（2026-11-19 审计 L7）：/save 生成的 id 是 10 位字母数字
  // （见 save.js contentId），这里放宽到 1–64 位同字符集收口，超长或
  // 含其它字符的 id 直接 400，不拿去拼 KV 键乱查
  const id = rawId;
  if (!/^[A-Za-z0-9]{1,64}$/.test(id))
    return new Response("# invalid id\n", { status: 400, headers });
  const text = await context.env.SNAP.get("snap:" + id);
  if (!text) return new Response("# not found\n", { status: 404, headers });
  return new Response(text, { headers });
}
