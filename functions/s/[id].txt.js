// GET /s/<短码>.txt：参数预设订阅（v1.24，由 /save 的 mode=preset 存入 KV: SNAP）
// 与 /s/<id>（内容快照）区别：这里存的只是一组订阅参数（preset:<短码>），
// 内容在每次拉取时按这组参数、用最新聚合数据现算（转调 _sub_core.handleSub，
// 与 /sub.txt 同参数输出逐行一致），所以链接永不过期、池子更新自动跟上。
// 链接以 .txt 结尾、无问号参数，和别家优选源的 TXT 直链同形。
import { handleSub } from "../_sub_core.js";

export async function onRequestGet(context) {
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" };
  if (!context.env || !context.env.SNAP)
    return new Response("# preset storage not configured\n", { status: 501, headers });
  // 短码是参数集 SHA-256 前 10 位十六进制（见 save.js presetCode）
  const id = String(context.params.id || "");
  if (!/^[a-f0-9]{10}$/.test(id))
    return new Response("# invalid id\n", { status: 400, headers });
  const raw = await context.env.SNAP.get("preset:" + id);
  if (!raw)
    return new Response("# preset not found（预设不存在：链接可能抄错，或这套选项还没在页面上生成过）\n", { status: 404, headers });
  let params = null;
  try { params = JSON.parse(raw); } catch (e) { params = null; }
  if (!params || typeof params !== "object" || Array.isArray(params))
    return new Response("# preset corrupted\n", { status: 500, headers });
  const qs = new URLSearchParams(params).toString();
  const req = new Request(new URL("/sub.txt" + (qs ? "?" + qs : ""), context.request.url));
  return handleSub({ request: req, env: context.env });
}
