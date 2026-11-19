// GET /s/<id>：读取快照订阅内容（由 /save 存入 KV: SNAP）
export async function onRequestGet(context) {
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "profile-update-interval": "24" };
  if (!context.env || !context.env.SNAP)
    return new Response("# snapshot storage not configured\n", { status: 501, headers });
  // id 校验（2026-11-19 审计 L7）：/save 生成的 id 是 10 位字母数字
  // （见 save.js contentId），这里放宽到 1–64 位同字符集收口，超长或
  // 含其它字符的 id 直接 400，不拿去拼 KV 键乱查
  const id = String(context.params.id || "");
  if (!/^[A-Za-z0-9]{1,64}$/.test(id))
    return new Response("# invalid id\n", { status: 400, headers });
  const text = await context.env.SNAP.get("snap:" + id);
  if (!text) return new Response("# not found\n", { status: 404, headers });
  return new Response(text, { headers });
}
