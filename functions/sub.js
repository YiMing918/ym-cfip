// YM 优选 IP · 订阅端点（Cloudflare Pages Functions）
// 参数：
//   regions=JP,US      地区（缺省 JP,US）
//   n=20               每地区最多 N 个
//   rn=JP.10,US.5      单独定每地区个数（覆盖 n）
//   ms=200             最大延迟（源标注）  mbps=10  最低速度（源标注）
//   carrier=移动       运营商（带标注的只留对应；无标注源保留）
//   ports=tls          端口：all（缺省）| 443 | tls(443/8443/2053/2083/2087/2096)
//   mode=random        随机抽取（缺省质量优先源序）
//   stack=6            IPv6 池（此时 regions/ms/mbps 不适用，可用 n/carrier）
//   ui=12              建议客户端更新间隔（小时，写响应头）
// 每次请求基于最新聚合数据现算，链接内容实时更新。
const LINE_RE = /^(\S+?)#([A-Z]{2})\s*(?:\[(.*)\])?$/;
const TLS_PORTS = new Set(["443", "8443", "2053", "2083", "2087", "2096"]);

function parseLine(line) {
  const m = line.match(LINE_RE);
  if (!m) return null;
  const tag = m[3] || "";
  const ms = tag.match(/([\d.]+)\s*ms/i);
  const mbps = tag.match(/([\d.]+)\s*Mbps/i);
  const port = (m[1].match(/:(\d+)$/) || [])[1] || "";
  const carrier = (tag.match(/·(移动|电信|联通)/) || [])[1] || "";
  return {
    line, region: m[2], port, carrier,
    srcMs: ms ? parseFloat(ms[1]) : null,
    srcMbps: mbps ? parseFloat(mbps[1]) : null,
  };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadPool(context, origin, file) {
  const dataUrl = new URL(file, origin);
  const resp = context.env && context.env.ASSETS
    ? await context.env.ASSETS.fetch(dataUrl)
    : await fetch(dataUrl);
  const txt = await resp.text();
  return txt.split("\n").map(s => s.trim()).filter(Boolean);
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams;
  const ui = parseInt(q.get("ui") || "", 10);
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" };
  if (!isNaN(ui) && ui > 0) headers["profile-update-interval"] = String(ui);

  const nAll = parseInt(q.get("n") || "", 10);
  const carrier = q.get("carrier") || "";
  const mode = q.get("mode") || "";

  try {
    if (q.get("stack") === "6") {
      let pool = await loadPool(context, url.origin, "/data/all6.txt");
      if (carrier) pool = pool.filter(l => !l.includes("·") || l.includes("·" + carrier));
      if (mode === "random") pool = shuffle(pool);
      const out = isNaN(nAll) ? pool : pool.slice(0, nAll);
      return new Response(out.join("\n") + "\n", { headers });
    }

    const regions = new Set(
      (q.get("regions") || "JP,US").split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
    );
    const rn = {};
    (q.get("rn") || "").split(",").forEach(part => {
      const [cc, v] = part.split(".");
      if (cc && v) rn[cc.trim().toUpperCase()] = parseInt(v, 10);
    });
    const maxMs = parseFloat(q.get("ms") || "");
    const minMbps = parseFloat(q.get("mbps") || "");
    const ports = q.get("ports") || "all";

    const pool = await loadPool(context, url.origin, "/data/all.txt");
    const byRegion = {};
    for (const raw of pool) {
      const p = parseLine(raw);
      if (!p || !regions.has(p.region)) continue;
      if (!isNaN(maxMs) && (p.srcMs === null || p.srcMs > maxMs)) continue;
      if (!isNaN(minMbps) && (p.srcMbps === null || p.srcMbps < minMbps)) continue;
      if (carrier && p.carrier && p.carrier !== carrier) continue;
      if (ports === "443" && p.port !== "443") continue;
      if (ports === "tls" && !TLS_PORTS.has(p.port)) continue;
      (byRegion[p.region] = byRegion[p.region] || []).push(p.line);
    }
    const out = [];
    for (const cc of Object.keys(byRegion).sort()) {
      let lines = byRegion[cc];
      if (mode === "random") lines = shuffle(lines);
      const limit = rn[cc] !== undefined ? rn[cc] : (isNaN(nAll) ? Infinity : nAll);
      out.push(...lines.slice(0, limit));
    }
    return new Response(out.join("\n") + "\n", { headers });
  } catch (e) {
    return new Response("# data unavailable\n", { status: 502, headers });
  }
}
