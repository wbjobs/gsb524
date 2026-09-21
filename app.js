const PROFILES = {
  '2g': { label: '2G EDGE', bandwidthKbps: 50, latencyMs: 400, lossRate: 0.08 },
  '3g': { label: '3G Fast', bandwidthKbps: 1500, latencyMs: 120, lossRate: 0.01 },
  '4g': { label: '4G', bandwidthKbps: 9000, latencyMs: 35, lossRate: 0 },
  wifi: { label: 'Wi-Fi', bandwidthKbps: 30000, latencyMs: 8, lossRate: 0 }
};

const STRATEGY_LABELS = {
  'network-only': 'network-only',
  'cache-first': 'cache-first',
  'network-first': 'network-first',
  'stale-while-revalidate': 'stale-while-revalidate',
  'cache-only': 'cache-only'
};

const $ = (id) => document.getElementById(id);

const elements = {
  profile: $('profileSelect'),
  bandwidth: $('bandwidthInput'),
  latency: $('latencyInput'),
  loss: $('lossInput'),
  strategy: $('strategySelect'),
  cycles: $('cyclesToggle'),
  offline: $('offlineToggle'),
  apply: $('applyButton'),
  run: $('runButton'),
  batch: $('batchButton'),
  bypass: $('bypassButton'),
  snapshot: $('snapshotButton'),
  clearSnapshots: $('clearSnapshotsButton'),
  status: $('swStatus'),
  state: $('runState'),
  offlineBanner: $('offlineBanner'),
  summary: $('summaryCards'),
  canvas: $('waterfallCanvas'),
  compareCanvas: $('compareCanvas'),
  tableBody: $('compareTable').querySelector('tbody'),
  timingBody: $('timingTable').querySelector('tbody'),
  tooltip: $('tooltip'),
  frame: $('demoFrame')
};

let registration;
let activeRun = null;
let lastResult = null;
let snapshots = loadSnapshots();
let hoverHit = null;

const chartState = { rows: [], dcl: null, load: null };

function loadSnapshots() {
  try {
    return JSON.parse(localStorage.getItem('gsb-network-lab-snapshots') || '[]');
  } catch {
    return [];
  }
}

function saveSnapshots() {
  localStorage.setItem('gsb-network-lab-snapshots', JSON.stringify(snapshots));
}

function getCustomConfig() {
  return {
    bandwidthKbps: clamp(Number(elements.bandwidth.value) || 1500, 1, 100000),
    latencyMs: clamp(Number(elements.latency.value) || 0, 0, 10000),
    lossRate: clamp(Number(elements.loss.value) || 0, 0, 100) / 100
  };
}

function selectedConfig() {
  const profile = elements.profile.value;
  return {
    ...(PROFILES[profile] || getCustomConfig()),
    offline: elements.offline.checked,
    strategy: elements.strategy.value
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function profileInputs() {
  const profile = PROFILES[elements.profile.value];
  if (profile) {
    elements.bandwidth.value = profile.bandwidthKbps;
    elements.latency.value = profile.latencyMs;
    elements.loss.value = Math.round(profile.lossRate * 1000) / 10;
  }
}

function setBusy(isBusy, message = '') {
  for (const button of [elements.apply, elements.run, elements.batch, elements.bypass, elements.snapshot]) {
    button.disabled = isBusy;
  }
  if (message) elements.state.textContent = message;
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !('performance' in window) || !elements.canvas.getContext) {
    elements.status.textContent = '当前浏览器不支持 Service Worker / Performance API / Canvas';
    elements.status.className = 'status-pill error';
    throw new Error('unsupported browser');
  }
  try {
    registration = await navigator.serviceWorker.register('./sw.js');
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        const finish = () => {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('controllerchange', finish);
          resolve();
        };
        navigator.serviceWorker.addEventListener('controllerchange', finish, { once: true });
        if (registration.active) registration.active.postMessage({ type: 'get-config' });
      });
    }
    elements.status.textContent = 'Service Worker 已激活';
    elements.status.className = 'status-pill ready';
    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    setOfflineBanner(elements.offline.checked);
  } catch (error) {
    elements.status.textContent = `Service Worker 注册失败：${error.message}`;
    elements.status.className = 'status-pill error';
    throw error;
  }
}

function postToWorker(message) {
  return new Promise((resolve, reject) => {
    if (!navigator.serviceWorker.controller) {
      reject(new Error('Service Worker 尚未控制页面'));
      return;
    }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => reject(new Error('Service Worker 响应超时')), 4000);
    const onMessage = (event) => {
      if (event.data?.requestId !== requestId) return;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      resolve(event.data);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    navigator.serviceWorker.controller.postMessage({ ...message, requestId });
  });
}

function handleServiceWorkerMessage(event) {
  if (event.data?.type !== 'timing' || !activeRun) return;
  const timing = event.data.timing;
  if (timing.runId !== activeRun.id) return;
  if (timing.cycle === 'unknown') return;
  const cycle = activeRun.cycles.find((item) => item.name === timing.cycle);
  if (!cycle) return;
  const rows = timing.background ? cycle.backgroundRows : cycle.rows;
  const index = rows.findIndex((row) => row.id === timing.id);
  if (index >= 0) rows[index] = timing;
  else rows.push(timing);
  if (timing.phase === 'revalidate') cycle.revalidationIds.add(timing.id);
  renderCurrentRun();
  checkCycleCompletion(cycle);
}

function setOfflineBanner(offline) {
  elements.offlineBanner.hidden = !offline;
}

async function configureSimulation(config) {
  const response = await postToWorker({ type: 'configure', config });
  setOfflineBanner(Boolean(response.config.offline));
  return response.config;
}

async function clearWorkerCache() {
  await postToWorker({ type: 'clear-cache' });
}

async function runCycle(name, run, { waitForBackground = false } = {}) {
  const cycle = {
    name,
    startedAt: performance.now(),
    rows: [],
    backgroundRows: [],
    revalidationIds: new Set(),
    navEntry: null,
    resourceEntries: [],
    settled: false
  };
  run.cycles.push(cycle);
  renderCurrentRun();

  const frameLoaded = once(elements.frame, 'load', 60000);
  const frameUrl = `/demo/index.html?run=${encodeURIComponent(run.id)}&cycle=${name}&t=${Date.now()}`;
  elements.frame.src = frameUrl;
  await frameLoaded;
  collectPerformanceEntries(cycle);

  await waitForTimings(cycle, {
    timeout: name === 'cold' ? 60000 : 15000,
    background: waitForBackground
  });
  collectPerformanceEntries(cycle);
  cycle.settled = true;
  renderCurrentRun();
  return cycle;
}

async function waitForTimings(cycle, { timeout, background }) {
  const start = performance.now();
  let lastCount = -1;
  let lastChange = performance.now();
  while (performance.now() - start < timeout) {
    const settledRows = cycle.rows.filter((row) => row.responseEnd);
    const hasOfflineNavigation = settledRows.some((row) =>
      row.initiator === 'navigation' && (row.status >= 400 || row.cacheState.includes('offline'))
    );
    const foregroundDone = cycle.rows.length >= 8
      && cycle.rows.every((row) => row.responseEnd && row.endReason !== 'pending');
    const backgroundDone = !background
      || cycle.backgroundRows.every((row) => row.responseEnd && row.endReason !== 'pending');
    const count = cycle.rows.length + cycle.backgroundRows.length;
    if (count !== lastCount) {
      lastCount = count;
      lastChange = performance.now();
    }
    if (hasOfflineNavigation && backgroundDone) return;
    if (foregroundDone && backgroundDone) return;
    if (cycle.rows.length > 0 && performance.now() - lastChange > 1800 && backgroundDone) return;
    await delay(120);
  }
}

function collectPerformanceEntries(cycle) {
  try {
    const frameWindow = elements.frame.contentWindow;
    if (!frameWindow) return;
    const entries = frameWindow.performance.getEntriesByType('resource');
    const nav = frameWindow.performance.getEntriesByType('navigation')[0] || null;
    cycle.navEntry = nav;
    cycle.resourceEntries = entries.filter((entry) => new URL(entry.name, location.href).pathname.startsWith('/demo/'));
    cycle.domContentLoadedEventEnd = nav?.domContentLoadedEventEnd || null;
    cycle.loadEventEnd = nav?.loadEventEnd || null;
  } catch {}
}

function once(target, eventName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(eventName, onLoad);
      reject(new Error(`等待 ${eventName} 超时`));
    }, timeoutMs);
    const onLoad = () => {
      clearTimeout(timer);
      resolve();
    };
    target.addEventListener(eventName, onLoad, { once: true });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkCycleCompletion() {}

async function runLoadTest({ bypass = false, labelOverride = '' } = {}) {
  const config = await configureSimulation(selectedConfig());
  const run = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    config,
    label: labelOverride || currentLabel(config),
    strategy: config.strategy,
    cycles: []
  };
  activeRun = run;
  setBusy(true, `正在加载：${run.label}`);
  try {
    if (bypass) {
      await clearWorkerCache();
      await runBypassProbe(run);
    } else {
      await clearWorkerCache();
      await runCycle('cold', run, { waitForBackground: true });
      if (elements.cycles.checked && config.strategy !== 'network-only') {
        await runCycle('warm', run, { waitForBackground: true });
      }
    }
    lastResult = buildResult(run);
    renderResult(lastResult);
    elements.state.textContent = `完成：${run.label}`;
    return lastResult;
  } finally {
    activeRun = null;
    setBusy(false);
  }
}

async function runBypassProbe(run) {
  const cycle = {
    name: 'cold',
    rows: [],
    backgroundRows: [],
    revalidationIds: new Set(),
    navEntry: null,
    resourceEntries: [],
    settled: true
  };
  run.cycles.push(cycle);
  const started = performance.now();
  try {
    const response = await fetch(`/demo/api/products.json?run=${encodeURIComponent(run.id)}&cycle=cold&probe=1&__sw_bypass=1`, {
      cache: 'no-store'
    });
    await response.arrayBuffer();
  } catch {}
  await delay(300);
  cycle.settled = true;
  cycle.manualStart = started;
  renderCurrentRun();
}

function currentLabel(config) {
  const profileLabel = Object.entries(PROFILES).find(([, profile]) =>
    profile.bandwidthKbps === config.bandwidthKbps
    && profile.latencyMs === config.latencyMs
    && Math.abs(profile.lossRate - config.lossRate) < 0.0001
  )?.[1]?.label;
  const profile = profileLabel || `自定义 ${config.bandwidthKbps} kbps`;
  return `${config.offline ? '断网 · ' : ''}${profile} · ${config.latencyMs}ms · ${Math.round(config.lossRate * 1000) / 10}%`;
}

function renderCurrentRun() {
  if (!activeRun) return;
  const temporary = buildResult(activeRun, true);
  renderResult(temporary);
}

function buildResult(run, live = false) {
  return {
    id: run.id,
    label: live ? `${run.label}（进行中）` : run.label,
    config: { ...run.config },
    strategy: run.strategy,
    live,
    cycles: run.cycles.map((cycle) => buildCycleMetrics(cycle))
  };
}

function buildCycleMetrics(cycle) {
  const rows = [...cycle.rows].sort((a, b) => a.fetchEventStart - b.fetchEventStart);
  const backgroundRows = [...cycle.backgroundRows].sort((a, b) => a.fetchEventStart - b.fetchEventStart);
  const nav = rows.find((row) => row.initiator === 'navigation');
  const perfMap = buildPerformanceMap(cycle);
  const navPerf = perfMap['/demo/index.html'];
  const start = rows.length ? Math.min(...rows.map((row) => row.fetchEventStart)) : 0;
  const clockOffset = nav && navPerf ? (navPerf.workerStart || 0) - nav.fetchEventStart : 0;
  const endRows = rows.filter((row) => row.responseEnd);
  const end = endRows.length ? Math.max(...endRows.map((row) => row.responseEnd)) : start;
  const networkRows = rows.filter((row) => !isCacheState(row.cacheState));
  const cacheRows = rows.filter((row) => isCacheState(row.cacheState));
  const failedRows = rows.filter((row) => row.status >= 400 || row.endReason === 'error');
  const bytes = rows.reduce((sum, row) => sum + (isCacheState(row.cacheState) ? 0 : row.bytes || 0), 0);
  const retransmittedBytes = rows.reduce((sum, row) => sum + row.retransmittedPackets * 1460, 0);
  const dcl = navPerf?.domContentLoadedEventEnd ?? null;
  const load = navPerf?.loadEventEnd ?? null;
  return {
    name: cycle.name,
    rows,
    backgroundRows,
    start,
    clockOffset,
    end,
    duration: end - start,
    ttfb: nav && nav.firstByte ? nav.firstByte - nav.fetchEventStart : null,
    domContentLoaded: dcl,
    load,
    bytes,
    retransmittedBytes,
    requests: rows.length,
    cacheHits: cacheRows.length,
    failures: failedRows.length,
    offline: Boolean(failedRows.some((row) => row.cacheState.includes('offline'))),
    performanceMap: perfMap,
    navPerformance: navPerf || null
  };
}

function isCacheState(state) {
  return ['cache-hit', 'stale-hit', 'offline-cache-hit', 'cache-only-hit', 'network-error-cache'].includes(state);
}

function buildPerformanceMap(cycle) {
  const map = {};
  for (const entry of cycle.resourceEntries || []) {
    const path = new URL(entry.name, location.href).pathname;
    map[path] = entry;
  }
  if (cycle.navEntry) {
    map['/demo/index.html'] = cycle.navEntry;
  }
  return map;
}

function formatMs(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Math.round(value)} ms`;
}

function formatBytes(value) {
  if (!value) return '0 KB';
  return `${(value / 1024).toFixed(1)} KB`;
}

function renderResult(result) {
  renderSummary(result);
  renderWaterfall(result);
  renderTimingValidation(result);
  renderSnapshotsTable();
}

function renderSummary(result) {
  const cards = result.cycles.flatMap((cycle) => {
    const title = `${cycle.name === 'cold' ? '冷加载' : '热加载'} · ${STRATEGY_LABELS[result.strategy]}`;
    return [
      metric(title, '总耗时', formatMs(cycle.duration)),
      metric(title, 'TTFB', formatMs(cycle.ttfb)),
      metric(title, 'DCL', formatMs(cycle.domContentLoaded)),
      metric(title, 'onload', formatMs(cycle.load)),
      metric(title, '网络传输', formatBytes(cycle.bytes)),
      metric(title, '缓存 / 请求', `${cycle.cacheHits}/${cycle.requests}`),
      metric(title, '丢包重传', formatBytes(cycle.retransmittedBytes)),
      metric(title, '失败 / 降级', String(cycle.failures))
    ];
  });
  elements.summary.innerHTML = cards.join('');
}

function metric(group, label, value) {
  return `<div class="metric-card"><span>${group} · ${label}</span><strong>${value}</strong></div>`;
}

function addSnapshot() {
  if (!lastResult) return;
  snapshots.push({
    savedAt: new Date().toLocaleTimeString(),
    result: JSON.parse(JSON.stringify(lastResult, (key, value) => {
      if (value instanceof PerformanceEntry) return undefined;
      return value;
    }))
  });
  saveSnapshots();
  renderSnapshotsTable();
  drawCompareChart();
}

async function runBatchComparison() {
  const originalProfile = elements.profile.value;
  const originalCycles = elements.cycles.checked;
  elements.cycles.checked = false;
  setBusy(true, '正在顺序对比 2G / 3G / 4G');
  try {
    for (const profileName of ['2g', '3g', '4g']) {
      elements.profile.value = profileName;
      elements.offline.checked = false;
      profileInputs();
      const result = await runLoadTest({ labelOverride: `${PROFILES[profileName].label} · ${elements.strategy.value}` });
      snapshots.push({
        savedAt: new Date().toLocaleTimeString(),
        result: JSON.parse(JSON.stringify(stripPerformanceEntries(result)))
      });
      saveSnapshots();
    }
    renderSnapshotsTable();
    drawCompareChart();
  } finally {
    elements.profile.value = originalProfile;
    elements.cycles.checked = originalCycles;
    profileInputs();
    setBusy(false);
  }
}

function stripPerformanceEntries(result) {
  const cloned = JSON.parse(JSON.stringify(result));
  cloned.cycles.forEach((cycle) => {
    delete cycle.performanceMap;
    delete cycle.navPerformance;
  });
  return cloned;
}

function renderSnapshotsTable() {
  const rows = snapshots.flatMap((snapshot, snapshotIndex) => {
    return snapshot.result.cycles.map((cycle) => `
      <tr>
        <td>${snapshot.result.label} <span class="tag ${cycle.name}">${cycle.name}</span></td>
        <td>${snapshot.result.strategy}</td>
        <td>${cycle.name === 'cold' ? '冷' : '热'}</td>
        <td>${formatMs(cycle.duration)}</td>
        <td>${formatMs(cycle.ttfb)}</td>
        <td>${formatMs(cycle.domContentLoaded)}</td>
        <td>${formatMs(cycle.load)}</td>
        <td>${formatBytes(cycle.bytes)}</td>
        <td>${cycle.cacheHits}/${cycle.requests}</td>
        <td><button data-remove-snapshot="${snapshotIndex}">删除</button></td>
      </tr>
    `);
  }).join('');
  elements.tableBody.innerHTML = rows;
}

function renderTimingValidation(result) {
  const body = result.cycles.flatMap((cycle) => {
    return cycle.rows.map((row) => {
      const perf = cycle.performanceMap?.[row.url];
      const swDuration = row.responseEnd ? row.responseEnd - row.fetchEventStart : null;
      const perfDuration = perf?.duration ?? null;
      const delta = swDuration !== null && perfDuration !== null ? swDuration - perfDuration : null;
      return `
        <tr>
          <td><div class="resource-name">${row.url}</div></td>
          <td>${formatMs(swDuration)}</td>
          <td>${formatMs(perfDuration)}</td>
          <td>${formatMs(delta)}</td>
          <td>${formatBytes(row.bytes)}</td>
          <td>${formatBytes(perf?.encodedBodySize || 0)}</td>
          <td>${row.cacheState}</td>
        </tr>
      `;
    });
  }).join('');
  elements.timingBody.innerHTML = body;
}

function renderWaterfall(result) {
  drawWaterfall(result);
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function drawWaterfall(result) {
  const { context, width, height } = resizeCanvas(elements.canvas);
  context.clearRect(0, 0, width, height);
  context.font = '12px system-ui';
  context.textBaseline = 'middle';

  const labelWidth = 250;
  const headerHeight = 34;
  const groupTitleHeight = 28;
  const rowHeight = 24;
  const visibleRowCount = Math.max(8, ...result.cycles.map((cycle) => cycle.rows.length + cycle.backgroundRows.length));
  const groupHeight = groupTitleHeight + visibleRowCount * rowHeight + 20;
  const chartWidth = Math.max(80, width - labelWidth - 28);
  const groups = result.cycles.map((cycle, index) => ({
    cycle,
    y: headerHeight + index * groupHeight,
    scale: Math.max(10, cycle.duration || 1)
  }));

  context.fillStyle = '#96a4ba';
  context.fillText('资源', 14, 18);
  context.fillText('时间轴（相对 SW 首个 fetch 事件）', labelWidth + 10, 18);
  context.strokeStyle = '#253149';
  context.beginPath();
  context.moveTo(0, 30);
  context.lineTo(width, 30);
  context.stroke();

  const hits = [];
  for (const group of groups) {
    drawCycleGroup(context, group, labelWidth, chartWidth, rowHeight, groupTitleHeight, visibleRowCount, hits);
  }

  elements.canvas._hits = hits;
  const totalNeeded = headerHeight + groups.length * groupHeight;
  if (elements.canvas.dataset.autoHeight !== `${totalNeeded}`) {
    elements.canvas.style.height = `${totalNeeded}px`;
    elements.canvas.dataset.autoHeight = `${totalNeeded}`;
    requestAnimationFrame(() => drawWaterfall(result));
  }
}

function drawCycleGroup(context, group, labelWidth, chartWidth, rowHeight, groupTitleHeight, visibleRowCount, hits) {
  const { cycle, y, scale } = group;
  context.fillStyle = cycle.name === 'cold' ? '#7dd3fc' : '#c4b5fd';
  context.font = '700 13px system-ui';
  context.fillText(`${cycle.name === 'cold' ? '冷加载' : '热加载'} · ${formatMs(cycle.duration)} · ${formatBytes(cycle.bytes)}`, 14, y + 15);
  context.font = '12px system-ui';

  const chartX = labelWidth;
  const axisY = y + groupTitleHeight;
  drawGrid(context, chartX, axisY, chartWidth, visibleRowCount * rowHeight, scale);

  const rows = [
    ...cycle.rows.map((row) => ({ ...row, waterfallBackground: false })),
    ...cycle.backgroundRows.map((row) => ({ ...row, waterfallBackground: true }))
  ].sort((a, b) => a.fetchEventStart - b.fetchEventStart);
  rows.forEach((row, index) => {
    const rowY = axisY + index * rowHeight;
    drawWaterfallRow(context, row, cycle, chartX, rowY, chartWidth, rowHeight, scale, hits, result);
  });

  drawEventLine(context, chartX, axisY, rows.length * rowHeight, cycle.domContentLoaded, cycle.clockOffset, scale, '#34d399', 'DCL', chartWidth);
  drawEventLine(context, chartX, axisY, rows.length * rowHeight, cycle.load, cycle.clockOffset, scale, '#fbbf24', 'load', chartWidth);

  context.strokeStyle = '#253149';
  context.beginPath();
  context.moveTo(0, axisY + visibleRowCount * rowHeight + 10);
  context.lineTo(labelWidth + chartWidth, axisY + visibleRowCount * rowHeight + 10);
  context.stroke();
}

function drawGrid(context, x, y, width, height, scale) {
  context.save();
  context.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  context.fillStyle = '#7c8aa1';
  const ticks = 6;
  for (let index = 0; index <= ticks; index += 1) {
    const tx = x + width * index / ticks;
    const value = scale * index / ticks;
    context.beginPath();
    context.moveTo(tx, y - 8);
    context.lineTo(tx, y + height);
    context.stroke();
    context.fillText(formatShortMs(value), tx + 3, y - 13);
  }
  context.restore();
}

function drawWaterfallRow(context, row, cycle, chartX, rowY, chartWidth, rowHeight, scale, hits) {
  const labelY = rowY + rowHeight / 2;
  context.fillStyle = row.background ? '#7c8aa1' : '#dbe7f7';
  context.fillText(`${initiatorLabel(row.initiator)}  ${shortPath(row.url)}`, 14, labelY);
  const origin = cycle.start;
  const x = (ms) => chartX + Math.max(0, ms / scale) * chartWidth;
  const start = x(row.fetchEventStart - origin);
  const barY = rowY + 6;
  const barHeight = 12;
  const cacheLookup = row.cacheLookupStart && row.cacheLookupEnd
    ? row.cacheLookupEnd - row.cacheLookupStart
    : 0;

  if (isCacheState(row.cacheState)) {
    const end = x((row.responseEnd || row.fetchEventStart) - origin);
    roundedRect(context, start, barY, Math.max(3, end - start), barHeight, 4, '#a78bfa');
  } else if (row.cacheState.includes('offline') || row.status >= 400) {
    const end = x((row.responseEnd || row.fetchEventStart + 10) - origin);
    roundedRect(context, start, barY, Math.max(3, end - start), barHeight, 4, '#fb7185');
  } else if (row.responseEnd) {
    const requestStart = row.requestStart || row.firstByte || row.responseEnd;
    const firstByte = row.firstByte || row.responseEnd;
    const responseEnd = row.responseEnd;
    if (cacheLookup > 0) {
      roundedRect(context, start, barY, Math.max(1, x(row.cacheLookupEnd - origin) - start), barHeight, 3, '#8b5cf6');
    }
    const queuedEnd = x(requestStart - origin);
    if (queuedEnd > start) {
      context.strokeStyle = '#64748b';
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(start, barY + barHeight / 2);
      context.lineTo(queuedEnd, barY + barHeight / 2);
      context.stroke();
      context.setLineDash([]);
    }
    const firstX = x(firstByte - origin);
    const endX = x(responseEnd - origin);
    roundedRect(context, queuedEnd, barY, Math.max(1, firstX - queuedEnd), barHeight, 3, '#60a5fa');
    roundedRect(context, firstX, barY, Math.max(1, endX - firstX), barHeight, 3, '#22d3ee');
    if (row.retransmittedPackets) {
      for (let index = 0; index < row.retransmittedPackets; index += 1) {
        const lossX = queuedEnd + (firstX - queuedEnd) * ((index + 1) / (row.retransmittedPackets + 1));
        context.fillStyle = '#fb7185';
        context.beginPath();
        context.arc(lossX, barY + barHeight / 2, 3.2, 0, Math.PI * 2);
        context.fill();
      }
    }
  } else {
    const pulseX = x(performance.now() - origin);
    roundedRect(context, start, barY, Math.max(4, Math.min(30, pulseX - start)), barHeight, 4, '#fbbf24');
  }

  context.fillStyle = '#96a4ba';
  context.fillText(row.cacheState, Math.min(chartX + chartWidth + 4, chartX + chartWidth - 84), labelY);
  hits.push({ row, cycle, x: 0, y: rowY, width: chartX + chartWidth, height: rowHeight });
}

function drawEventLine(context, chartX, axisY, height, value, clockOffset, scale, color, label, chartWidth) {
  if (value === null || value === undefined || !Number.isFinite(value)) return;
  const relativeToSwStart = value - clockOffset;
  const x = chartX + Math.min(1, Math.max(0, relativeToSwStart) / scale) * chartWidth;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.setLineDash([4, 4]);
  context.beginPath();
  context.moveTo(x, axisY - 6);
  context.lineTo(x, axisY + height + 4);
  context.stroke();
  context.setLineDash([]);
  context.fillText(label, x + 4, axisY - 8);
}

function roundedRect(context, x, y, width, height, radius, color) {
  context.fillStyle = color;
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
  context.fill();
}

function shortPath(path) {
  return path.replace('/demo/', '').replace('/api/', 'api/');
}

function initiatorLabel(initiator) {
  return {
    navigation: 'DOC',
    css: 'CSS',
    script: 'JS ',
    img: 'IMG',
    fetch: 'API',
    other: 'REQ'
  }[initiator] || 'REQ';
}

function formatShortMs(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

function drawCompareChart() {
  const { context, width, height } = resizeCanvas(elements.compareCanvas);
  context.clearRect(0, 0, width, height);
  const entries = snapshots.flatMap((snapshot) =>
    snapshot.result.cycles.map((cycle) => ({
      label: `${snapshot.result.label} · ${cycle.name}`,
      total: cycle.duration || 1,
      ttfb: cycle.ttfb || 0,
      dcl: cycle.domContentLoaded || 0,
      load: cycle.load || 0
    }))
  ).slice(-12);
  if (!entries.length) {
    context.fillStyle = '#96a4ba';
    context.font = '14px system-ui';
    context.fillText('保存结果后显示对比图', 18, 32);
    return;
  }
  const left = 70;
  const top = 28;
  const chartWidth = width - left - 24;
  const chartHeight = height - top - 44;
  const max = Math.max(...entries.map((entry) => entry.load || entry.total)) * 1.12;
  const rowHeight = chartHeight / entries.length;
  entries.forEach((entry, index) => {
    const y = top + index * rowHeight + 5;
    const barHeight = Math.min(18, rowHeight - 8);
    context.fillStyle = '#dbe7f7';
    context.fillText(entry.label, 8, y + barHeight / 2);
    const scaleX = (ms) => left + (ms / max) * chartWidth;
    drawCompareBar(context, scaleX(entry.load), y, barHeight, '#60a5fa', 'onload');
    drawCompareBar(context, scaleX(entry.dcl), y + 1, barHeight - 2, '#34d399', 'DCL');
    drawCompareBar(context, scaleX(entry.ttfb), y + 2, barHeight - 4, '#fbbf24', 'TTFB');
    context.fillStyle = '#96a4ba';
    context.fillText(formatShortMs(entry.total), scaleX(entry.total) + 6, y + barHeight / 2);
  });
}

function drawCompareBar(context, x, y, height, color) {
  context.fillStyle = color;
  context.fillRect(70, y, Math.max(2, x - 70), height);
}

function renderLegend() {
  const items = [
    ['#60a5fa', '等待 / 首字节延迟'],
    ['#22d3ee', '下载'],
    ['#a78bfa', '缓存命中'],
    ['#8b5cf6', '缓存查找'],
    ['#fb7185', '丢包 / 离线降级'],
    ['#34d399', 'DCL'],
    ['#fbbf24', 'onload']
  ];
  $('waterfallLegend').innerHTML = items
    .map(([color, label]) => `<span class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${label}</span>`)
    .join('');
}

function handleWaterfallHover(event) {
  const rect = elements.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = (elements.canvas._hits || []).find((item) =>
    x >= item.x && x <= item.width && y >= item.y && y <= item.height
  );
  hoverHit = hit || null;
  if (!hit) {
    elements.tooltip.hidden = true;
    elements.canvas.style.cursor = 'default';
    return;
  }
  const { row, cycle } = hit;
  const duration = row.responseEnd ? row.responseEnd - row.fetchEventStart : null;
  elements.tooltip.innerHTML = `
    <strong>${row.url}</strong>
    <div>阶段：${row.cycle} · ${row.cacheState}${row.waterfallBackground ? ' · 后台 SWR 刷新' : ''}</div>
    <div>开始：${Math.round(row.fetchEventStart - cycle.start)} ms；总耗时：${formatMs(duration)}</div>
    <div>TTFB：${formatMs(row.firstByte ? row.firstByte - row.fetchEventStart : null)}</div>
    <div>排队：${Math.round(row.queuedMs)} ms；下载：${Math.round(row.bandwidthMs)} ms；延迟：${Math.round(row.latencyMs)} ms</div>
    <div>大小：${formatBytes(row.bytes)}；包：${row.packets}；重传：${row.retransmittedPackets}</div>
    <div>状态：${row.status || '进行中'}${row.error ? `；${row.error}` : ''}</div>
  `;
  elements.tooltip.hidden = false;
  elements.tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 360)}px`;
  elements.tooltip.style.top = `${Math.min(event.clientY + 14, window.innerHeight - 190)}px`;
  elements.canvas.style.cursor = 'crosshair';
}

function bindEvents() {
  elements.profile.addEventListener('change', () => {
    profileInputs();
    if (elements.profile.value !== 'custom') elements.profile.value = elements.profile.value;
  });
  [elements.bandwidth, elements.latency, elements.loss].forEach((input) => {
    input.addEventListener('input', () => {
      elements.profile.value = 'custom';
    });
  });
  elements.apply.addEventListener('click', async () => {
    setBusy(true, '正在应用网络条件…');
    try {
      await configureSimulation(selectedConfig());
      elements.state.textContent = '网络条件已应用，点击“重新加载页面”查看效果。';
    } catch (error) {
      elements.state.textContent = error.message;
    } finally {
      setBusy(false);
    }
  });
  elements.run.addEventListener('click', () => runLoadTest());
  elements.batch.addEventListener('click', runBatchComparison);
  elements.bypass.addEventListener('click', () => runLoadTest({ bypass: true, labelOverride: '缓存绕过探测' }));
  elements.snapshot.addEventListener('click', addSnapshot);
  elements.clearSnapshots.addEventListener('click', () => {
    snapshots = [];
    saveSnapshots();
    renderSnapshotsTable();
    drawCompareChart();
  });
  elements.tableBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-snapshot]');
    if (!button) return;
    snapshots.splice(Number(button.dataset.removeSnapshot), 1);
    saveSnapshots();
    renderSnapshotsTable();
    drawCompareChart();
  });
  elements.canvas.addEventListener('mousemove', handleWaterfallHover);
  elements.canvas.addEventListener('mouseleave', () => {
    elements.tooltip.hidden = true;
    hoverHit = null;
  });
  window.addEventListener('resize', () => {
    if (lastResult) drawWaterfall(lastResult);
    drawCompareChart();
  });
}

function renderEmptyState() {
  elements.summary.innerHTML = `
    <div class="metric-card"><span>操作</span><strong>点击重新加载页面</strong><small>先选择预设或自定义网络与缓存策略</small></div>
  `;
  const { context, width, height } = resizeCanvas(elements.canvas);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#96a4ba';
  context.font = '14px system-ui';
  context.fillText('运行后将在此显示精确请求瀑布', 18, 34);
  renderSnapshotsTable();
  drawCompareChart();
}

async function init() {
  profileInputs();
  renderLegend();
  bindEvents();
  renderEmptyState();
  await registerServiceWorker();
}

init().catch((error) => {
  console.error(error);
  elements.state.textContent = error.message;
});
