// GET /s/<id>：读取快照订阅内容（由 /save 存入 KV: SNAP）
export async function onRequestGet(context) {
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "profile-update-interval": "24" };
  if (!context.env || !context.env.SNAP)
    return new Response("# snapshot storage not configured\n", { status: 501, headers });
  const text = await context.env.SNAP.get("snap:" + context.params.id);
  if (!text) return new Response("# not found\n", { status: 404, headers });
  return new Response(text, { headers });
}
