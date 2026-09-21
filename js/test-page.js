/* =========================================================================
 * test-page.js — 模拟目标站点的页面逻辑
 * 动态注入 CSS / 图片 / 接口请求，全部带 sim=1&run=N 标记；
 * 监听 SW 消息，资源失败时显示离线降级横幅与占位符。
 * ========================================================================= */
(function () {
  'use strict';

  var Q = window.__SIM_BASE__;
  var failed = 0;
  var loaded = { img: 0 };

  /* ---------- 样式表 ---------- */
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'assets/site.css?' + Q;
  document.head.appendChild(link);

  /* ---------- 图片画廊（不同体积，模拟真实站点） ---------- */
  var images = [
    { file: 'img-hero.svg',   w: '100%', h: 180, label: '头图' },
    { file: 'img-1.svg',      w: '32%',  h: 120, label: '配图1' },
    { file: 'img-2.svg',      w: '32%',  h: 120, label: '配图2' },
    { file: 'img-3.svg',      w: '32%',  h: 120, label: '配图3' },
    { file: 'img-4.svg',      w: '49%',  h: 140, label: '配图4' },
    { file: 'img-5.svg',      w: '49%',  h: 140, label: '配图5' },
  ];
  var gallery = document.getElementById('gallery');
  images.forEach(function (img) {
    var el = new Image();
    el.className = 'photo';
    el.style.width = img.w;
    el.style.height = img.h + 'px';
    el.alt = img.label;
    el.src = 'assets/' + img.file + '?' + Q;
    el.onerror = function () { markFailed(el, img.label); };
    gallery.appendChild(el);
  });

  /* ---------- 接口请求（XHR/fetch 也会出现在瀑布里） ---------- */
  var apiOut = document.getElementById('api-out');
  fetch('assets/data.json?' + Q)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      apiOut.textContent = '✅ 接口返回 ' + data.items.length + ' 条记录（'
        + Math.round(JSON.stringify(data).length / 1024) + ' KB）';
    })
    .catch(function (err) {
      apiOut.textContent = '❌ 接口请求失败：' + err.message + '（已降级为本地占位文案）';
      bumpFailCount();
    });

  // 第二个接口：模拟依赖第一个接口的串行请求（瀑布上可见时序）
  fetch('assets/data.json?' + Q + '&seq=2')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function () { /* 渲染省略 */ })
    .catch(function () { bumpFailCount(); });

  /* ---------- 失败统计与降级横幅 ---------- */
  function markFailed(imgEl, label) {
    bumpFailCount();
    // 图片降级：替换为占位块
    var ph = document.createElement('div');
    ph.className = 'photo placeholder';
    ph.style.width = imgEl.style.width;
    ph.style.height = imgEl.style.height;
    ph.textContent = '🚫 ' + label + '（离线占位）';
    imgEl.replaceWith(ph);
  }

  function bumpFailCount() {
    failed++;
    var banner = document.getElementById('offline-banner');
    document.getElementById('fail-count').textContent = String(failed);
    banner.hidden = false;
  }

  // SW 广播的失败通知（兜底，确保 503 也能触发横幅）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.type === 'resource-failed' && String(d.runId) === String(window.__RUN__)) {
        bumpFailCount();
      }
    });
  }

  /* ---------- 页面加载统计（展示在页脚） ---------- */
  window.addEventListener('load', function () {
    var nav = performance.getEntriesByType('navigation')[0];
    var res = performance.getEntriesByType('resource');
    var bytes = res.reduce(function (s, r) { return s + (r.transferSize || 0); }, 0);
    document.getElementById('page-stats').textContent =
      'load 事件：' + (nav ? nav.loadEventEnd.toFixed(0) : '?') + ' ms · '
      + res.length + ' 个资源 · 传输 '
      + (bytes / 1024).toFixed(1) + ' KB · 失败 ' + failed + ' 个';
  });
})();
