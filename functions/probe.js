// /probe —— 「检测地区（实测落地）」的后端接口（v1.31；v1.31.2 修分块调用；
// v1.31.3 修批量接口「部分成功」——按集合差逐轮追完，见下方注释）。
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
//     在几百条时把额度耗尽并拖出平台 502（v1.31.2 修的就是这个）；
//   - 批量接口还会「部分成功」：整批回 200，但 result 里只含真正成功
//     的那部分（v1.31.3 主会话线上实测：建 80 个只回 74–78 个、删 78
//     个只真删 19–38 个）。所以每次批量调用后必须算「请求集合 − 结果
//     集合 = 失败集合」，只拿失败集合继续追（批量减半→逐个），追不完
//     的如实报回页面（POST 回 failed、DELETE 回 remaining）。

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

// ── 分块调用 + 按集合差追完（v1.31.2 分块；v1.31.3 集合差）──────
// 实测过的三个平台约束：① 批量接口单次操作数上限约 200，超了整批
// 被拒；② 免费版每次接口调用的子请求上限约 50——无上限逐个跑会撞上
// 它（一次最多真删 ~49 条，还会耗尽后续调用的额度拖成平台 502）；
// ③ 批量接口会「部分成功」：整批回 200，但 result.posts/result.deletes
// 里只含真正成功的那部分，剩下的既不报错也不出现（v1.31.2 上线后线
// 上实测：建 80 个只回 74–78 个、删 78 个只真删 19–38 个；单个建同
// 一个 IP 又是成功的——是批量路径零星丢，不是 IP 被拒）。
// 所以 v1.31.3 的口径是：建/删一律 50 一组走批量接口，每次批量调用
// 后算集合差（请求了但结果里没有的 = 失败集合），只追失败集合——
// 先对半再批量一次，还剩的逐个处理（每组逐个上限 15 个）；全程用同
// 一批 name/id 重试，绝不重新随机（否则会建出回执之外的记录）；追
// 不完的如实上报（POST 的 failed、DELETE 的 remaining），不虚报。
// 子请求预算（每次 onRequest 调用内）：POST = 列表分页 ≤4 + 清扫删
// ≤3 组调用 + 建每组 ≤3 次批量 + ≤15 逐个 + 补 id 回查 ≤2，合计 <45；
// DELETE 按页面实际用法（每批 ≤100 个 id = 2 组）合计 <30。
const CHUNK = 50;
const SINGLE_MAX = 15;

// 一次批量删，返回真正删掉的 id 列表（result.deletes 里的记录对象）。
async function batchDeleteOnce(cfg, ids) {
  const data = await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records/batch`, {
    method: "POST",
    body: JSON.stringify({ deletes: ids.map(id => ({ id })) }),
  });
  return ((data.result && data.result.deletes) || []).map(r => r && r.id).filter(Boolean);
}

// 分块删 + 按集合差追完。返回 { deleted, remaining }：remaining 是
// 追到最后仍没删掉的 id（正常应为空；非空时残留会被下一次 POST 的
// 清扫回收，DELETE 的调用方也会从响应里如实看到）。
async function deleteRecords(cfg, ids) {
  let deleted = 0;
  const remaining = [];
  // 一次批量尝试：删掉的计数，没删掉的子集原样返回待追。整批抛错
  // （超 200 被拒/网络错）时整组都算没删掉，交给下一轮。
  async function batchOut(chunk) {
    if (!chunk.length) return [];
    try {
      const gone = new Set(await batchDeleteOnce(cfg, chunk));
      const left = chunk.filter(id => !gone.has(id));
      deleted += chunk.length - left.length;
      return left;
    } catch (e) { return chunk.slice(); }
  }
  for (let i = 0; i < ids.length; i += CHUNK) {
    let pending = await batchOut(ids.slice(i, i + CHUNK)); // 第 1 轮：整组批量
    if (pending.length) {                                  // 第 2 轮：失败集合对半批量
      const mid = Math.ceil(pending.length / 2);
      const a = await batchOut(pending.slice(0, mid));
      const b = await batchOut(pending.slice(mid));
      pending = a.concat(b);
    }
    let singles = 0;                                       // 第 3 轮：逐个（≤15）
    for (const id of pending) {
      if (singles >= SINGLE_MAX) { remaining.push(id); continue; }
      singles++;
      try { await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records/${id}`, { method: "DELETE" }); deleted++; }
      catch (e) { remaining.push(id); }
    }
  }
  return { deleted, remaining };
}

async function batchCreateOnce(cfg, chunk) {
  const data = await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records/batch`, {
    method: "POST",
    body: JSON.stringify({ posts: chunk.map(w => ({ type: "A", name: w.name, content: w.ip, proxied: false, ttl: 60 })) }),
  });
  return (data.result && data.result.posts) || [];
}

// 分块建 + 按集合差追完：与删除同一套路。建成的收进 got
// （name -> record）；最终没建成的由调用方按「want 里不在 got 的」
// 算出 IP 报回页面（failed）。重试全程用 want 里同一批 name。
async function createRecords(cfg, want, got) {
  // 一次批量尝试：建成的收进 got，没建成的子集原样返回待追。
  async function batchInto(chunk) {
    if (!chunk.length) return [];
    try {
      const recs = await batchCreateOnce(cfg, chunk);
      const done = new Set();
      for (const rec of recs) { got.set(rec.name, rec); done.add(rec.name); }
      return chunk.filter(w => !done.has(w.name));
    } catch (e) { return chunk.slice(); }
  }
  for (let i = 0; i < want.length; i += CHUNK) {
    let pending = await batchInto(want.slice(i, i + CHUNK)); // 第 1 轮：整组批量
    if (pending.length) {                                    // 第 2 轮：失败集合对半批量
      const mid = Math.ceil(pending.length / 2);
      const a = await batchInto(pending.slice(0, mid));
      const b = await batchInto(pending.slice(mid));
      pending = a.concat(b);
    }
    let singles = 0;                                         // 第 3 轮：逐个（≤15）
    for (const w of pending) {
      if (singles >= SINGLE_MAX) break; // 剩下的留在 got 之外，计入 failed
      singles++;
      try {
        const data = await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records`, {
          method: "POST",
          body: JSON.stringify({ type: "A", name: w.name, content: w.ip, proxied: false, ttl: 60 }),
        });
        if (data.result) got.set(w.name, data.result);
      } catch (e) { /* 单条失败不中断其余，最后按缺失计入 failed */ }
    }
  }
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
    // 先清扫孤儿 + 算存量：cfp 前缀、创建超 10 分钟的先删；存量按
    // 「实际删掉的数」扣（集合差追完后仍没删掉的残留还占着存量）。
    const all = await listAllRecords(cfg);
    const mine = all.filter(r => r.type === "A" && isCfpName(cfg, r.name));
    const now = Date.now();
    const stale = mine.filter(r => now - Date.parse(r.created_on || 0) > STALE_MS);
    let sweepDeleted = 0;
    if (stale.length) sweepDeleted = (await deleteRecords(cfg, stale.map(r => r.id))).deleted;
    const alive = mine.length - sweepDeleted;
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
    // 追到最后仍没建成的 IP 如实报回页面（failed）：页面据此把它们记
    // 为「未建成」，不混进「未识别」里误导访客。
    const failed = want.filter(w => !got.has(w.name)).map(w => w.ip);
    if (!hosts.length)
      return json({ error: "create failed（临时记录一条都没建成功）", failed }, 502);
    return json({ hosts, failed });
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
    const { deleted, remaining } = await deleteRecords(cfg, ids);
    return json({ deleted, remaining });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
}
