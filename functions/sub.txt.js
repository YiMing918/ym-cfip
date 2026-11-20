// YM 优选 IP · 订阅端点 /sub.txt（页面生成的正式形式，逻辑在 _sub_core.js，与 /sub 共用）
// 文件名带 .txt 是 Pages Functions 的路由写法：sub.txt.js 对应路径 /sub.txt，
// 让订阅链接和站内其它 .txt 直链同形，方便只认 .txt 链接的订阅后台拉取。
export { handleSub as onRequest } from "./_sub_core.js";
