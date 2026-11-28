// ym-cfip /probe 接口定向测试（node tests/probe-fn.mjs）
// stub 全局 fetch 假扮 Cloudflare API（内存里的假 zone），覆盖：
//   ① 未配置时 GET 回 configured:false、POST/DELETE 回 501；
//   ② 配置后 POST 建记录：请求体 name 形如 cfp[a-z0-9]{10}.<zone>、
//      proxied:false、ttl:60、content 对得上，返回 hosts 带 id；
//   ③ 101 个 IP 回 400、非法/内网 IP 回 400、非数组回 400；
//   ④ 清扫：创建超 10 分钟的 cfp 记录被删，新鲜 cfp 与非 cfp 记录保留；
//   ⑤ 存量上限：cfp 存量 + 本批 > 300 回 429；
//   ⑥ DELETE 按 ids 删除并回 deleted 数；
//   ⑦ Sec-Fetch-Site: cross-site 的 POST 回 403。

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

// ── 假 Cloudflare API ─────────────────────────────────────────────
let records = [];
let nextId = 1;
const resetZone = () => { records = []; nextId = 1; };
const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://api.cloudflare.com') throw new Error('unexpected fetch: ' + url);
  const path = u.pathname.replace('/client/v4', '');
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (method === 'GET' && /^\/zones\/[^/]+\/dns_records$/.test(path)) {
    return j({ success: true, result: records, result_info: { page: 1, per_page: 100, total_pages: 1, count: records.length, total_count: records.length } });
  }
  if (method === 'POST' && /^\/zones\/[^/]+\/dns_records\/batch$/.test(path)) {
    const out = { posts: [], deletes: [] };
    for (const p of body.posts || []) {
      const rec = { id: 'rec' + String(nextId++).padStart(4, '0'), created_on: new Date().toISOString(), ...p };
      records.push(rec); out.posts.push(rec);
    }
    for (const d of body.deletes || []) {
      const i = records.findIndex(r => r.id === d.id);
      if (i >= 0) { out.deletes.push(records[i]); records.splice(i, 1); }
    }
    return j({ success: true, result: out });
  }
  if (method === 'POST' && /^\/zones\/[^/]+\/dns_records$/.test(path)) {
    const rec = { id: 'rec' + String(nextId++).padStart(4, '0'), created_on: new Date().toISOString(), ...body };
    records.push(rec);
    return j({ success: true, result: rec });
  }
  if (method === 'DELETE' && /^\/zones\/[^/]+\/dns_records\/[^/]+$/.test(path)) {
    const id = path.split('/').pop();
    const i = records.findIndex(r => r.id === id);
    if (i >= 0) records.splice(i, 1);
    return j({ success: true, result: { id } });
  }
  return j({ success: false, errors: [{ message: 'not found in fake api' }] }, 404);
};

const { onRequestGet, onRequestPost, onRequestDelete } = await import('../functions/probe.js');

const CFG_ENV = { CF_API_TOKEN: 'test-token', PROBE_ZONE_ID: 'zone123', PROBE_ZONE_NAME: 'example.com' };
const ctx = (env, method, body, headers = {}) => ({
  env,
  request: new Request('http://local/probe', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
});

// ① 未配置
{
  const g = await onRequestGet(ctx({}, 'GET'));
  const gj = await g.json();
  chk('未配置 GET 回 configured:false', g.status === 200 && gj.configured === false, JSON.stringify(gj));
  const p = await onRequestPost(ctx({}, 'POST', { ips: ['1.2.3.4'] }));
  chk('未配置 POST 回 501', p.status === 501, 'status=' + p.status);
  const d = await onRequestDelete(ctx({}, 'DELETE', { ids: ['x'] }));
  chk('未配置 DELETE 回 501', d.status === 501, 'status=' + d.status);
  const partial = await onRequestGet(ctx({ CF_API_TOKEN: 't' }, 'GET'));
  chk('只配一半也算未配置', (await partial.json()).configured === false);
}

// ② 配置后建记录
{
  resetZone();
  const r = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: ['1.2.3.4', '5.6.7.8', '1.2.3.4'] }));
  const data = await r.json();
  chk('POST 回 200 且去重后 2 条 hosts', r.status === 200 && data.hosts && data.hosts.length === 2, JSON.stringify(data).slice(0, 200));
  const nameRe = /^cfp[a-z0-9]{10}\.example\.com$/;
  chk('host 名形如 cfp[10位].zone', data.hosts.every(h => nameRe.test(h.host)), JSON.stringify(data.hosts));
  chk('hosts 带 id 且与 ip 对应', data.hosts.every(h => h.id) &&
    data.hosts.find(h => h.ip === '1.2.3.4') && data.hosts.find(h => h.ip === '5.6.7.8'));
  chk('假 zone 里记录 proxied:false / ttl:60 / content 对得上',
    records.length === 2 && records.every(rec => rec.proxied === false && rec.ttl === 60 && rec.type === 'A') &&
    records.some(rec => rec.content === '1.2.3.4') && records.some(rec => rec.content === '5.6.7.8'),
    JSON.stringify(records));
}

// ③ 校验
{
  const many = Array.from({ length: 101 }, (_, i) => `1.2.3.${i + 1}`.replace('1.2.3.256', '1.2.4.1'));
  const r101 = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: many }));
  chk('101 个 IP 回 400', r101.status === 400, 'status=' + r101.status);
  const rBad = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: ['999.1.1.1'] }));
  chk('非法 IP 回 400', rBad.status === 400, 'status=' + rBad.status);
  const rPriv = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: ['10.0.0.1'] }));
  chk('内网 IP 回 400', rPriv.status === 400, 'status=' + rPriv.status);
  const rArr = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: 'not-an-array' }));
  chk('ips 非数组回 400', rArr.status === 400, 'status=' + rArr.status);
  const rEmpty = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: [] }));
  chk('空数组回 400', rEmpty.status === 400, 'status=' + rEmpty.status);
}

// ④ 清扫
{
  resetZone();
  const old = Date.now() - 11 * 60 * 1000, fresh = Date.now() - 60 * 1000;
  records.push(
    { id: 'stale1', type: 'A', name: 'cfpstale0000.example.com', content: '9.9.9.9', proxied: false, ttl: 60, created_on: new Date(old).toISOString() },
    { id: 'fresh1', type: 'A', name: 'cfpfresh000.example.com', content: '9.9.9.8', proxied: false, ttl: 60, created_on: new Date(fresh).toISOString() },
    { id: 'keep1', type: 'A', name: 'www.example.com', content: '9.9.9.7', proxied: false, ttl: 60, created_on: new Date(old).toISOString() },
  );
  const r = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: ['8.8.8.8'] }));
  chk('清扫轮 POST 成功', r.status === 200, 'status=' + r.status);
  chk('过期 cfp 被清扫', !records.some(x => x.id === 'stale1'), JSON.stringify(records.map(x => x.id)));
  chk('新鲜 cfp 保留', records.some(x => x.id === 'fresh1'));
  chk('非 cfp 记录保留', records.some(x => x.id === 'keep1'));
}

// ⑤ 存量上限
{
  resetZone();
  const fresh = new Date().toISOString();
  for (let i = 0; i < 250; i++)
    records.push({ id: 'bulk' + i, type: 'A', name: `cfpbulk${String(i).padStart(4, '0')}x.example.com`, content: '9.9.9.9', proxied: false, ttl: 60, created_on: fresh });
  const sixty = Array.from({ length: 60 }, (_, i) => `2.2.2.${i + 1}`);
  const r = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: sixty }));
  chk('存量 250 + 本批 60 > 300 回 429', r.status === 429, 'status=' + r.status);
}

// ⑥ DELETE（自建自删，不依赖前面用例留下的记录）
{
  resetZone();
  const c = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: ['3.3.3.3', '4.4.4.4'] }));
  const ids = (await c.json()).hosts.map(h => h.id);
  const r = await onRequestDelete(ctx(CFG_ENV, 'DELETE', { ids }));
  const data = await r.json();
  chk('DELETE 回 deleted 数对', r.status === 200 && data.deleted === ids.length, JSON.stringify(data));
  chk('DELETE 后假 zone 里记录清空', records.length === 0, JSON.stringify(records.map(x => x.id)));
}

// ⑦ 同源闸
{
  const r = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: ['1.2.3.4'] }, { 'Sec-Fetch-Site': 'cross-site' }));
  chk('cross-site 的 POST 回 403', r.status === 403, 'status=' + r.status);
  const r2 = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: ['1.2.3.4'] }, { 'Sec-Fetch-Site': 'same-origin' }));
  chk('same-origin 的 POST 放行', r2.status === 200, 'status=' + r2.status);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
