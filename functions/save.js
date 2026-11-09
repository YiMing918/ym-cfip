// POST /save {text} → {id, url}：把访客当前清单存为快照订阅（KV: SNAP）
// 快照是定格版（可含本地测通筛选），不随聚合变化；保留 180 天；链接即凭证（内容本就是公开 IP 清单）。
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newId() {
  const a = new Uint8Array(10);
  crypto.getRandomValues(a);
  return [...a].map(x => ALPHABET[x % ALPHABET.length]).join("");
}
// 与聚合脚本 aggregate.py 的 valid_ipv4 / valid_port 同口径校验：原单条正则只查
// 位数，999.999.999.999、端口 0 / 99999 这类非法值也能通过，现逐段判范围。
function validIPv4(ip) {
  const parts = ip.split(".");
  return parts.length === 4 && parts.every(p =>
    /^[0-9]+$/.test(p) && p.length <= 3 && Number(p) <= 255);
}
function validPort(port) {
  return /^[0-9]+$/.test(port) && port.length <= 5
    && Number(port) > 0 && Number(port) <= 65535;
}
// 与 aggregate.py 各解析路径同口径：环回/内网地址（PRIVATE_RE）不进快照
const PRIVATE_RE = /^(127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const LINE_RE = /^(\[[0-9a-fA-F:]+\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d+)(#.*)?$/;
function lineOk(l) {
  const m = l.match(LINE_RE);
  if (!m) return false;
  if (m[2] !== undefined && (!validIPv4(m[2]) || PRIVATE_RE.test(m[2]))) return false;
  return validPort(m[3]);
}

export async function onRequestPost(context) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" };
  if (!context.env || !context.env.SNAP)
    return new Response(JSON.stringify({ error: "snapshot storage not configured" }), { status: 501, headers });
  const body = await context.request.json().catch(() => null);
  const text = body && typeof body.text === "string" ? body.text : "";
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  if (!lines.length || lines.length > 5000 || text.length > 300000)
    return new Response(JSON.stringify({ error: "invalid list" }), { status: 400, headers });
  if (!lines.every(l => lineOk(l)))
    return new Response(JSON.stringify({ error: "invalid line format" }), { status: 400, headers });
  // 每来源 IP 每日保存上限（防刷爆 KV 写入额度）：计数 key rl:save:<ip>:<yyyy-mm-dd>
  const ip = context.request.headers.get("cf-connecting-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = "rl:save:" + ip + ":" + day;
  const used = parseInt((await context.env.SNAP.get(rlKey)) || "0", 10) || 0;
  if (used >= 100)
    return new Response(JSON.stringify({ error: "daily save limit reached" }), { status: 429, headers });
  const id = newId();
  await context.env.SNAP.put("snap:" + id, lines.join("\n") + "\n", { expirationTtl: 180 * 24 * 3600 });
  await context.env.SNAP.put(rlKey, String(used + 1), { expirationTtl: 2 * 24 * 3600 });
  return new Response(JSON.stringify({ id, url: new URL("/s/" + id, context.request.url).href }), { headers });
}
