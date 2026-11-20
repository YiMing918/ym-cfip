// ym-cfip sub 参数解析定向测试（node tests/sub-params.mjs）
// 覆盖 Chief 审计 #3 两个静默错 + #11 补测要求：
//   ① fmt= 空串等同未传（不得把节点名丢光只剩裸地址），与无 fmt 输出一致；
//   ② rn=HK.5 单独使用要把 HK 并入 regions，HK 按 rn 数量出；
//   ③ rn 多地区各自按量取；
//   ④ v1.18 严格校验不回归（n=1abc / rn=JP.1x 回 400），真实 fmt 模板仍生效。
const { onRequest: subRequest } = await import('../functions/sub.js');

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

const POOL = [
  '45.194.17.1:443#HK1 [优选高速 50.1ms 20.5Mbps]',
  '45.194.17.2:443#HK2 [优选高速 51.2ms 19.5Mbps]',
  '45.194.17.3:443#HK3 [优选高速 52.3ms 18.5Mbps]',
  '126.217.78.118:443#JP1 [优选高速 84.34ms 15.55Mbps]',
  '3.113.213.171:443#JP2 [优选高速 84.5ms 11.3Mbps]',
  '172.104.81.253:443#JP3 [优选高速 86.56ms 11.73Mbps]',
  '104.21.5.1:443#US1 [优选高速 150.1ms 25.5Mbps]',
  '104.21.5.2:443#US2 [优选高速 151.2ms 24.5Mbps]',
].join('\n') + '\n';

const subCtx = (qs) => ({
  env: { ASSETS: { fetch: async () => new Response(POOL, { status: 200 }) } },
  request: new Request('http://local/sub' + (qs ? '?' + qs : '')),
});
const lines = async (qs) => {
  const r = await subRequest(subCtx(qs));
  const t = await r.text();
  return { status: r.status, out: t.split('\n').filter(Boolean) };
};
const regionCount = (out, cc) => out.filter(l => l.includes('#' + cc)).length;

// ① fmt= 空值：名字不丢，与无 fmt 的输出逐行一致
{
  const noFmt = await lines('regions=HK');
  const emptyFmt = await lines('regions=HK&fmt=');
  chk('fmt= 空值：200', emptyFmt.status === 200, `status=${emptyFmt.status}`);
  chk('fmt= 空值：每行都带 # 名字（不剩裸地址）', emptyFmt.out.length > 0 && emptyFmt.out.every(l => l.includes('#')), JSON.stringify(emptyFmt.out));
  chk('fmt= 空值：输出与无 fmt 一致', JSON.stringify(emptyFmt.out) === JSON.stringify(noFmt.out));
}

// ② rn=HK.5 单独使用：HK 并入 regions，按 5 取（池里 3 条全出）
{
  const r = await lines('rn=HK.5');
  chk('rn=HK.5：200', r.status === 200, `status=${r.status}`);
  chk('rn=HK.5：HK 出 3 条（池量）', regionCount(r.out, 'HK') === 3, JSON.stringify(r.out));
  chk('rn=HK.5：缺省 JP/US 仍在', regionCount(r.out, 'JP') === 3 && regionCount(r.out, 'US') === 2, JSON.stringify(r.out));
}

// ③ rn 多地区：HK.2,JP.1 各自按量
{
  const r = await lines('rn=HK.2,JP.1');
  chk('rn=HK.2,JP.1：HK 出 2 条', regionCount(r.out, 'HK') === 2, JSON.stringify(r.out));
  chk('rn=HK.2,JP.1：JP 出 1 条', regionCount(r.out, 'JP') === 1, JSON.stringify(r.out));
}

// ④ 严格校验不回归 + 真实模板仍生效
{
  const bad1 = await lines('n=1abc');
  chk('n=1abc → 400（v1.18 校验不回归）', bad1.status === 400, `status=${bad1.status}`);
  const bad2 = await lines('rn=JP.1x');
  chk('rn=JP.1x → 400（v1.18 校验不回归）', bad2.status === 400, `status=${bad2.status}`);
  const tpl = await lines('regions=JP&fmt=' + encodeURIComponent('{代码}-{序号}'));
  chk('fmt 真实模板仍生效', tpl.out.length === 3 && tpl.out.every(l => /#JP-\d$/.test(l)), JSON.stringify(tpl.out));
}

// ⑤ {来源} 英文标签（v1.24）：已知中文源换英文标签、未知源 ASCII 兜底、
//    已是 ASCII 的原样、无来源标注用 Src+序号占位；任何名字不得含中文
//    （[\u4e00-\u9fa5]）或竖线——这是 CFNext 名单解析器的清名判定原文，
//    含其一就整名清空、下发回退成「优选IP-编号」。
const PETER_FMT = '{代码}{序号} []{旗帜}{来源}';
const CJK_RE = /[\u4e00-\u9fa5]/;
const nameOf = l => l.slice(l.indexOf('#') + 1);
{
  const r = await lines('regions=HK,JP,US&fmt=' + encodeURIComponent(PETER_FMT));
  chk('英文标签：200', r.status === 200, `status=${r.status}`);
  chk('英文标签：优选高速 → Gaosu', r.out.length > 0 && r.out.every(l => nameOf(l).endsWith('Gaosu')), JSON.stringify(r.out.slice(0, 2)));
  chk('英文标签：名字无中文、无竖线', r.out.every(l => !CJK_RE.test(nameOf(l)) && !nameOf(l).includes('|')));
  chk('英文标签：名字带地区码', r.out.every(l => /^[A-Z]{2}\d/.test(nameOf(l))), JSON.stringify(r.out.slice(0, 2)));
}
const POOL2 = [
  '45.194.17.9:443#HK1 [没见过的源 50ms 20Mbps]',
  '45.194.17.10:443#HK2 [微测优选·移动 51ms 19Mbps]',
  '45.194.17.11:443#HK3 [yuanxiawan 52ms 18Mbps]',
  '45.194.17.12:443#HK4 [95.12ms 7.95Mbps]',
].join('\n') + '\n';
const subCtx2 = (qs) => ({
  env: { ASSETS: { fetch: async (u) => new Response(new URL(u).pathname === '/data/best.txt' ? POOL2 : POOL, { status: 200 }) } },
  request: new Request('http://local/sub.txt' + (qs ? '?' + qs : '')),
});
{
  const r = await subRequest(subCtx2('group=best&regions=HK&fmt=' + encodeURIComponent(PETER_FMT)));
  const out = (await r.text()).split('\n').filter(Boolean);
  const names = out.map(nameOf);
  chk('英文标签·兜底：200 且 4 条', r.status === 200 && out.length === 4, `status=${r.status} n=${out.length}`);
  chk('英文标签·兜底：微测优选 → Wetest', names.some(n => n.endsWith('Wetest')), JSON.stringify(names));
  chk('英文标签·兜底：ASCII 源原样', names.some(n => n.endsWith('yuanxiawan')), JSON.stringify(names));
  chk('英文标签·兜底：未知中文源与无标注源 → Src+序号（2 个）', names.filter(n => /Src\d+$/.test(n)).length === 2, JSON.stringify(names));
  chk('英文标签·兜底：名字无中文、无竖线', names.every(n => !CJK_RE.test(n) && !n.includes('|')));
}

// ⑥ 参数预设短链（v1.24）：同参数同码（幂等、键序无关）、非法参数 400、
//    短链读出与 /sub.txt 同参数逐行一致、未知短码 404、非法短码 400
const { onRequestPost: savePost } = await import('../functions/save.js');
const { onRequestGet: shortGet } = await import('../functions/s/[id].txt.js');
class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
}
const presetPost = (kv, params) => savePost({
  env: { SNAP: kv },
  request: new Request('http://local/save', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'preset', params }),
  }),
});
{
  const kv = new FakeKV();
  const r1 = await presetPost(kv, { regions: 'HK,JP,KR,SG,US', fmt: PETER_FMT, ui: '12' });
  const j1 = await r1.json();
  chk('预设：创建 200 且短码为 10 位十六进制', r1.status === 200 && /^[a-f0-9]{10}$/.test(j1.code || ''), `status=${r1.status} body=${JSON.stringify(j1)}`);
  chk('预设：url 是 /s/<短码>.txt 形式', !!j1.url && j1.url.endsWith('/s/' + j1.code + '.txt'), j1.url || '');
  const r2 = await presetPost(kv, { ui: '12', fmt: PETER_FMT, regions: 'HK,JP,KR,SG,US' });
  const j2 = await r2.json();
  chk('预设：同参数同码（幂等、键序无关）', r2.status === 200 && j2.code === j1.code, JSON.stringify(j2));
  chk('预设：重复生成不重复写 KV', [...kv.m.keys()].filter(k => k.startsWith('preset:')).length === 1);
  const bad = await presetPost(kv, { n: 'abc' });
  chk('预设：非法参数 n=abc → 400', bad.status === 400, `status=${bad.status}`);
  const badKey = await presetPost(kv, { evil: '1' });
  chk('预设：未知参数名 → 400', badKey.status === 400, `status=${badKey.status}`);
  const shortEnv = { SNAP: kv, ASSETS: { fetch: async () => new Response(POOL, { status: 200 }) } };
  const rs = await shortGet({ params: { id: j1.code }, env: shortEnv, request: new Request('http://local/s/' + j1.code + '.txt') });
  const shortText = await rs.text();
  const direct = await lines('regions=HK,JP,KR,SG,US&fmt=' + encodeURIComponent(PETER_FMT) + '&ui=12');
  chk('预设短链：200', rs.status === 200, `status=${rs.status}`);
  chk('预设短链：与 /sub.txt 同参数逐行一致', shortText === direct.out.join('\n') + '\n', shortText.slice(0, 120));
  const r404 = await shortGet({ params: { id: 'deadbeef00' }, env: shortEnv, request: new Request('http://local/s/deadbeef00.txt') });
  chk('预设短链：未知短码 → 404', r404.status === 404, `status=${r404.status}`);
  const rBad = await shortGet({ params: { id: 'XYZ' }, env: shortEnv, request: new Request('http://local/s/XYZ.txt') });
  chk('预设短链：非法短码 → 400', rBad.status === 400, `status=${rBad.status}`);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
