/* sw.js 逻辑测试台：stub 浏览器 SW 全局对象，真实驱动节流/缓存/上报逻辑。
 * 运行：node test/sw.test.mjs */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const swCode = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'sw.js'), 'utf8');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}
const approx = (actual, expected, tol, name) =>
  assert(Math.abs(actual - expected) <= expected * tol, name,
    `(期望 ${expected}±${tol * 100}%，实际 ${Math.round(actual)})`);

/* ---------------- 环境构造 ---------------- */
function makeEnv(bodySize) {
  const listeners = {};
  const messages = [];
  const store = new Map();
  const fetchCalls = [];
  const body = new Uint8Array(bodySize).fill(97);

  const self = {
    location: { origin: 'http://localhost:8000' },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [{ postMessage: (m) => messages.push(m) }],
    },
  };
  const caches = {
    open: async () => ({
      match: async (req) => store.get(req.url),
      put: async (req, resp) => { store.set(req.url, resp); },
    }),
    delete: async () => { store.clear(); return true; },
  };
  const fetchStub = async (req, opts) => {
    fetchCalls.push({ url: req.url ?? req, cache: opts?.cache });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  };

  // 在受控作用域内执行 sw.js
  new Function('self', 'caches', 'fetch', swCode)(self, caches, fetchStub);

  function config(profile, cacheStrategy = 'network-only') {
    listeners.message({
      data: { type: 'config', profile, cacheStrategy },
      ports: [{ postMessage: () => {} }],
    });
  }
  function fireFetch(url) {
    let respP;
    const event = {
      request: new Request(url),
      respondWith: (p) => { respP = p; },
      waitUntil: () => {},
    };
    listeners.fetch(event);
    return respP;
  }
  return { listeners, messages, fetchCalls, config, fireFetch, store };
}

const BASE = { name: 'test', bandwidthKbps: 1024, latencyMs: 100, lossRate: 0, offline: false };
// 1024 Kbps = 131072 B/s；256KB → 理论下载 2000ms

/* ---------------- 1. 拦截范围 ---------------- */
{
  const env = makeEnv(1024);
  env.config(BASE);
  const r = env.fireFetch('http://localhost:8000/index.html'); // 无 sim 参数
  assert(r === undefined, '不带 sim 标记的请求不被拦截');
}

/* ---------------- 2. 带宽 + 延迟节流 ---------------- */
{
  const env = makeEnv(256 * 1024);
  env.config(BASE);
  const t0 = performance.now();
  const resp = await env.fireFetch('http://localhost:8000/assets/big.bin?sim=1&run=1');
  assert(resp instanceof Response, '返回 Response');
  await resp.arrayBuffer(); // 消费整个流
  const elapsed = performance.now() - t0;
  approx(elapsed, 2100, 0.35, '总耗时 ≈ 延迟100ms + 256KB/128KB/s≈2000ms');

  const rep = env.messages.find((m) => m.type === 'resource-timing');
  assert(!!rep, 'SW 上报 resource-timing');
  approx(rep.latencyMs, 100, 0.3, '上报延迟 ≈ 100ms（含抖动）');
  approx(rep.downloadMs, 2000, 0.35, '上报下载时长 ≈ 2000ms');
  assert(rep.size === 256 * 1024, '上报大小正确');
  assert(env.fetchCalls[0].cache === 'no-store', '回源使用 no-store 绕过浏览器缓存');
}

/* ---------------- 3. 丢包重传 ---------------- */
{
  const env = makeEnv(32 * 1024);
  env.config({ ...BASE, latencyMs: 50, lossRate: 1 }); // SW 钳制到 0.95，近乎每块必丢
  const resp = await env.fireFetch('http://localhost:8000/a.bin?sim=1&run=2');
  await resp.arrayBuffer();
  const rep = env.messages.find((m) => m.type === 'resource-timing');
  // chunkSize ≈ 6554 → 32KB 需 5 块，每块 95% 概率重传 → 期望 4~5 次
  assert(rep.retransmits >= 3 && rep.retransmits <= 5,
    `丢包率钳制 0.95 时绝大多数块重传（实际 ${rep.retransmits}/5）`);
  approx(rep.downloadMs, 32 * 1024 / 131072 * 1000 + rep.retransmits * 50, 0.4,
    '下载时长含重传 RTT 代价');
}

/* ---------------- 4. 断网降级 ---------------- */
{
  const env = makeEnv(1024);
  env.config({ ...BASE, offline: true });
  const resp = await env.fireFetch('http://localhost:8000/a.bin?sim=1&run=3');
  assert(resp.status === 503, '断网返回 503');
  const rep = env.messages.find((m) => m.type === 'resource-timing');
  assert(rep.failed === true, '上报 failed');
  assert(env.messages.some((m) => m.type === 'resource-failed'), '广播 resource-failed（页面降级提示）');
}

/* ---------------- 5. cache-first 命中 ---------------- */
{
  const env = makeEnv(64 * 1024);
  env.config({ ...BASE, latencyMs: 20 }, 'cache-first');
  const r1 = await env.fireFetch('http://localhost:8000/x.css?sim=1&run=4');
  await r1.arrayBuffer();
  await new Promise((r) => setTimeout(r, 20)); // 等 waitUntil 写缓存
  const callsAfterFirst = env.fetchCalls.length;

  const t0 = performance.now();
  const r2 = await env.fireFetch('http://localhost:8000/x.css?sim=1&run=5');
  await r2.arrayBuffer();
  const hitElapsed = performance.now() - t0;
  assert(env.fetchCalls.length === callsAfterFirst, '第二次请求未回源（缓存命中）');
  // 阈值 300ms：与首次节流耗时（~520ms）明确区分，同时容忍测试机负载抖动
  assert(hitElapsed < 300, `缓存命中响应快（${Math.round(hitElapsed)}ms）`);
  const rep2 = env.messages.filter((m) => m.type === 'resource-timing').pop();
  assert(rep2.fromCache === true, '上报 fromCache');
}

/* ---------------- 6. network-first 断网回退缓存 ---------------- */
{
  const env = makeEnv(64 * 1024);
  env.config({ ...BASE, latencyMs: 10 }, 'network-first');
  const r1 = await env.fireFetch('http://localhost:8000/y.js?sim=1&run=6');
  await r1.arrayBuffer();
  await new Promise((r) => setTimeout(r, 20));

  env.config({ ...BASE, offline: true }, 'network-first');
  const r2 = await env.fireFetch('http://localhost:8000/y.js?sim=1&run=7');
  assert(r2.status === 200, '断网时 network-first 回退缓存返回 200');
  const rep = env.messages.filter((m) => m.type === 'resource-timing').pop();
  assert(rep.fromCache && rep.offlineFallback, '上报离线缓存回退');
}

/* ---------------- 7. 清缓存 ---------------- */
{
  const env = makeEnv(1024);
  env.config(BASE, 'cache-first');
  const r1 = await env.fireFetch('http://localhost:8000/z.json?sim=1&run=8');
  await r1.arrayBuffer();
  await new Promise((r) => setTimeout(r, 20));
  assert(env.store.size === 1, '缓存已写入');
  let acked = false;
  env.listeners.message({
    data: { type: 'clear-cache' },
    ports: [{ postMessage: () => { acked = true; } }],
    waitUntil: (p) => p,
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(env.store.size === 0 && acked, 'clear-cache 清空缓存并回执');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
