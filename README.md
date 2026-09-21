# Service Worker 网络实验室

这是一个零依赖的前端实验台，用 Service Worker 模拟弱网、丢包和断网，用 Performance API 对照真实资源时序，并通过 Canvas 绘制请求瀑布。

## 运行

Service Worker 不能在 `file://` 下注册，请使用任意静态 HTTP 服务：

```bash
python3 -m http.server 4173
```

然后打开：

```text
http://127.0.0.1:4173/
```

首次打开时等待状态变为“Service Worker 已激活”，再点击“重新加载页面”。

## 支持的模拟项

- 预设网络：2G EDGE、3G Fast、4G、Wi-Fi。
- 自定义条件：带宽 `kbps`、单向延迟 `ms`、丢包率 `%`、模拟断网。
- 缓存策略：`network-only`、`cache-first`、`network-first`、`stale-while-revalidate`、`cache-only`。
- 冷/热两轮：冷轮开始前清空 SW Cache；热轮立即重新加载同一组资源。
- 批量对比：顺序执行 2G、3G、4G，并把快照保存到对比图表和表格。
- 缓存绕过探测：请求携带 `?__sw_bypass=1` 和自定义 `cache-control: x-sw-bypass`，SW 明确标记为 `bypass`。

## 实现要点

- Service Worker 只拦截同源 `/demo/` 路径，避免影响控制台自身加载。
- 所有演示资源由 SW 合成，包括 HTML、CSS、JavaScript、JSON API 和 BMP 图片，不依赖外部网络。
- 下载模型使用全局 FIFO 令牌桶，多个并发请求共享一条模拟链路，而不是每个请求独占配置带宽。
- 首个 MSS 计入一次 RTT；后续内容按配置带宽发送；丢包会产生重传 RTT，并额外消耗链路容量。
- SW 在 `fetch`、缓存查找、请求发送、首字节、响应结束等阶段生成时间点并广播给页面。
- Canvas 使用 SW 时钟绘制完整瀑布；DCL 和 onload 使用 iframe Performance Timing，并通过 `workerStart - SW fetch start` 做时钟偏移对齐。
- “Performance API 校验”表并排展示 SW 耗时、Resource Timing 耗时、编码大小和 SW 大小。
- `stale-while-revalidate` 的后台刷新以单独时序和瀑布行显示，不计入前台首屏完成时间。

## 缓存策略对比建议

1. 选择 3G，保持冷/热两轮开启。
2. 分别选择 `network-only`、`cache-first`、`network-first`、`stale-while-revalidate`。
3. 每次运行后点击“保存当前结果”。
4. 对比热轮总耗时、onload、传输量和缓存命中数。

典型结果：

- `network-only`：每轮都走完整网络，冷/热差异不明显。
- `cache-first`：冷轮网络下载并写缓存，热轮几乎瞬时且网络传输接近 0。
- `network-first`：在线时热轮仍刷新；断网时命中旧缓存降级。
- `stale-while-revalidate`：热轮先立即使用缓存，后台刷新行继续占网络但不阻塞前台。
- `cache-only`：空缓存时展示断网/未命中降级；已有缓存时完全离线可加载。

## 断网验收

勾选“模拟断网”后重新加载：

- `network-only` 显示红色 SW 降级页面，顶部出现断网提示。
- `cache-first` 冷轮显示降级；先在线冷加载一次，再断网热轮可从缓存恢复。
- `network-first` 会在断网时自动使用旧缓存。
- `stale-while-revalidate` 有缓存时离线展示缓存内容且不发起后台刷新。
- `cache-only` 只读取缓存，适合纯离线模式验证。

## 文件

- `index.html`：控制台布局。
- `style.css`：控制台样式。
- `app.js`：SW 注册、配置下发、运行编排、Performance API 采集、Canvas 图表和快照。
- `sw.js`：请求拦截、网络模型、丢包模型、缓存策略、离线降级和时序广播。
