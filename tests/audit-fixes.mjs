// ym-cfip 审计修复测试（node tests/audit-fixes.mjs）
// 验：① save 先占额再写对象——正常保存计数与对象一致；写对象失败退还占额；
//       占额后复核超限时拒绝且不写对象。
//     ② sub 数值参数严格全串校验——n=1abc / rn=JP.1x / ms=1.5x / mbps=2x / ui=3x 回 400，合法值照常。
class KV {
  constructor() { this.m = new Map(); this.failSnapPut = false; }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) {
    if (this.failSnapPut && k.startsWith('snap:')) throw new Error('kv boom');
    this.m.set(k, String(v));
  }
}

const { onRequestPost } = await import('../functions/save.js');
const { onRequest: subRequest } = await import('../functions/sub.js');

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

const saveCtx = (kv, ip = '1.2.3.4') => ({
  env: { SNAP: kv },
  request: new Request('http://local/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ text: '126.217.78.118:443#JP1\n3.113.213.171:443#JP2' }),
  }),
});
const day = new Date().toISOString().slice(0, 10);
const rlKey = 'rl:save:' + day;

// 1) 正常保存：对象写出 + 计数 = 1
{
  const kv = new KV();
  const r = await onRequestPost(saveCtx(kv));
  const j = await r.json();
  chk('save 正常：200 且返回 id', r.status === 200 && !!j.id, `status=${r.status}`);
  chk('save 正常：快照对象已写', kv.m.has('snap:' + j.id));
  const doc = JSON.parse(kv.m.get(rlKey));
  chk('save 正常：计数 total=1 且记了 IP', doc.total === 1 && doc.ips['1.2.3.4'] === 1, JSON.stringify(doc));
  // 重复保存同内容：零写入直接返回
  const r2 = await onRequestPost(saveCtx(kv));
  const doc2 = JSON.parse(kv.m.get(rlKey));
  chk('save 重复内容：仍 200 且计数不变', r2.status === 200 && doc2.total === 1);
}

// 2) 写对象失败：占额退还，计数归零，无快照残留
{
  const kv = new KV();
  kv.failSnapPut = true;
  const r = await onRequestPost(saveCtx(kv));
  chk('save 写失败：回 502', r.status === 502, `status=${r.status}`);
  const doc = JSON.parse(kv.m.get(rlKey) || '{"total":-1,"ips":{}}');
  chk('save 写失败：占额已退还（total=0）', doc.total === 0 && (doc.ips['1.2.3.4'] || 0) === 0, JSON.stringify(doc));
  chk('save 写失败：无快照残留', ![...kv.m.keys()].some(k => k.startsWith('snap:')));
}

// 3) 占额后复核超限：计数已在上限时拒绝（429），且不写对象
{
  const kv = new KV();
  kv.m.set(rlKey, JSON.stringify({ total: 200, ips: {} }));
  const r = await onRequestPost(saveCtx(kv));
  chk('save 全站达上限：429', r.status === 429, `status=${r.status}`);
  chk('save 全站达上限：无快照写出', ![...kv.m.keys()].some(k => k.startsWith('snap:')));
}

// ── sub 严格参数校验 ──
const POOL = [
  '126.217.78.118:443#JP1 [优选高速 84.34ms 15.55Mbps]',
  '3.113.213.171:443#JP2 [优选高速 84.5ms 11.3Mbps]',
  '172.104.81.253:443#JP3 [优选高速 86.56ms 11.73Mbps]',
].join('\n') + '\n';
const subCtx = (qs) => ({
  env: { ASSETS: { fetch: async () => new Response(POOL, { status: 200 }) } },
  request: new Request('http://local/sub?' + qs),
});
for (const [name, qs] of [
  ['n=1abc', 'n=1abc'], ['rn=JP.1x', 'rn=JP.1x'], ['ms=1.5x', 'ms=1.5x'],
  ['mbps=2x', 'mbps=2x'], ['ui=3x', 'ui=3x'], ['n=0', 'n=0'], ['rn=JP.-1', 'rn=JP.-1'],
]) {
  const r = await subRequest(subCtx(qs));
  chk(`sub 非法参数 ${name} → 400`, r.status === 400, `status=${r.status}`);
}
{
  const r = await subRequest(subCtx('n=2'));
  const lines = (await r.text()).trim().split('\n').filter(Boolean);
  chk('sub 合法 n=2 → 200 且恰好 2 条', r.status === 200 && lines.length === 2, `status=${r.status} lines=${lines.length}`);
}
{
  const r = await subRequest(subCtx('rn=JP.2&ms=100&mbps=10&ui=24'));
  const lines = (await r.text()).trim().split('\n').filter(Boolean);
  chk('sub 合法组合参数 → 200 且 rn 生效（2 条）', r.status === 200 && lines.length === 2, `status=${r.status} lines=${lines.length}`);
  chk('sub 合法 ui=24 → profile-update-interval 头已设', r.headers.get('profile-update-interval') === '24');
}
{
  const r = await subRequest(subCtx(''));
  chk('sub 无参数 → 200 默认输出', r.status === 200, `status=${r.status}`);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
