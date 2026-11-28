// /probe —— 「检测地区（实测落地）」的后端接口（v1.31；v1.31.2 修分块调用）。
//
// 干什么：访客在页面点「开始测地区」时，页面把一批 IP 发到这里；本接口在
// 部署者自己的 Cloudflare 域名（zone）下，给每个 IP 临时建一条 DNS-only
// 的 A 记录（随机子域名 → 该 IP），把子域名回给页面；页面浏览器再逐个打开
// https://<子域名>/cdn-cgi/trace 读机房（colo），测完页面调 DELETE 把这批
// 记录删掉。
//
// 为什么要这么绕：浏览器直连裸 IP 时，IP 拿不出对得上号的 TLS 证书，握手
// 直接被断，trace 的内容一个字都读不到（v1.27 实测整池只读出 1 条，已撤）。
// 子域名的证书是这个域名自己的（Cloudflare 通配证书覆盖一层子域名），
// SNI 对得上，连接能建起来，trace 又带 Access-Control-Allow-Origin: *，
// 页面才读得到机房。用完即删，临时记录不留。
//
// 为什么要令牌：建/删 DNS 记录走 Cloudflare API，必须带令牌。令牌由部署
// 者在自己账号里建，权限只给「区域 → DNS → 编辑」、区域资源只限这一个
// 域名（配置步骤见 README「检测地区（实测落地）」）。令牌只存在 Pages
// 项目的环境变量里（CF_API_TOKEN，建议存为加密变量），绝不进仓库。
//
// 环境变量（缺任何一个 = 未配置，GET 回 configured:false、写操作回 501，
// 页面据此整张卡不显示，其他功能不受影响）：
//   CF_API_TOKEN   上述令牌
//   PROBE_ZONE_ID  域名的区域 ID（域名概述页右下角可查）
//   PROBE_ZONE_NAME 域名本身，如 example.com（子域名建在它下面一层）
//
// 防滥用（这是个匿名可调的写 DNS 入口，必须有闸）：
//   - 只接受同源调用：Sec-Fetch-Site 存在且不是 same-origin/same-site/none
//     时 403（浏览器跨站借访客之手刷记录这条路先堵上；curl 等不带此头的
//     客户端靠下面的量闸兜底）；
//   - 单批最多 100 个 IP；zone 内 cfp 前缀临时记录存量上限 300；
//   - 每次建记录前先清扫：cfp 前缀且创建超过 10 分钟的记录先删（页面中途
//     关掉、没调 DELETE 的孤儿记录靠它回收）。
//   - 建/删记录一律分块走批量接口（见下方 CHUNK 注释）：批量接口单次
//     操作数有上限、免费版每次调用的子请求也有上限，无上限逐个调用会
//     在几百条时把额度耗尽并拖出平台 502（v1.31.2 修的就是这个）。

const CF_API = "https://api.cloudflare.com/client/v4";
const LABEL_PREFIX = "cfp";
const MAX_BATCH = 100;        // 单批 IP 上限（与页面分批一致）
const MAX_ALIVE = 300;        // zone 内 cfp 临时记录存量上限
const STALE_MS = 10 * 60 * 1000; // 超过 10 分钟的 cfp 记录视为孤儿，清扫

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: HEADERS });

function probeCfg(env) {
  const token = env && env.CF_API_TOKEN;
  const zoneId = env && env.PROBE_ZONE_ID;
  const zoneName = env && String(env.PROBE_ZONE_NAME || "").trim().replace(/\.$/, "").toLowerCase();
  if (!token || !zoneId || !zoneName) return null;
  return { token, zoneId, zoneName };
}

// 同源闸：与 save.js 的 Origin 校验同思路，但这里连 GET 之外的写操作都收。
// Sec-Fetch-Site 是浏览器自动带的、页面改不了；curl/脚本默认不带，放行后
// 由批量与存量上限兜底（最坏也只能在本 zone 里塞 ≤300 条 cfp 临时记录，
// 且 10 分钟后被下一次调用清扫）。
function sameSiteOk(request) {
  const s = request.headers.get("Sec-Fetch-Site");
  if (!s) return true;
  return s === "same-origin" || s === "same-site" || s === "none";
}

async function cfApi(cfg, path, opts = {}) {
  const r = await fetch(CF_API + path, {
    ...opts,
    headers: { Authorization: "Bearer " + cfg.token, "Content-Type": "application/json" },
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || data.success === false) {
    const msg = data && data.errors && data.errors[0] && data.errors[0].message
      ? data.errors[0].message : "HTTP " + r.status;
    throw new Error("Cloudflare API：" + msg);
  }
  return data;
}

// 与 save.js / aggregate.py 同口径：只收全球单播 IPv4（临时记录只会指向
// 清单里的优选 IP，内网/环回/文档示例段一律不收）。
function ipv4Nums(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  if (!parts.every(p => /^[0-9]+$/.test(p) && p.length <= 3 && Number(p) <= 255))
    return null;
  return parts.map(Number);
}
function validIPv4(ip) {
  const n = ipv4Nums(ip);
  if (!n) return false;
  const [a, b] = n;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (n[2] === 0 || n[2] === 2)) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && n[2] === 100) return false;
  if (a === 203 && b === 0 && n[2] === 113) return false;
  if (a >= 224) return false;
  return true;
}

function randLabel() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  return LABEL_PREFIX + [...buf].map(x => chars[x % 36]).join("");
}

const isCfpName = (cfg, name) =>
  typeof name === "string" && name.endsWith("." + cfg.zoneName)
  && name.slice(0, -(cfg.zoneName.length + 1)).startsWith(LABEL_PREFIX);

async function listAllRecords(cfg) {
  const out = [];
  let page = 1, totalPages = 1;
  do {
    const data = await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records?type=A&per_page=100&page=${page}`);
    out.push(...(data.result || []));
    totalPages = (data.result_info && data.result_info.total_pages) || 1;
    page++;
  } while (page <= totalPages);
  return out;
}

// ── 分块调用（v1.31.2 的关键修复）──────────────────────────────
// 实测过的两个平台约束：① 批量接口单次操作数上限约 200，超了整批被拒；
// ② 免费版每次接口调用的子请求上限约 50——老版「批量失败就逐个删」在
// 几百条时会撞上这个上限，一次最多真删 ~49 条，还会把后续调用的子请求
// 额度耗尽、拖成平台 502。所以建/删一律按 50 一组走批量接口：
// 每组失败重试一次，再失败就对半拆开继续；逐个调用只允许用在最后
// ≤10 条的小块上兜底，绝不无上限逐个跑。
const CHUNK = 50;
const SINGLE_MAX = 10;

async function batchDeleteOnce(cfg, ids) {
  const data = await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records/batch`, {
    method: "POST",
    body: JSON.stringify({ deletes: ids.map(id => ({ id })) }),
  });
  return ((data.result && data.result.deletes) || []).length;
}

// 分块删，返回实际删掉的条数（尽力而为，删不掉的残留会被下一次
// POST 的清扫回收）。
async function deleteRecords(cfg, ids) {
  let deleted = 0;
  async function delChunk(chunk) {
    if (!chunk.length) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { deleted += await batchDeleteOnce(cfg, chunk); return; }
      catch (e) { /* 重试一次，仍失败就对半拆 */ }
    }
    if (chunk.length > SINGLE_MAX) {
      const mid = Math.ceil(chunk.length / 2);
      await delChunk(chunk.slice(0, mid));
      await delChunk(chunk.slice(mid));
      return;
    }
    for (const id of chunk) {
      try { await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records/${id}`, { method: "DELETE" }); deleted++; }
      catch (e) { /* 单条删失败不中断其余 */ }
    }
  }
  for (let i = 0; i < ids.length; i += CHUNK)
    await delChunk(ids.slice(i, i + CHUNK));
  return deleted;
}

async function batchCreateOnce(cfg, chunk) {
  const data = await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records/batch`, {
    method: "POST",
    body: JSON.stringify({ posts: chunk.map(w => ({ type: "A", name: w.name, content: w.ip, proxied: false, ttl: 60 })) }),
  });
  return (data.result && data.result.posts) || [];
}

// 分块建：与删除同一套路（50 一组、失败重试一次→对半拆、逐个兜底
// 只用在 ≤10 条的小块）。建成的记录收进 got（name -> record）。
async function createRecords(cfg, want, got) {
  async function createChunk(chunk) {
    if (!chunk.length) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const recs = await batchCreateOnce(cfg, chunk);
        for (const rec of recs) got.set(rec.name, rec);
        break;
      } catch (e) { /* 重试一次，仍失败走下面拆分/逐个 */ }
    }
    const missing = chunk.filter(w => !got.has(w.name));
    if (!missing.length) return;
    if (missing.length > SINGLE_MAX) {
      const mid = Math.ceil(missing.length / 2);
      await createChunk(missing.slice(0, mid));
      await createChunk(missing.slice(mid));
      return;
    }
    for (const w of missing) {
      try {
        const data = await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records`, {
          method: "POST",
          body: JSON.stringify({ type: "A", name: w.name, content: w.ip, proxied: false, ttl: 60 }),
        });
        if (data.result) got.set(w.name, data.result);
      } catch (e) { /* 单条失败不中断其余，最后按缺失处理 */ }
    }
  }
  for (let i = 0; i < want.length; i += CHUNK)
    await createChunk(want.slice(i, i + CHUNK));
}

export async function onRequestGet(context) {
  return json({ configured: !!probeCfg(context.env) });
}

export async function onRequestPost(context) {
  if (!sameSiteOk(context.request))
    return json({ error: "forbidden（只接受本站页面调用）" }, 403);
  const cfg = probeCfg(context.env);
  if (!cfg)
    return json({ error: "probe not configured（测地区未配置：本站未设置 CF_API_TOKEN / PROBE_ZONE_ID / PROBE_ZONE_NAME）" }, 501);
  const body = await context.request.json().catch(() => null);
  if (!body || !Array.isArray(body.ips))
    return json({ error: "invalid body（需要 {ips:[...]}）" }, 400);
  const ips = [...new Set(body.ips.map(x => String(x || "").trim()))];
  if (!ips.length || ips.length > MAX_BATCH)
    return json({ error: `invalid ips（每批 1–${MAX_BATCH} 个 IP）` }, 400);
  if (!ips.every(validIPv4))
    return json({ error: "invalid ips（含有不合法的 IPv4 地址）" }, 400);
  try {
    // 先清扫孤儿 + 算存量：cfp 前缀、创建超 10 分钟的先删
    const all = await listAllRecords(cfg);
    const mine = all.filter(r => r.type === "A" && isCfpName(cfg, r.name));
    const now = Date.now();
    const stale = mine.filter(r => now - Date.parse(r.created_on || 0) > STALE_MS);
    if (stale.length) await deleteRecords(cfg, stale.map(r => r.id));
    const alive = mine.length - stale.length;
    if (alive + ips.length > MAX_ALIVE)
      return json({ error: `too many temp records（临时记录存量 ${alive}，加上本批将超过上限 ${MAX_ALIVE}，请稍后再试）` }, 429);
    // 建记录：分块批量（50 一组），拆法见 createRecords
    const want = ips.map(ip => ({ ip, name: randLabel() + "." + cfg.zoneName }));
    const got = new Map(); // name -> record
    await createRecords(cfg, want, got);
    // 仍缺记录/id 时才回查列表按 name 匹配（批量响应偶有不回 id 的情况）。
    // 回查失败绝不许把整个请求拖成 502：已建好的 hosts 照常返回，缺 id
    // 的条目页面照样能测（只是本轮删不掉它），残留交给下一次 POST 清扫。
    const missing = want.filter(w => !got.has(w.name) || !got.get(w.name).id);
    if (missing.length) {
      try {
        const again = await listAllRecords(cfg);
        for (const rec of again) if (isCfpName(cfg, rec.name)) got.set(rec.name, rec);
      } catch (e) { /* 回查失败不影响已建成的结果 */ }
    }
    const hosts = want.filter(w => got.has(w.name))
      .map(w => ({ ip: w.ip, host: w.name, id: got.get(w.name).id || null }));
    if (!hosts.length)
      return json({ error: "create failed（临时记录一条都没建成功）" }, 502);
    return json({ hosts });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
}

export async function onRequestDelete(context) {
  if (!sameSiteOk(context.request))
    return json({ error: "forbidden（只接受本站页面调用）" }, 403);
  const cfg = probeCfg(context.env);
  if (!cfg)
    return json({ error: "probe not configured（测地区未配置）" }, 501);
  const body = await context.request.json().catch(() => null);
  if (!body || !Array.isArray(body.ids))
    return json({ error: "invalid body（需要 {ids:[...]}）" }, 400);
  const ids = [...new Set(body.ids.filter(x => typeof x === "string" && x.length > 0 && x.length <= 64))];
  if (ids.length > 400)
    return json({ error: "invalid ids（一次最多删 400 条）" }, 400);
  try {
    const deleted = await deleteRecords(cfg, ids);
    return json({ deleted });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
}
