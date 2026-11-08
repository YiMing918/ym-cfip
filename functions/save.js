// POST /save {text} → {id, url}：把访客当前清单存为快照订阅（KV: SNAP）
// 快照是定格版（可含本地测通筛选），不随聚合变化；保留 180 天；链接即凭证（内容本就是公开 IP 清单）。
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newId() {
  const a = new Uint8Array(10);
  crypto.getRandomValues(a);
  return [...a].map(x => ALPHABET[x % ALPHABET.length]).join("");
}
const LINE_OK = /^(\[[0-9a-fA-F:]+\]|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}(#.*)?$/;

export async function onRequestPost(context) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" };
  if (!context.env || !context.env.SNAP)
    return new Response(JSON.stringify({ error: "snapshot storage not configured" }), { status: 501, headers });
  const body = await context.request.json().catch(() => null);
  const text = body && typeof body.text === "string" ? body.text : "";
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  if (!lines.length || lines.length > 5000 || text.length > 300000)
    return new Response(JSON.stringify({ error: "invalid list" }), { status: 400, headers });
  if (!lines.every(l => LINE_OK.test(l)))
    return new Response(JSON.stringify({ error: "invalid line format" }), { status: 400, headers });
  // 每来源 IP 每日保存上限（防刷爆 KV 写入额度）：计数 key rl:save:<ip>:<yyyy-mm-dd>
  const ip = context.request.headers.get("cf-connecting-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = "rl:save:" + ip + ":" + day;
  const used = parseInt((await context.env.SNAP.get(rlKey)) || "0", 10) || 0;
  if (used >= 100)
    return new Response(JSON.stringify({ error: "daily save limit reached" }), { status: 429, headers });
  await context.env.SNAP.put(rlKey, String(used + 1), { expirationTtl: 2 * 24 * 3600 });
  const id = newId();
  await context.env.SNAP.put("snap:" + id, lines.join("\n") + "\n", { expirationTtl: 180 * 24 * 3600 });
  return new Response(JSON.stringify({ id, url: new URL("/s/" + id, context.request.url).href }), { headers });
}
