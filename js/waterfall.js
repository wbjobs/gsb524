/* =========================================================================
 * waterfall.js — Canvas 请求瀑布图
 *
 * 数据精度模型：
 *   - 每个请求的起点 start 来自页面侧 PerformanceResourceTiming
 *     （与页面 timeOrigin 对齐，权威时间轴）
 *   - 阶段时长（latency 等待 / download 传输）来自 SW 实测上报
 *   - 二者合并绘制：start → +latency（黄）→ +download（蓝）
 *
 * 支持单运行模式与双运行对比模式（同一资源上下两条 bar）。
 * ========================================================================= */
(function () {
  'use strict';

  const COLORS = {
    latency: '#f2c94c',
    download: '#4f8ef7',
    cached: '#4fc08d',
    failed: '#eb5a8d',
    latencyB: '#d8b4fe',
    downloadB: '#b06ef2',
    grid: '#2c3350',
    axisText: '#8b93b8',
    rowHover: 'rgba(255,255,255,0.04)',
    nameText: '#c8cee9',
  };
  const NAME_COL = 190;   // 左侧资源名列宽
  const AXIS_H = 26;      // 顶部时间轴高度
  const PAD_R = 16;

  class Waterfall {
    constructor(canvas, tooltip) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.tooltip = tooltip;
      this.rows = [];        // [{key,name,a,b}] a/b 为两次运行的 entry
      this.compare = false;
      this.maxEnd = 0;
      this._bindEvents();
    }

    /** entries: [{key,name,start,latency,download,total,size,fromCache,failed,retransmits}] */
    setRun(entries) {
      this.compare = false;
      this.rows = entries.map((e) => ({ key: e.key, name: e.name, a: e, b: null }));
      this._afterSet(entries);
    }

    /** 对比模式：runs = [{label, entries}, {label, entries}]，按 key 对齐 */
    setCompare(runA, runB) {
      this.compare = true;
      this.labels = [runA.label, runB.label];
      const mapA = new Map(runA.entries.map((e) => [e.key, e]));
      const mapB = new Map(runB.entries.map((e) => [e.key, e]));
      const keys = [...new Set([...mapA.keys(), ...mapB.keys()])];
      keys.sort((k1, k2) => (mapA.get(k1)?.start ?? 1e9) - (mapA.get(k2)?.start ?? 1e9));
      this.rows = keys.map((k) => ({
        key: k,
        name: (mapA.get(k) || mapB.get(k)).name,
        a: mapA.get(k) || null,
        b: mapB.get(k) || null,
      }));
      this._afterSet([...runA.entries, ...runB.entries]);
    }

    _afterSet(allEntries) {
      this.maxEnd = Math.max(1, ...allEntries.map((e) => e.start + e.total)) * 1.05;
      this.render();
    }

    /* ---------------- 渲染 ---------------- */
    render() {
      const dpr = window.devicePixelRatio || 1;
      const cssW = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
      const rowH = this.compare ? 36 : 24;
      const cssH = AXIS_H + this.rows.length * rowH + 8;
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.canvas.style.height = cssH + 'px';
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      this._rowH = rowH;
      this._plotW = cssW - NAME_COL - PAD_R;

      this._drawAxis(ctx, cssW);
      this.rows.forEach((row, i) => this._drawRow(ctx, row, i, cssW));
    }

    _x(ms) { return NAME_COL + (ms / this.maxEnd) * this._plotW; }

    _drawAxis(ctx, cssW) {
      const step = this._tickStep();
      ctx.font = '11px system-ui';
      ctx.textBaseline = 'middle';
      for (let t = 0; t <= this.maxEnd; t += step) {
        const x = this._x(t);
        ctx.strokeStyle = COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(x, AXIS_H - 6);
        ctx.lineTo(x, this.canvas.clientHeight || 1e5);
        ctx.stroke();
        ctx.fillStyle = COLORS.axisText;
        ctx.textAlign = t === 0 ? 'left' : 'center';
        ctx.fillText(this._fmtMs(t), x + (t === 0 ? 2 : 0), AXIS_H / 2 - 4);
      }
    }

    _drawRow(ctx, row, i, cssW) {
      const y = AXIS_H + i * this._rowH;
      if (this._hoverRow === i) {
        ctx.fillStyle = COLORS.rowHover;
        ctx.fillRect(0, y, cssW, this._rowH);
      }
      ctx.fillStyle = COLORS.nameText;
      ctx.font = '12px system-ui';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const label = row.name.length > 26 ? '…' + row.name.slice(-25) : row.name;
      ctx.fillText(label, 6, y + this._rowH / 2);

      if (this.compare) {
        if (row.a) this._drawBar(ctx, row.a, y + 3, 13, false);
        if (row.b) this._drawBar(ctx, row.b, y + this._rowH - 16, 13, true);
      } else if (row.a) {
        this._drawBar(ctx, row.a, y + 4, this._rowH - 8, false);
      }
    }

    _drawBar(ctx, e, y, h, isB) {
      const x0 = this._x(e.start);
      if (e.failed) {
        ctx.fillStyle = COLORS.failed;
        ctx.fillRect(x0, y, Math.max(3, this._x(e.start + e.total) - x0), h);
        return;
      }
      if (e.fromCache) {
        ctx.fillStyle = COLORS.cached;
        const w = Math.max(3, this._x(e.start + e.total) - x0);
        ctx.fillRect(x0, y, w, h);
      } else {
        // 等待段（建连+首字节）
        ctx.fillStyle = isB ? COLORS.latencyB : COLORS.latency;
        const wLat = Math.max(0, this._x(e.start + e.latency) - x0);
        ctx.fillRect(x0, y, wLat, h);
        // 下载段
        ctx.fillStyle = isB ? COLORS.downloadB : COLORS.download;
        const wDl = Math.max(1, this._x(e.start + e.latency + e.download) - x0 - wLat);
        ctx.fillRect(x0 + wLat, y, wDl, h);
      }
      // 耗时标注（空间足够时）
      const totalW = this._x(e.start + e.total) - x0;
      if (totalW > 46) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(this._fmtMs(e.total), x0 + totalW - 3, y + h / 2);
      }
    }

    _tickStep() {
      const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000];
      for (const s of steps) {
        if ((s / this.maxEnd) * this._plotW >= 70) return s;
      }
      return 60000;
    }

    _fmtMs(ms) {
      return ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + 's' : Math.round(ms) + 'ms';
    }

    /* ---------------- 交互 ---------------- */
    _bindEvents() {
      this.canvas.addEventListener('mousemove', (ev) => {
        const rect = this.canvas.getBoundingClientRect();
        const y = ev.clientY - rect.top;
        const idx = Math.floor((y - AXIS_H) / this._rowH);
        if (idx < 0 || idx >= this.rows.length) return this._hideTip();
        if (this._hoverRow !== idx) {
          this._hoverRow = idx;
          this.render();
        }
        this._showTip(this.rows[idx], ev.clientX, ev.clientY);
      });
      this.canvas.addEventListener('mouseleave', () => this._hideTip());
      new ResizeObserver(() => this.render()).observe(this.canvas.parentElement);
    }

    _showTip(row, cx, cy) {
      const fmt = (e, label) => {
        if (!e) return '';
        const head = label ? `<div class="tt-label">${label}</div>` : '';
        if (e.failed) {
          return `${head}<div class="tt-row tt-fail">❌ 请求失败（${this._fmtMs(e.total)}）</div>`;
        }
        const cacheTag = e.fromCache ? '<span class="tt-cache">缓存命中</span>' : '';
        return `${head}
          <div class="tt-row">开始 ${this._fmtMs(e.start)} · 总耗时 ${this._fmtMs(e.total)} ${cacheTag}</div>
          <div class="tt-row">等待 ${this._fmtMs(e.latency)} · 下载 ${this._fmtMs(e.download)}</div>
          <div class="tt-row">大小 ${(e.size / 1024).toFixed(1)} KB`
          + (e.retransmits ? ` · 重传 ${e.retransmits} 次` : '') + '</div>';
      };
      this.tooltip.innerHTML =
        `<div class="tt-name">${row.name}</div>` +
        fmt(row.a, this.compare ? this.labels[0] : '') +
        (this.compare ? fmt(row.b, this.labels[1]) : '');
      this.tooltip.hidden = false;
      const parentRect = this.canvas.parentElement.getBoundingClientRect();
      this.tooltip.style.left = Math.min(cx - parentRect.left + 14, parentRect.width - 240) + 'px';
      this.tooltip.style.top = (cy - parentRect.top + 14) + 'px';
    }

    _hideTip() {
      this.tooltip.hidden = true;
      if (this._hoverRow != null) {
        this._hoverRow = null;
        this.render();
      }
    }
  }

  window.Waterfall = Waterfall;
})();
