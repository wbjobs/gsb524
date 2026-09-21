const CACHE_VERSION = 'gsb-network-lab-v1';

const DEFAULT_CONFIG = {
  bandwidthKbps: 1500,
  latencyMs: 120,
  lossRate: 0.01,
  offline: false,
  strategy: 'network-only'
};

let simulationConfig = { ...DEFAULT_CONFIG };

class NetworkScheduler {
  constructor() {
    this.lastRefill = 0;
    this.availableBytes = 0;
    this.bytesPerSecond = DEFAULT_CONFIG.bandwidthKbps * 1000 / 8;
    this.queue = Promise.resolve();
  }

  configure(config) {
    this.lastRefill = performance.now();
    this.availableBytes = 0;
    this.bytesPerSecond = Math.max(1, config.bandwidthKbps * 1000 / 8);
  }

  waitForBytes(byteCount, signal) {
    const job = () => this.acquire(byteCount, signal);
    const queued = this.queue.then(job, job);
    this.queue = queued.catch(() => {});
    return queued;
  }

  async acquire(byteCount, signal) {
    let waited = 0;
    while (byteCount > 0) {
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      const now = performance.now();
      if (!this.lastRefill) this.lastRefill = now;
      const elapsedSeconds = Math.max(0, (now - this.lastRefill) / 1000);
      this.availableBytes = Math.min(
        this.bytesPerSecond,
        this.availableBytes + elapsedSeconds * this.bytesPerSecond
      );
      this.lastRefill = now;
      const granted = Math.min(byteCount, this.availableBytes);
      if (granted >= 1) {
        this.availableBytes -= granted;
        byteCount -= granted;
      } else {
        const waitMs = Math.max(4, (1 - this.availableBytes) * 1000 / this.bytesPerSecond);
        await sleep(Math.min(waitMs, 40), signal);
        waited += waitMs;
      }
    }
    return waited;
  }
}

const scheduler = new NetworkScheduler();
scheduler.configure(simulationConfig);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Request aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

function offlineResponse(isNavigation) {
  if (!isNavigation) {
    return jsonResponse({ error: 'simulated offline' }, 503, { 'x-sw-offline': '1' });
  }
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>离线降级页面</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#111827;color:#f9fafb;font-family:system-ui}article{max-width:580px;padding:34px;border:1px solid #374151;border-radius:22px;background:#1f2937;line-height:1.7;color:#d1d5db}h1{color:#fda4af}</style>
<article><h1>当前处于离线模式</h1><p>Service Worker 已接管导航请求。network-only 显示此降级页；cache-first、network-first 旧缓存、stale-while-revalidate 或 cache-only 命中缓存时仍可展示原页面。</p><p>关闭“模拟断网”后重新加载即可恢复。</p></article>`;
  return new Response(body, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-sw-offline': '1' }
  });
}

function exactText(targetSize, prefix, suffix = '') {
  const marker = 'X_PADDING_MARKER_X';
  const currentSize = new TextEncoder().encode(`${prefix}${suffix}`).length;
  const fillerSize = targetSize - currentSize;
  if (fillerSize < marker.length) throw new Error(`Target size ${targetSize} is too small`);
  return `${prefix}${' '.repeat(fillerSize - marker.length)}${marker}${suffix}`;
}

function makeBmp(width, height, gradient) {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelSize = rowSize * height;
  const fileSize = 54 + pixelSize;
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint16(0, 0x4d42, true);
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelSize, true);
  view.setUint32(38, 2835, true);
  view.setUint32(42, 2835, true);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowSize + x * 3;
      const tx = x / Math.max(1, width - 1);
      const ty = y / Math.max(1, height - 1);
      bytes[offset] = Math.min(255, gradient[0] + Math.round(80 * ty));
      bytes[offset + 1] = Math.min(255, gradient[1] + Math.round(90 * tx));
      bytes[offset + 2] = Math.min(255, gradient[2] + Math.round(90 * (1 - tx)));
    }
  }
  return new Blob([buffer], { type: 'image/bmp' });
}

function textResponse(body, type) {
  const size = new TextEncoder().encode(body).length;
  return new Response(body, {
    headers: {
      'content-type': `${type}; charset=utf-8`,
      'content-length': String(size),
      'x-asset-size': String(size),
      'x-sw-source': 'synthetic'
    }
  });
}

function demoHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="same-origin"><title>受控演示页</title><link rel="stylesheet" href="app.css"><script src="app.js" defer></script></head>
<body><main class="demo-shell"><p class="kicker">受控页面 / demo/index.html</p><h1>电商商品瀑布演示</h1><p>HTML 先到达，随后 CSS、脚本、图片和 API 按依赖关系依次发出请求。</p>
<section class="hero-card"><img src="hero.bmp" alt="主图" width="120" height="60"><div><h2>限量网络套餐</h2><p>弱网下大图的下载阶段最明显；丢包会形成红色重传点。</p></div></section>
<section class="cards"><article><img src="thumb-a.bmp" alt="缩略图 A" width="80" height="50"><h3>缓存命中</h3><p>cache-first 第二轮几乎瞬时。</p></article><article><img src="thumb-b.bmp" alt="缩略图 B" width="80" height="50"><h3>后台刷新</h3><p>SWR 先展示缓存再刷新。</p></article></section>
<section id="apiData" class="api-box">等待 API 数据…</section><button id="bypassRead">绕过 SW 缓存读取 API</button></main></body></html>`;
}

function syntheticResponse(pathname) {
  if (pathname === '/demo/index.html') {
    const html = demoHtml();
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-asset-size': String(new TextEncoder().encode(html).length),
        'x-sw-source': 'synthetic'
      }
    });
  }
  if (pathname === '/demo/app.css') {
    const body = exactText(9000, ':root{color:#172033;font-family:system-ui}body{margin:0;background:#eef4ff;padding:32px}.demo-shell{max-width:900px;margin:auto}.kicker{color:#2563eb;font-weight:800;letter-spacing:.12em}.hero-card,.cards article,#apiData{background:white;border:1px solid #d7e0f0;border-radius:18px;padding:20px;box-shadow:0 16px 40px #1e293b1a}.hero-card{display:flex;gap:18px;align-items:center}.cards{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0}img{object-fit:cover;border-radius:12px;background:#dbeafe}h1{font-size:38px}.api-box{font-weight:700;color:#1d4ed8}@media(max-width:700px){.hero-card{display:block}.cards{grid-template-columns:1fr}}');
    return textResponse(body, 'text/css');
  }
  if (pathname === '/demo/app.js') {
    const body = exactText(12000, "document.addEventListener('DOMContentLoaded',async()=>{const box=document.querySelector('#apiData');const load=async(bypass)=>{try{const suffix=bypass?'&__sw_bypass=1':'';const response=await fetch('api/products.json?requestedBy=script'+suffix,{cache:'no-store'});const data=await response.json();box.textContent='API 返回 '+data.items.length+' 个商品：'+data.items.join('、')+(bypass?'（bypass）':'')}catch(error){box.textContent='API 加载失败，页面保留当前内容。'}};await load(false);document.querySelector('#bypassRead').onclick=()=>load(true);const extra=new Image;extra.src='late-thumb.bmp?requestedBy=script';document.body.appendChild(extra)});");
    return textResponse(body, 'application/javascript');
  }
  if (pathname === '/demo/api/products.json') {
    const body = { items: ['低延迟网关', '可靠重传', '缓存快照', '瀑布分析', '离线降级'] };
    return jsonResponse(body, 200, {
      'cache-control': 'no-store',
      'x-asset-size': String(JSON.stringify(body).length),
      'x-sw-source': 'synthetic'
    });
  }
  const images = {
    '/demo/hero.bmp': [120, 60, [20, 50, 110]],
    '/demo/thumb-a.bmp': [80, 50, [40, 90, 70]],
    '/demo/thumb-b.bmp': [80, 50, [110, 50, 70]],
    '/demo/late-thumb.bmp': [80, 50, [70, 40, 120]]
  };
  const image = images[pathname];
  if (!image) return null;
  const blob = makeBmp(image[0], image[1], image[2]);
  return new Response(blob, {
    headers: {
      'content-type': 'image/bmp',
      'content-length': String(blob.size),
      'x-asset-size': String(blob.size),
      'x-sw-source': 'synthetic'
    }
  });
}

function getRunContext(request, url) {
  const fromParams = url.searchParams.get('cycle');
  if (fromParams === 'cold' || fromParams === 'warm') {
    return { cycle: fromParams, runId: url.searchParams.get('run') || '', timingUrl: url.pathname };
  }
  const referrer = request.headers.get('referer');
  if (referrer) {
    try {
      const refUrl = new URL(referrer);
      const cycle = refUrl.searchParams.get('cycle');
      if (cycle === 'cold' || cycle === 'warm') {
        return { cycle, runId: refUrl.searchParams.get('run') || '', timingUrl: url.pathname };
      }
    } catch {}
  }
  return {
    cycle: 'unknown',
    runId: url.searchParams.get('run') || '',
    timingUrl: url.pathname
  };
}

function shouldBypassCache(request, url) {
  const cacheControl = request.headers.get('cache-control') || '';
  const pragma = request.headers.get('pragma') || '';
  return url.searchParams.get('__sw_bypass') === '1'
    || cacheControl.toLowerCase().includes('x-sw-bypass')
    || pragma.toLowerCase().includes('x-sw-bypass');
}

function getInitiator(request, context) {
  if (request.destination === 'document') return 'navigation';
  if (request.destination === 'script') return 'script';
  if (request.destination === 'style') return 'css';
  if (request.destination === 'image') return 'img';
  if (context.timingUrl.includes('/api/')) return 'fetch';
  return request.destination || 'other';
}

function createTiming(request, url, context, phase) {
  return {
    id: crypto.randomUUID(),
    runId: context.runId,
    cycle: context.cycle,
    phase,
    url: context.timingUrl,
    fullUrl: url.pathname + url.search,
    method: request.method,
    initiator: getInitiator(request, context),
    cacheState: 'pending',
    bypassed: false,
    background: phase === 'revalidate',
    fetchEventStart: performance.now(),
    cacheLookupStart: null,
    cacheLookupEnd: null,
    requestStart: null,
    firstByte: null,
    responseEnd: null,
    bytes: 0,
    packets: 0,
    retransmittedPackets: 0,
    lostPackets: 0,
    queuedMs: 0,
    bandwidthMs: 0,
    latencyMs: 0,
    retransmitMs: 0,
    status: 0,
    error: '',
    endReason: 'complete'
  };
}

function sendTiming(timing) {
  const payload = { type: 'timing', timing: JSON.parse(JSON.stringify(timing)) };
  clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then((clientsList) => clientsList.forEach((client) => client.postMessage(payload)))
    .catch(() => {});
}

function createSimulatedStream(payload, timing, config, signal, onComplete) {
  const bytes = new Uint8Array(payload);
  let offset = 0;
  let lastProgress = 0;
  const packetSize = 1460;
  const chunkSize = 16384;

  return new ReadableStream({
    async pull(controller) {
      try {
        if (offset >= bytes.length) {
          if (timing.responseEnd) return;
          await Promise.resolve(onComplete?.(timing)).catch(() => {});
          timing.responseEnd = performance.now();
          controller.close();
          sendTiming(timing);
          return;
        }
        if (!timing.requestStart) timing.requestStart = performance.now();
        const firstPacket = offset === 0;
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + (firstPacket ? packetSize : chunkSize)));
        const packetCount = Math.ceil(chunk.byteLength / packetSize);
        let retransmissionMs = 0;
        let lostInChunk = 0;
        for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
          let attempt = 0;
          while (Math.random() < config.lossRate) {
            attempt += 1;
            timing.lostPackets += 1;
            timing.retransmittedPackets += 1;
            lostInChunk += 1;
            retransmissionMs += config.latencyMs;
            timing.retransmitMs += config.latencyMs;
            if (attempt > 12) throw new Error('丢包超过最大重传次数');
            await sleep(config.latencyMs, signal);
          }
        }
        if (firstPacket) {
          await sleep(config.latencyMs, signal);
          timing.latencyMs += config.latencyMs + retransmissionMs;
        }
        const queueStart = performance.now();
        const physicalBytes = chunk.byteLength + lostInChunk * packetSize;
        const schedulerWait = await scheduler.waitForBytes(physicalBytes, signal);
        timing.queuedMs += performance.now() - queueStart;
        timing.bandwidthMs += schedulerWait;
        const now = performance.now();
        timing.firstByte = timing.firstByte || now;
        timing.packets += packetCount;
        timing.bytes += chunk.byteLength;
        offset += chunk.byteLength;
        controller.enqueue(chunk);
        if (now - lastProgress > 100 || offset === bytes.length) {
          lastProgress = now;
          sendTiming(timing);
        }
      } catch (error) {
        timing.responseEnd = performance.now();
        timing.endReason = error.name === 'AbortError' ? 'abort' : 'error';
        timing.error = error.message;
        sendTiming(timing);
        try { controller.error(error); } catch {}
      }
    },
    cancel(reason) {
      if (timing.responseEnd) return;
      timing.responseEnd = performance.now();
      timing.endReason = 'abort';
      timing.error = reason?.message || 'aborted';
      sendTiming(timing);
    }
  });
}

async function networkSynthetic(url, timing, config, event, cacheState = 'network', shouldCache = false) {
  const base = await syntheticResponse(url.pathname);
  if (!base) {
    timing.status = 404;
    timing.endReason = 'error';
    timing.error = 'Unknown demo resource';
    timing.responseEnd = performance.now();
    sendTiming(timing);
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain;charset=utf-8', 'x-sw-cache': 'error' }
    });
  }
  const payload = await base.clone().arrayBuffer();
  timing.requestStart = performance.now();
  let finishWaitUntil = () => {};
  if (event && shouldCache) {
    const keepAlive = new Promise((resolve) => {
      finishWaitUntil = resolve;
    });
    event.waitUntil(keepAlive);
  }
  const persist = shouldCache ? async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await syntheticResponse(url.pathname);
    const cachedHeaders = new Headers(cached.headers);
    cachedHeaders.set('x-cached-strategy', simulationConfig.strategy);
    await cache.put(cacheKey(url.pathname), new Response(await cached.blob(), {
      status: cached.status,
      statusText: cached.statusText,
      headers: cachedHeaders
    }));
    finishWaitUntil();
  } : null;
  const stream = createSimulatedStream(payload, timing, config, event?.request?.signal, persist);
  const headers = new Headers(base.headers);
  headers.set('x-sw-cache', cacheState);
  headers.set('x-sw-timing-id', timing.id);
  timing.cacheState = cacheState;
  timing.status = base.status;
  const response = new Response(stream, { status: base.status, statusText: base.statusText, headers });
  return response;
}

function cachedResponse(response, timing, cacheState) {
  const headers = new Headers(response.headers);
  headers.set('x-sw-cache', cacheState);
  headers.set('x-sw-timing-id', timing.id);
  timing.cacheState = cacheState;
  timing.status = response.status;
  timing.bytes = Number(headers.get('x-asset-size') || 0);
  timing.requestStart = performance.now();
  timing.firstByte = performance.now();
  timing.responseEnd = performance.now();
  sendTiming(timing);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function lookupCache(cache, timing, cacheState) {
  timing.cacheLookupStart = performance.now();
  await sleep(2);
  const match = await cache.match(cacheKey(timing.url), { ignoreSearch: true });
  timing.cacheLookupEnd = performance.now();
  if (match) timing.cacheState = cacheState;
  return match;
}

function cacheKey(pathname) {
  return new URL(pathname, self.location.origin).href;
}

async function backgroundRevalidate(url, request, context) {
  const cache = await caches.open(CACHE_VERSION);
  const timing = createTiming(request, url, context, 'revalidate');
  try {
    const response = await networkSynthetic(url, timing, simulationConfig, null, 'revalidate', false);
    const buffer = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.set('x-cached-strategy', simulationConfig.strategy);
    await cache.put(cacheKey(url.pathname), new Response(buffer, {
      status: response.status,
      statusText: response.statusText,
      headers
    }));
    timing.responseEnd = performance.now();
    timing.cacheState = 'revalidated';
    sendTiming(timing);
  } catch (error) {
    timing.responseEnd = performance.now();
    timing.endReason = 'error';
    timing.error = error.message;
    sendTiming(timing);
  }
}

function finishOffline(timing, response, cacheState) {
  timing.cacheState = cacheState;
  timing.status = response.status;
  timing.requestStart = performance.now();
  timing.firstByte = performance.now();
  timing.responseEnd = performance.now();
  timing.endReason = response.status === 200 ? 'complete' : 'offline';
  sendTiming(timing);
}

async function handleDemoFetch(event, request, url) {
  const context = getRunContext(request, url);
  const timing = createTiming(request, url, context, 'foreground');
  sendTiming(timing);
  const config = simulationConfig;
  const cache = await caches.open(CACHE_VERSION);
  const bypassed = shouldBypassCache(request, url);

  if (bypassed) {
    timing.bypassed = true;
    timing.cacheState = 'bypass';
    if (config.offline) {
      const fallback = offlineResponse(request.destination === 'document');
      finishOffline(timing, fallback, 'offline-bypass-failed');
      return fallback;
    }
    return networkSynthetic(url, timing, config, event, 'bypass', false);
  }

  if (config.strategy === 'network-only') {
    if (config.offline) {
      const fallback = offlineResponse(request.destination === 'document');
      finishOffline(timing, fallback, 'offline-fallback');
      return fallback;
    }
    return networkSynthetic(url, timing, config, event, 'network', false);
  }

  if (config.strategy === 'cache-first') {
    const hit = await lookupCache(cache, timing, 'cache-hit');
    if (hit) return cachedResponse(hit, timing, 'cache-hit');
    if (config.offline) {
      const fallback = offlineResponse(request.destination === 'document');
      finishOffline(timing, fallback, 'offline-miss');
      return fallback;
    }
    return networkSynthetic(url, timing, config, event, 'network-miss', true);
  }

  if (config.strategy === 'network-first') {
    if (!config.offline) {
      try {
        return await networkSynthetic(url, timing, config, event, 'network-refresh', true);
      } catch (error) {
        const hit = await lookupCache(cache, timing, 'network-error-cache');
        if (hit) return cachedResponse(hit, timing, 'network-error-cache');
        throw error;
      }
    }
    const hit = await lookupCache(cache, timing, 'offline-cache-hit');
    if (hit) return cachedResponse(hit, timing, 'offline-cache-hit');
    const fallback = offlineResponse(request.destination === 'document');
    finishOffline(timing, fallback, 'offline-fallback');
    return fallback;
  }

  if (config.strategy === 'stale-while-revalidate') {
    const hit = await lookupCache(cache, timing, 'stale-hit');
    if (hit) {
      if (!config.offline) {
        event.waitUntil(backgroundRevalidate(url, request, context));
      }
      return cachedResponse(hit, timing, 'stale-hit');
    }
    if (config.offline) {
      const fallback = offlineResponse(request.destination === 'document');
      finishOffline(timing, fallback, 'offline-miss');
      return fallback;
    }
    return networkSynthetic(url, timing, config, event, 'network-miss-swr', true);
  }

  if (config.strategy === 'cache-only') {
    const hit = await lookupCache(cache, timing, 'cache-only-hit');
    if (hit) return cachedResponse(hit, timing, 'cache-only-hit');
    const fallback = offlineResponse(request.destination === 'document');
    finishOffline(timing, fallback, 'cache-only-miss');
    return fallback;
  }

  return networkSynthetic(url, timing, config, event, 'network', false);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/demo/')) {
    return;
  }
  event.respondWith(
    handleDemoFetch(event, event.request, url).catch((error) => {
      const context = getRunContext(event.request, url);
      const timing = createTiming(event.request, url, context, 'foreground');
      timing.responseEnd = performance.now();
      timing.endReason = 'error';
      timing.error = error.message || String(error);
      timing.status = 503;
      timing.cacheState = 'error';
      sendTiming(timing);
      return offlineResponse(event.request.destination === 'document');
    })
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'configure') {
    simulationConfig = {
      ...DEFAULT_CONFIG,
      ...data.config,
      lossRate: Math.min(1, Math.max(0, Number(data.config?.lossRate ?? DEFAULT_CONFIG.lossRate)))
    };
    scheduler.configure(simulationConfig);
    event.source?.postMessage({
      type: 'configured',
      requestId: data.requestId,
      config: { ...simulationConfig }
    });
  }
  if (data.type === 'get-config') {
    event.source?.postMessage({
      type: 'config',
      requestId: data.requestId,
      config: { ...simulationConfig }
    });
  }
  if (data.type === 'clear-cache') {
    event.waitUntil(
      caches.delete(CACHE_VERSION).then(() => {
        event.source?.postMessage({ type: 'cache-cleared', requestId: data.requestId });
      })
    );
  }
});

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.resolve());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
