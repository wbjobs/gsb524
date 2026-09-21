/* =========================================================================
 * sw.js — 网络模拟 Service Worker
 *
 * 职责：
 *  1. 拦截带有 ?sim=1 标记的同源请求（测试页及其子资源）
 *  2. 按当前网络 profile 施加：带宽节流（分块流式下发）、RTT 延迟、
 *     丢包重传（每块按丢包率追加一次 RTT）、断网（503）
 *  3. 按所选缓存策略处理 Cache API：network-only / cache-first /
 *     network-first / stale-while-revalidate
 *  4. 把每个请求的精确阶段耗时 postMessage 回页面，用于瀑布图
 *
 * 精度说明：SW 与页面时钟不同源（timeOrigin 不同），无法直接对齐绝对
 * 时间戳。因此 SW 只上报"时长"（latency / download / total），请求在
 * 页面时间轴上的起点由页面侧 PerformanceResourceTiming 提供，二者合并
 * 得到精确瀑布。
 * ========================================================================= */

const CACHE_NAME = 'net-sim-cache-v1';

/* 当前配置（由控制面板通过 message 下发） */
let profile = {
  name: '4g',
  bandwidthKbps: 12000, // 下行带宽
  latencyMs: 50,        // 建连 + 首字节延迟（一次 RTT 量级）
  lossRate: 0,          // 0~1，每个数据块的重传概率
  offline: false,
};
let cacheStrategy = 'network-only';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base * (0.75 + Math.random() * 0.5); // ±25% 抖动

/* ------------------------------------------------------------------ */
/* 消息：配置下发 / 清缓存                                              */
/* ------------------------------------------------------------------ */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  const reply = (msg) => {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(msg);
  };

  if (data.type === 'config') {
    profile = { ...profile, ...data.profile };
    cacheStrategy = data.cacheStrategy || cacheStrategy;
    reply({ type: 'config-ack' });
  } else if (data.type === 'clear-cache') {
    event.waitUntil(
      caches.delete(CACHE_NAME).then((deleted) => reply({ type: 'cache-cleared', deleted }))
    );
  }
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/* ------------------------------------------------------------------ */
/* 请求拦截：只处理带 sim=1 标记的同源请求，控制面板自身流量不受影响     */
/* ------------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.searchParams.has('sim')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(handleSimulated(event));
});

/* ------------------------------------------------------------------ */
/* 缓存策略分发                                                         */
/* ------------------------------------------------------------------ */
async function handleSimulated(event) {
  const url = new URL(event.request.url);
  const runId = url.searchParams.get('run') || '0';

  switch (cacheStrategy) {
    case 'cache-first':            return cacheFirst(event, runId);
    case 'network-first':          return networkFirst(event, runId);
    case 'stale-while-revalidate': return swr(event, runId);
    default:                       return networkOnly(event, runId);
  }
}

/* 缓存键归一化：去掉每次运行都不同的 run 参数，
 * 否则跨运行的缓存命中永远失败（保留 seq 等业务参数以区分不同请求）。 */
function cacheKey(request) {
  const url = new URL(request.url);
  url.searchParams.delete('run');
  return url.toString();
}

async function networkOnly(event, runId) {
  const t0 = performance.now();
  try {
    const { response } = await throttledFetch(event.request, runId, t0);
    return response;
  } catch (err) {
    report(runId, event.request.url, t0, { failed: true, error: String(err) });
    return offlineResponse();
  }
}

async function cacheFirst(event, runId) {
  const t0 = performance.now();
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKey(event.request);
  const hit = await cache.match(key);
  if (hit) {
    report(runId, event.request.url, t0, {
      fromCache: true,
      size: +hit.headers.get('x-sw-size') || 0,
    });
    return hit;
  }
  try {
    const { response, cacheable } = await throttledFetch(event.request, runId, t0);
    if (cacheable) event.waitUntil(cache.put(key, cacheable));
    return response;
  } catch (err) {
    report(runId, event.request.url, t0, { failed: true, error: String(err) });
    return offlineResponse();
  }
}

async function networkFirst(event, runId) {
  const t0 = performance.now();
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKey(event.request);
  try {
    const { response, cacheable } = await throttledFetch(event.request, runId, t0);
    if (cacheable) event.waitUntil(cache.put(key, cacheable));
    return response;
  } catch (err) {
    // 断网/失败时回退缓存 —— 离线降级的关键路径
    const hit = await cache.match(key);
    if (hit) {
      report(runId, event.request.url, t0, {
        fromCache: true,
        offlineFallback: profile.offline,
        size: +hit.headers.get('x-sw-size') || 0,
      });
      return hit;
    }
    report(runId, event.request.url, t0, { failed: true, error: String(err) });
    return offlineResponse();
  }
}

async function swr(event, runId) {
  const t0 = performance.now();
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKey(event.request);
  const hit = await cache.match(key);

  if (hit) {
    // 后台回源更新缓存（标记 background，页面瀑布忽略）
    event.waitUntil(
      throttledFetch(event.request, runId, performance.now(), true)
        .then(({ cacheable }) => { if (cacheable) return cache.put(key, cacheable); })
        .catch(() => {})
    );
    report(runId, event.request.url, t0, {
      fromCache: true,
      revalidating: true,
      size: +hit.headers.get('x-sw-size') || 0,
    });
    return hit;
  }
  try {
    const { response, cacheable } = await throttledFetch(event.request, runId, t0);
    if (cacheable) event.waitUntil(cache.put(key, cacheable));
    return response;
  } catch (err) {
    report(runId, event.request.url, t0, { failed: true, error: String(err) });
    return offlineResponse();
  }
}

/* ------------------------------------------------------------------ */
/* 节流核心：RTT 延迟 + 丢包重传 + 按带宽分块流式下发                     */
/*                                                                        */
/* 返回 { response, cacheable }：                                        */
/*   response  —— 流式节流响应，交给浏览器消费                             */
/*   cacheable —— 同内容的完整 body 副本，供写入 Cache API（不可缓存为 null）*/
/* ------------------------------------------------------------------ */
async function throttledFetch(request, runId, t0, background = false) {
  if (profile.offline) throw new Error('simulated-offline');

  // 1) 建连 + 首字节延迟（RTT），含 ±25% 抖动
  const latencyMs = jitter(profile.latencyMs);
  await sleep(latencyMs);

  // 2) 真实回源。cache:'no-store' 是关键：绕过浏览器 HTTP 缓存，
  //    保证每次"网络请求"都真实经过节流管道，重复加载结果可对比。
  const raw = await fetch(request, { cache: 'no-store' });
  if (!raw.ok) {
    // 透传真实错误（404 等），不做节流、不写缓存
    return { response: raw, cacheable: null };
  }

  // 3) 读入完整 body，再以带宽决定的速度分块推流
  const buf = await raw.arrayBuffer();
  const size = buf.byteLength;
  const bytesPerSec = Math.max(1024, (profile.bandwidthKbps * 1024) / 8);
  const chunkSize = Math.max(4096, Math.round(bytesPerSec * 0.05)); // ~50ms 一个刻度
  const lossRate = Math.min(0.95, Math.max(0, profile.lossRate));

  let offset = 0;
  let retransmits = 0;
  let tStreamStart = 0;

  const stream = new ReadableStream({
    async pull(controller) {
      if (tStreamStart === 0) tStreamStart = performance.now();
      if (offset >= size) {
        controller.close();
        // 流真正被消费完毕时上报 —— 与页面收到完整响应的时刻对齐
        report(runId, request.url, t0, {
          size,
          latencyMs,
          downloadMs: performance.now() - tStreamStart,
          retransmits,
          background,
        });
        return;
      }
      // 丢包：该块需要重传，代价 ≈ 额外一次 RTT
      if (lossRate > 0 && Math.random() < lossRate) {
        retransmits++;
        await sleep(jitter(profile.latencyMs));
      }
      const end = Math.min(size, offset + chunkSize);
      const n = end - offset;
      controller.enqueue(new Uint8Array(buf, offset, n));
      offset = end;
      // 该块在"链路"上的传输耗时 = 字节数 / 带宽
      await sleep((n / bytesPerSec) * 1000);
    },
  });

  const headers = new Headers(raw.headers);
  headers.set('x-sw-simulated', '1');
  headers.set('x-sw-size', String(size));

  const response = new Response(stream, {
    status: raw.status,
    statusText: raw.statusText,
    headers,
  });
  const cacheable = new Response(buf.slice(0), {
    status: raw.status,
    statusText: raw.statusText,
    headers,
  });
  return { response, cacheable };
}

/* ------------------------------------------------------------------ */
/* 上报与降级响应                                                       */
/* ------------------------------------------------------------------ */
function broadcast(msg) {
  // 广播给所有窗口客户端，页面按 runId 过滤
  // （导航请求的 clientId 为空，无法定向投递，广播最稳）
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) c.postMessage(msg);
  });
}

function report(runId, url, t0, info) {
  broadcast({
    type: 'resource-timing',
    runId,
    url,
    strategy: cacheStrategy,
    profileName: profile.name,
    totalMs: performance.now() - t0,
    ...info,
  });
  if (info.failed) broadcast({ type: 'resource-failed', runId, url });
}

function offlineResponse() {
  return new Response('Service Unavailable (simulated offline)', {
    status: 503,
    statusText: 'Offline (simulated)',
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-sw-offline': '1' },
  });
}
