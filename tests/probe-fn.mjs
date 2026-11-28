// ym-cfip /probe 接口定向测试（node tests/probe-fn.mjs）
// stub 全局 fetch 假扮 Cloudflare API（内存里的假 zone），覆盖：
//   ① 未配置时 GET 回 configured:false、POST/DELETE 回 501；
//   ② 配置后 POST 建记录：请求体 name 形如 cfp[a-z0-9]{10}.<zone>、
//      proxied:false、ttl:60、content 对得上，返回 hosts 带 id；
//   ③ 101 个 IP 回 400、非法/内网 IP 回 400、非数组回 400；
//   ④ 清扫：创建超 10 分钟的 cfp 记录被删，新鲜 cfp 与非 cfp 记录保留；
//   ⑤ 存量上限：cfp 存量 + 本批 > 300 回 429；
//   ⑥ DELETE 按 ids 删除并回 deleted 数；
//   ⑦ Sec-Fetch-Site: cross-site 的 POST 回 403；
//   ⑧ 分块删除（v1.31.2）：删 240 个 id 能全删完——stub 模拟两个真实
//      平台约束：批量接口单次操作 >200 整批拒绝、逐个调用超过 50 次
//      后失败；老版「一次全删 + 逐个兜底」在这两个约束下必挂；
//   ⑨ 分块建记录：POST 100 个 IP 全成功（逐个建会撞 50 次上限）；
//   ⑩ 批量响应不回 id 时靠回查列表补 id；回查失败也不许拖成 502，
//      已建好的 hosts（id 为 null）照常返回。

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

// ── 假 Cloudflare API ─────────────────────────────────────────────
// 模拟两个真实平台约束（主会话实测）：批量接口单次操作数 >200 整批
// 拒绝；逐个（非批量）调用累计超过 50 次后失败（子请求上限）。
let records = [];
let nextId = 1;
let individualCalls = 0;   // 逐个建/删的累计次数（每次 onRequest 调用前不清零，场景间靠 resetZone 清）
let listCalls = 0;
let dropBatchIds = false;      // 批量建的响应不回 id（记录本身有 id，靠回查补）
let failListAfterFirst = false; // 第一次之后的列表查询全失败（模拟回查挂掉）
const resetZone = () => {
  records = []; nextId = 1; individualCalls = 0; listCalls = 0;
  dropBatchIds = false; failListAfterFirst = false;
};
const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const err = (message, status = 500) => j({ success: false, errors: [{ message }] }, status);

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://api.cloudflare.com') throw new Error('unexpected fetch: ' + url);
  const path = u.pathname.replace('/client/v4', '');
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (method === 'GET' && /^\/zones\/[^/]+\/dns_records$/.test(path)) {
    listCalls++;
    if (failListAfterFirst && listCalls > 1) return err('list failed (stub)');
    return j({ success: true, result: records, result_info: { page: 1, per_page: 100, total_pages: 1, count: records.length, total_count: records.length } });
  }
  if (method === 'POST' && /^\/zones\/[^/]+\/dns_records\/batch$/.test(path)) {
    const nOps = (body.posts || []).length + (body.deletes || []).length;
    if (nOps > 200) return err('batch too large: max 200 operations', 400);
    const out = { posts: [], deletes: [] };
    for (const p of body.posts || []) {
      const rec = { id: 'rec' + String(nextId++).padStart(4, '0'), created_on: new Date().toISOString(), ...p };
      records.push(rec);
      out.posts.push(dropBatchIds ? (({ id, ...rest }) => rest)(rec) : rec);
    }
    for (const d of body.deletes || []) {
      const i = records.findIndex(r => r.id === d.id);
      if (i >= 0) { out.deletes.push(records[i]); records.splice(i, 1); }
    }
    return j({ success: true, result: out });
  }
  if (method === 'POST' && /^\/zones\/[^/]+\/dns_records$/.test(path)) {
    individualCalls++;
    if (individualCalls > 50) return err('too many subrequests (stub)');
    const rec = { id: 'rec' + String(nextId++).padStart(4, '0'), created_on: new Date().toISOString(), ...body };
    records.push(rec);
    return j({ success: true, result: rec });
  }
  if (method === 'DELETE' && /^\/zones\/[^/]+\/dns_records\/[^/]+$/.test(path)) {
    individualCalls++;
    if (individualCalls > 50) return err('too many subrequests (stub)');
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

// ⑧ 分块删除：240 个 id 全删完（批量 >200 会被拒、逐个 >50 次会失败，
// 只有 50 一组分块删能过）
{
  resetZone();
  const fresh = new Date().toISOString();
  const ids = [];
  for (let i = 0; i < 240; i++) {
    const id = 'bulkdel' + i;
    ids.push(id);
    records.push({ id, type: 'A', name: `cfpbulkdel${i}.example.com`, content: '9.9.9.9', proxied: false, ttl: 60, created_on: fresh });
  }
  const r = await onRequestDelete(ctx(CFG_ENV, 'DELETE', { ids }));
  const data = await r.json();
  chk('删 240 个 id 回 deleted=240', r.status === 200 && data.deleted === 240, JSON.stringify(data).slice(0, 120));
  chk('删 240 后假 zone 清空', records.length === 0, 'left=' + records.length);
  chk('分块删没靠逐个调用硬撑（逐个次数 ≤50）', individualCalls <= 50, 'individualCalls=' + individualCalls);
}

// ⑨ 分块建记录：100 个 IP 全建成（逐个建第 51 个起会被 stub 拒）
{
  resetZone();
  const ips = Array.from({ length: 100 }, (_, i) => `5.5.${Math.floor(i / 250)}.${(i % 250) + 1}`);
  const r = await onRequestPost(ctx(CFG_ENV, 'POST', { ips }));
  const data = await r.json();
  chk('建 100 个 IP 回 200 且 hosts=100', r.status === 200 && data.hosts && data.hosts.length === 100,
    'status=' + r.status + ' hosts=' + (data.hosts && data.hosts.length));
  chk('建 100 后假 zone 记录=100 且都带 id', records.length === 100 && data.hosts.every(h => h.id),
    'records=' + records.length);
  chk('分块建没靠逐个调用硬撑（逐个次数 ≤50）', individualCalls <= 50, 'individualCalls=' + individualCalls);
}

// ⑩ 回查补 id / 回查失败不 502
{
  resetZone();
  dropBatchIds = true; // 批量响应不回 id，记录本身在 zone 里有 id
  const r = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: ['6.6.6.6', '7.7.7.7'] }));
  const data = await r.json();
  chk('批量不回 id 时靠回查补上 id', r.status === 200 && data.hosts && data.hosts.length === 2 && data.hosts.every(h => h.id),
    JSON.stringify(data).slice(0, 200));

  resetZone();
  dropBatchIds = true;
  failListAfterFirst = true; // 清扫那次列表能过，回查那次挂掉
  const r2 = await onRequestPost(ctx(CFG_ENV, 'POST', { ips: ['6.6.6.6', '7.7.7.7'] }));
  const data2 = await r2.json();
  chk('回查失败不拖成 502（回 200）', r2.status === 200, 'status=' + r2.status + ' ' + JSON.stringify(data2).slice(0, 160));
  chk('回查失败时 hosts 照常返回（id 为 null）', data2.hosts && data2.hosts.length === 2 && data2.hosts.every(h => h.id === null),
    JSON.stringify(data2).slice(0, 200));
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
