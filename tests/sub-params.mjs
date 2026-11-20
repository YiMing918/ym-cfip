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
const regionCount = (out, cc) => out.filter(l => {
  const n = l.slice(l.indexOf('#') + 1);
  return n.split(' ')[1] === cc || n.startsWith(cc);
}).length;

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

// ⑤ 节点名「中文地区打头」（v1.25）：页面默认命名格式与无 fmt 输出都把
//    名字排成「地区中文名 空格 代码 空格 序号 …来源中文名」。CFNext 名单
//    解析器（源码逐行核对过）对含中文的名字走「提炼地区」：开头是
//    「2–5 个中文 + 空格 + 两位代码」必提炼成功、下发成「地区-序号」
//    （与天诚等源在它里面的名字同形）；六字地区名（吉尔吉斯斯坦）靠
//    「代码独立成词」的兜底分支提炼成代码本身。下面用与它相同的提炼
//    逻辑断言：每条名字都提炼得出地区、且 {来源} 是中文原名。
const NEW_FMT = '{地区} {代码} {序号} {旗帜}{来源}';
const nameOf = l => l.slice(l.indexOf('#') + 1);
const Y_LITE = { HK: '香港', JP: '日本', US: '美国' };
function cfnextRegion(name) {
  const t = name.match(/^\s*[一-龥]{2,5}\s+[A-Z]{2}/);
  if (t) return t[0].match(/[一-龥]{2,5}/)[0];
  const m = name.match(/\b([A-Z]{2})\b/);
  return m ? (Y_LITE[m[1]] || m[1]) : '';
}
{
  const r = await lines('regions=HK,JP,US&fmt=' + encodeURIComponent(NEW_FMT));
  chk('中文打头：200', r.status === 200, `status=${r.status}`);
  chk('中文打头：名字以「地区中文名 代码 序号」开头', r.out.length > 0 && r.out.every(l => /^[一-龥]+ [A-Z]{2} \d+ /.test(nameOf(l))), JSON.stringify(r.out.slice(0, 2)));
  chk('中文打头：{来源} 是中文原名（优选高速）', r.out.every(l => nameOf(l).endsWith('优选高速')), JSON.stringify(r.out.slice(0, 2)));
  chk('中文打头：CFNext 提炼每条都出地区', r.out.every(l => cfnextRegion(nameOf(l)) !== ''), JSON.stringify(r.out.slice(0, 2)));
  const noFmt = await lines('regions=HK');
  chk('中文打头：无 fmt 默认输出同样提炼得出香港', noFmt.out.length > 0 && noFmt.out.every(l => cfnextRegion(nameOf(l)) === '香港'), JSON.stringify(noFmt.out.slice(0, 2)));
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
  const r = await subRequest(subCtx2('group=best&regions=HK&fmt=' + encodeURIComponent(NEW_FMT)));
  const out = (await r.text()).split('\n').filter(Boolean);
  const names = out.map(nameOf);
  chk('中文打头·各源：200 且 4 条', r.status === 200 && out.length === 4, `status=${r.status} n=${out.length}`);
  chk('中文打头·各源：微测优选保持中文原名', names.some(n => n.endsWith('微测优选')), JSON.stringify(names));
  chk('中文打头·各源：ASCII 源原样', names.some(n => n.endsWith('yuanxiawan')), JSON.stringify(names));
  chk('中文打头·各源：未知中文源原样', names.some(n => n.endsWith('没见过的源')), JSON.stringify(names));
  chk('中文打头·各源：无标注源名字仍完整可提炼', names.every(n => cfnextRegion(n) === '香港'), JSON.stringify(names));
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
  const r1 = await presetPost(kv, { regions: 'HK,JP,KR,SG,US', fmt: NEW_FMT, ui: '12' });
  const j1 = await r1.json();
  chk('预设：创建 200 且短码为 10 位十六进制', r1.status === 200 && /^[a-f0-9]{10}$/.test(j1.code || ''), `status=${r1.status} body=${JSON.stringify(j1)}`);
  chk('预设：url 是 /s/<短码>.txt 形式', !!j1.url && j1.url.endsWith('/s/' + j1.code + '.txt'), j1.url || '');
  const r2 = await presetPost(kv, { ui: '12', fmt: NEW_FMT, regions: 'HK,JP,KR,SG,US' });
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
  const direct = await lines('regions=HK,JP,KR,SG,US&fmt=' + encodeURIComponent(NEW_FMT) + '&ui=12');
  chk('预设短链：200', rs.status === 200, `status=${rs.status}`);
  chk('预设短链：与 /sub.txt 同参数逐行一致', shortText === direct.out.join('\n') + '\n', shortText.slice(0, 120));
  const r404 = await shortGet({ params: { id: 'deadbeef00' }, env: shortEnv, request: new Request('http://local/s/deadbeef00.txt') });
  chk('预设短链：未知短码 → 404', r404.status === 404, `status=${r404.status}`);
  const rBad = await shortGet({ params: { id: 'XYZ' }, env: shortEnv, request: new Request('http://local/s/XYZ.txt') });
  chk('预设短链：非法短码 → 400', rBad.status === 400, `status=${rBad.status}`);
  // 部署环境中动态段路由 [id].js 会先于 [id].txt.js 命中 .txt 请求：
  // 经 [id].js 的 .txt 分支读预设，结果必须与专职路由一致；快照读法不变
  const { onRequestGet: snapGet } = await import('../functions/s/[id].js');
  const rs2 = await snapGet({ params: { id: j1.code + '.txt' }, env: shortEnv, request: new Request('http://local/s/' + j1.code + '.txt') });
  chk('预设短链·经快照路由分支：200 且内容一致', rs2.status === 200 && (await rs2.text()) === shortText, `status=${rs2.status}`);
  const rs3 = await snapGet({ params: { id: 'deadbeef00.txt' }, env: shortEnv, request: new Request('http://local/s/deadbeef00.txt') });
  chk('预设短链·经快照路由分支：未知短码 → 404', rs3.status === 404, `status=${rs3.status}`);
  kv.m.set('snap:abc123XYZ9', '1.2.3.4:443#JP1\n');
  const rs4 = await snapGet({ params: { id: 'abc123XYZ9' }, env: shortEnv, request: new Request('http://local/s/abc123XYZ9') });
  chk('快照路由未受影响：无 .txt 的 id 仍读快照', rs4.status === 200 && (await rs4.text()).includes('1.2.3.4:443#JP1'), `status=${rs4.status}`);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
