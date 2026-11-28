// 参数预设短链的读取逻辑（v1.24）：/s/<短码>.txt
// 预设由 /save 的 mode=preset 存入 KV: SNAP（键 preset:<短码>，只存一组
// 订阅参数、永不过期）；这里读出参数后转调 _sub_core.handleSub 现算，
// 与 /sub.txt 同参数输出逐行一致。
// v1.33 起同一路由还承载测地区结果短链：短码形如 'm' + 9 位十六进制
// （'m' 不是十六进制字符，与 preset 的 10 位纯十六进制短码零碰撞），
// 按码形转交 _locmap.js 现算（键 locmap:<短码>，30 天过期）。
// 本文件是下划线模块（不占路由），供两个入口共用：
//   - functions/s/[id].txt.js（专职路由）
//   - functions/s/[id].js 里对 .txt 后缀的分支——实测部署环境中动态段
//     路由 [id].js 会先于 [id].txt.js 命中（整个段连 .txt 一起捕获），
//     故快照路由收到 .txt 结尾的 id 时转交本逻辑，两个入口行为一致。
import { handleSub } from "./_sub_core.js";
import { handleLocmapGet, LOCMAP_CODE_RE } from "./_locmap.js";

export async function handlePresetGet(context, code) {
  // 测地区结果短链（v1.33）：码形对上就转交，置于 preset 校验之前
  if (LOCMAP_CODE_RE.test(code || "")) return handleLocmapGet(context, code);
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" };
  if (!context.env || !context.env.SNAP)
    return new Response("# preset storage not configured\n", { status: 501, headers });
  // 短码是参数集 SHA-256 前 10 位十六进制（见 save.js presetCode）
  if (!/^[a-f0-9]{10}$/.test(code || ""))
    return new Response("# invalid id\n", { status: 400, headers });
  const raw = await context.env.SNAP.get("preset:" + code);
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
