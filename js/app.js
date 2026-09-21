/* =========================================================================
 * app.js — 控制面板主逻辑
 *
 * 数据流：
 *   控制面板 → postMessage 下发 profile/缓存策略 → SW
 *   运行测试 → iframe 加载 test-page.html?sim=1&run=N
 *   SW 拦截请求 → 节流/缓存 → postMessage 上报各阶段时长
 *   iframe load 后 → 读取 iframe 内 PerformanceResourceTiming（起点）
 *                  + SW 上报（阶段时长）→ 合并 → Canvas 瀑布
 * ========================================================================= */
(function () {
  'use strict';

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const swStatus = $('sw-status');
  const iframe = $('preview');
  const waterfall = new Waterfall($('waterfall'), $('tooltip'));
  const wfEmpty = $('wf-empty');

  /* ---------------- 网络预设 ---------------- */
  const PRESETS = {
    '2g':      { bandwidthKbps: 250,   latencyMs: 400, lossRate: 0.02, offline: false },
    '3g':      { bandwidthKbps: 1600,  latencyMs: 150, lossRate: 0.01, offline: false },
    '4g':      { bandwidthKbps: 12000, latencyMs: 50,  lossRate: 0,    offline: false },
    'offline': { bandwidthKbps: 12000, latencyMs: 50,  lossRate: 0,    offline: true  },
  };
  let activePreset = '4g';

  const inBw = $('in-bw'), inLat = $('in-lat'), inLoss = $('in-loss');
  const oBw = $('o-bw'), oLat = $('o-lat'), oLoss = $('o-loss');

  function syncOutputs() {
    oBw.textContent = inBw.value;
    oLat.textContent = inLat.value;
    oLoss.textContent = inLoss.value;
  }

  function applyPreset(name) {
    activePreset = name;
    document.querySelectorAll('#presets button').forEach((b) =>
      b.classList.toggle('active', b.dataset.preset === name));
    const p = PRESETS[name];
    if (p) {
      inBw.value = p.bandwidthKbps;
      inLat.value = p.latencyMs;
      inLoss.value = Math.round(p.lossRate * 100);
    }
    $('offline-hint').hidden = name !== 'offline';
    syncOutputs();
    pushConfig(); // 切换预设立即生效，无需等运行
  }

  function currentProfile() {
    return {
      name: activePreset,
      bandwidthKbps: +inBw.value,
      latencyMs: +inLat.value,
      lossRate: +inLoss.value / 100,
      offline: activePreset === 'offline',
    };
  }

  document.querySelectorAll('#presets button').forEach((b) =>
    b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  [inBw, inLat, inLoss].forEach((el) =>
    el.addEventListener('input', () => {
      syncOutputs();
      // 手动调参即进入自定义模式（也会退出离线状态）
      if (activePreset !== 'custom') applyPreset('custom');
      else pushConfig();
    }));

  $('cache-strategy').addEventListener('change', pushConfig);

  /* ---------------- Service Worker 就绪 ---------------- */
  let swReady = false;

  async function initSW() {
    if (!('serviceWorker' in navigator)) {
      setStatus('err', '浏览器不支持 Service Worker');
      return;
    }
    try {
      await navigator.serviceWorker.register('sw.js');
      if (!navigator.serviceWorker.controller) {
        // 首次注册：等 skipWaiting + clients.claim 触发 controllerchange
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 3000); // 兜底
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      }
      swReady = !!navigator.serviceWorker.controller;
      if (swReady) {
        setStatus('ok', 'SW 已就绪');
        await pushConfig();
      } else {
        setStatus('warn', 'SW 未接管，请刷新页面');
      }
    } catch (err) {
      setStatus('err', 'SW 注册失败：' + err.message);
    }
  }

  function setStatus(kind, text) {
    swStatus.textContent = text;
    swStatus.className = 'badge badge-' + kind;
  }

  /** 下发配置并等待 SW 确认（MessageChannel 握手，保证先配置后加载） */
  function pushConfig() {
    if (!swReady) return Promise.resolve();
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      const t = setTimeout(resolve, 1000); // 兜底不阻塞
      ch.port1.onmessage = () => { clearTimeout(t); resolve(); };
      navigator.serviceWorker.controller.postMessage(
        { type: 'config', profile: currentProfile(), cacheStrategy: $('cache-strategy').value },
        [ch.port2]
      );
    });
  }

  /* ---------------- SW 消息收集 ---------------- */
  const swTimings = new Map(); // runId -> Map(url -> timing)

  navigator.serviceWorker?.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type !== 'resource-timing' || d.background) return;
    if (!swTimings.has(d.runId)) swTimings.set(d.runId, new Map());
    swTimings.get(d.runId).set(d.url, d);
    // 只保留最近 10 次运行的数据
    if (swTimings.size > 10) swTimings.delete(swTimings.keys().next().value);
  });

  /* ---------------- 运行测试 ---------------- */
  let runCounter = 0;
  let running = false;
  const history = []; // 运行记录

  $('btn-run').addEventListener('click', async () => {
    if (!swReady || running) return;
    running = true;
    const btn = $('btn-run');
    btn.disabled = true;
    btn.textContent = '⏳ 加载中…';

    await pushConfig(); // 先确保 SW 拿到最新配置，再发起加载
    const runId = String(++runCounter);
    swTimings.set(runId, new Map());
    iframe.dataset.runId = runId;
    iframe.src = 'test-page.html?sim=1&run=' + runId;
  });

  iframe.addEventListener('load', () => {
    const runId = iframe.dataset.runId;
    if (!runId) return;
    // 等 SW 最后几条 timing 消息送达（postMessage 为异步）
    setTimeout(() => collectRun(runId), 400);
  });

  /* ---------------- 数据合并：Performance API + SW 上报 ---------------- */
  function collectRun(runId) {
    const win = iframe.contentWindow;
    const swMap = swTimings.get(runId) || new Map();

    let perfEntries = [];
    let nav = null;
    try {
      perfEntries = win.performance.getEntriesByType('resource');
      nav = win.performance.getEntriesByType('navigation')[0] || null;
    } catch (err) {
      console.error('无法读取 iframe performance 数据', err);
    }

    const entries = [];

    // 文档请求（导航）也进瀑布，作为第一行
    if (nav) {
      entries.push(buildEntry(nav, swMap.get(nav.name), 'document'));
    }
    for (const pe of perfEntries) {
      entries.push(buildEntry(pe, swMap.get(pe.name), pe.initiatorType));
    }
    entries.sort((a, b) => a.start - b.start);

    const stats = {
      total: Math.max(...entries.map((e) => e.start + e.total), nav ? nav.loadEventEnd : 0),
      count: entries.length,
      bytes: entries.reduce((s, e) => s + e.size, 0),
      cached: entries.filter((e) => e.fromCache).length,
      failed: entries.filter((e) => e.failed).length,
      retx: entries.reduce((s, e) => s + (e.retransmits || 0), 0),
    };

    const profile = currentProfile();
    const run = {
      id: +runId,
      profileName: profile.name,
      profileDesc: describeProfile(profile),
      strategy: $('cache-strategy').value,
      entries,
      stats,
      label: `#${runId} ${profile.name}`,
    };
    history.push(run);

    renderStats(stats);
    showSingle(run);
    renderHistory();

    running = false;
    const btn = $('btn-run');
    btn.disabled = false;
    btn.textContent = '▶ 运行测试';
  }

  /** 合并单个请求：起点用 Performance API，阶段时长用 SW 上报 */
  function buildEntry(pe, sw, type) {
    const url = new URL(pe.name);
    const key = url.pathname + (url.searchParams.get('seq') ? '?seq=' + url.searchParams.get('seq') : '');
    const name = url.pathname.split('/').pop() + (type === 'document' ? ' (文档)' : '');

    if (sw) {
      const latency = sw.fromCache ? 0 : (sw.latencyMs || 0);
      const download = sw.fromCache ? sw.totalMs : (sw.downloadMs || 0);
      // 失败/缓存命中时用 SW 实测总时长；正常请求用 等待+下载 两段之和
      const total = (sw.fromCache || sw.failed) ? sw.totalMs : latency + download;
      return {
        key, name, type,
        start: pe.startTime,                       // 页面时间轴上的权威起点
        latency,
        download,
        total,
        size: sw.size || pe.transferSize || 0,
        fromCache: !!sw.fromCache,
        failed: !!sw.failed,
        retransmits: sw.retransmits || 0,
      };
    }
    // SW 数据缺失（异常兜底）：退化为 Performance API 自身的两段计时
    return {
      key, name, type,
      start: pe.startTime,
      latency: Math.max(0, (pe.responseStart || pe.startTime) - pe.startTime),
      download: Math.max(0, (pe.responseEnd || 0) - (pe.responseStart || pe.startTime)),
      total: pe.duration || 0,
      size: pe.transferSize || 0,
      fromCache: pe.transferSize === 0 && pe.decodedBodySize > 0,
      failed: false,
      retransmits: 0,
    };
  }

  function describeProfile(p) {
    if (p.offline) return '离线';
    return `${p.name} (${p.bandwidthKbps}Kbps/${p.latencyMs}ms/${Math.round(p.lossRate * 100)}%)`;
  }

  /* ---------------- 渲染 ---------------- */
  function renderStats(s) {
    $('stats').hidden = false;
    $('st-time').textContent = s.total >= 1000 ? (s.total / 1000).toFixed(2) + ' s' : Math.round(s.total) + ' ms';
    $('st-count').textContent = s.count;
    $('st-bytes').textContent = (s.bytes / 1024).toFixed(0) + ' KB';
    $('st-cache').textContent = s.cached;
    $('st-cache').className = 'stat-value' + (s.cached ? ' good' : '');
    $('st-retx').textContent = s.retx;
    $('st-fail').textContent = s.failed;
    $('st-fail').className = 'stat-value' + (s.failed ? ' bad' : '');
  }

  function showSingle(run) {
    $('wf-title').textContent = `— ${run.profileDesc} · ${run.strategy}`;
    $('lg-b').hidden = true;
    $('btn-single').hidden = true;
    wfEmpty.style.display = 'none';
    waterfall.setRun(run.entries);
  }

  function showCompare(runA, runB) {
    $('wf-title').textContent = `— 对比：${runA.label} vs ${runB.label}`;
    $('lg-b').hidden = false;
    $('btn-single').hidden = false;
    wfEmpty.style.display = 'none';
    waterfall.setCompare(
      { label: runA.label, entries: runA.entries },
      { label: runB.label, entries: runB.entries }
    );
  }

  /* ---------------- 历史记录与对比 ---------------- */
  const tbody = document.querySelector('#history-table tbody');
  const selected = new Set();

  function renderHistory() {
    tbody.innerHTML = '';
    if (!history.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="9">暂无运行记录</td></tr>';
      return;
    }
    for (const run of history) {
      const tr = document.createElement('tr');
      tr.dataset.runId = run.id;
      tr.innerHTML =
        `<td><input type="checkbox" data-id="${run.id}" ${selected.has(run.id) ? 'checked' : ''}></td>` +
        `<td>${run.id}</td>` +
        `<td>${run.profileDesc}</td>` +
        `<td>${run.strategy}</td>` +
        `<td>${(run.stats.total / 1000).toFixed(2)} s</td>` +
        `<td>${(run.stats.bytes / 1024).toFixed(0)} KB</td>` +
        `<td class="${run.stats.cached ? 'ok-cell' : ''}">${run.stats.cached}</td>` +
        `<td class="${run.stats.failed ? 'fail-cell' : ''}">${run.stats.failed}</td>` +
        `<td><button class="link-btn" data-view="${run.id}">查看</button></td>`;
      tbody.appendChild(tr);
    }
    updateCompareBtn();
  }

  tbody.addEventListener('change', (e) => {
    const id = +e.target.dataset.id;
    if (e.target.checked) {
      selected.add(id);
      if (selected.size > 2) {
        const first = [...selected][0];
        selected.delete(first);
        tbody.querySelector(`input[data-id="${first}"]`).checked = false;
      }
    } else {
      selected.delete(id);
    }
    updateCompareBtn();
  });

  tbody.addEventListener('click', (e) => {
    const id = +e.target.dataset?.view;
    if (!id) return;
    const run = history.find((r) => r.id === id);
    if (run) {
      showSingle(run);
      renderStats(run.stats);
      markViewing(id);
    }
  });

  function markViewing(id) {
    tbody.querySelectorAll('tr').forEach((tr) =>
      tr.classList.toggle('viewing', +tr.dataset.runId === id));
  }

  function updateCompareBtn() {
    $('btn-compare').disabled = selected.size !== 2;
  }

  $('btn-compare').addEventListener('click', () => {
    const [a, b] = [...selected].map((id) => history.find((r) => r.id === id));
    if (a && b) showCompare(a, b);
  });

  $('btn-single').addEventListener('click', () => {
    const last = history[history.length - 1];
    if (last) showSingle(last);
  });

  /* ---------------- 清缓存 ---------------- */
  $('btn-clear-cache').addEventListener('click', () => {
    if (!swReady) return;
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => {
      setStatus('ok', e.data.deleted ? 'SW 缓存已清除' : '缓存本为空');
      setTimeout(() => setStatus('ok', 'SW 已就绪'), 2000);
    };
    navigator.serviceWorker.controller.postMessage({ type: 'clear-cache' }, [ch.port2]);
  });

  /* ---------------- 启动 ---------------- */
  syncOutputs();
  initSW();
})();
