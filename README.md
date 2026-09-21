# 弱网模拟器（Service Worker 网络节流 + 请求瀑布可视化）

通过 Service Worker 拦截请求，模拟 2G / 3G / 4G / 丢包 / 断网，用 Canvas 绘制精确
的请求瀑布图，并支持自定义带宽、延迟、丢包率与多种缓存策略的对比实验。

## 快速开始

```bash
python3 serve.py          # 或 python3 -m http.server 8000
# 打开 http://localhost:8000
```

Service Worker 要求 `localhost` 或 HTTPS 环境，请勿直接用 `file://` 打开。

## 功能

- **网络预设**：2G（250Kbps/400ms/2%丢包）、3G、4G、离线，以及自定义
  带宽 / 延迟 / 丢包率滑杆
- **缓存策略**：`network-only` / `cache-first` / `network-first` /
  `stale-while-revalidate`，可一键清除 SW 缓存
- **请求瀑布**：Canvas 绘制，黄=等待（建连+首字节）、蓝=下载、绿=缓存命中、
  红=失败，悬停查看每请求的阶段耗时 / 大小 / 重传次数
- **性能对比**：运行历史表格记录每次总耗时 / 传输量 / 缓存命中 / 失败数，
  勾选两次运行可在同一瀑布图上对比
- **离线降级**：断网时测试页内显示降级横幅，图片替换为占位块，
  `network-first` 策略下自动回退缓存内容

## 技术要点

### 1. 节流模型（sw.js）
- **带宽**：响应体读入后按 `chunk ≈ 带宽×50ms` 分块，通过 `ReadableStream`
  以计算出的间隔推流，浏览器看到的下载速度与设定带宽一致
- **延迟**：响应前 sleep 一次带 ±25% 抖动的 RTT
- **丢包**：每个数据块按丢包率触发"重传"，代价为额外一次 RTT
- **断网**：直接返回 503，`network-first` 策略下回退 Cache API

### 2. SW 缓存绕过
SW 内回源统一使用 `fetch(req, { cache: 'no-store' })`，**绕过浏览器 HTTP
缓存**，保证每次"网络请求"都真实经过节流管道——否则第二次加载会被浏览器
缓存短路，不同网络下的对比将失真。缓存行为完全由所选策略通过 Cache API
显式控制，可复现、可对比。

### 3. 瀑布图精度
SW 与页面的 `performance.timeOrigin` 不同，无法直接对齐绝对时间戳。因此：
- 请求在时间轴上的**起点**取自页面侧 `PerformanceResourceTiming.startTime`
- **阶段时长**（等待 / 下载）由 SW 用 `performance.now()` 实测并 postMessage
  上报（下载时长在流真正消费完毕时测量）
- 二者按 URL 合并（每轮运行带唯一 `run` 参数，URL 天然唯一）

### 4. 请求时序
- 配置下发使用 MessageChannel 握手，**先确认 SW 收到配置，再加载 iframe**
- 每轮运行分配 `runId`，SW 上报按 `runId` 归组，避免跨轮串扰
- iframe `load` 事件后延迟 400ms 再采集，确保最后的 SW 消息送达

## 目录结构

```
index.html          控制面板
css/main.css        样式
js/app.js           主逻辑（配置下发、运行采集、数据合并、历史对比）
js/waterfall.js     Canvas 瀑布图渲染器
sw.js               Service Worker（节流 + 缓存策略 + 计时上报）
test-page.html      模拟目标站点（iframe 内加载）
js/test-page.js     目标站点逻辑（动态注入资源、离线降级）
assets/             测试资源（tools/gen_assets.py 生成，共约 950KB）
serve.py            本地静态服务器
```

## 验收自测

1. **切换网络页面加载明显变化**：4G → 2G 运行，总耗时从 <1s 变为 30s+
2. **瀑布图准确**：每行起点与 Performance API 一致，阶段时长与设定
   带宽/延迟吻合（如 400KB 图片在 250Kbps 下下载段 ≈ 13s）
3. **缓存策略可对比**：选 `cache-first` 连跑两次，第二次全部绿色命中、
   总耗时骤降；与 `network-only` 两次运行对比一目了然
4. **断网降级提示**：切离线运行，测试页顶部出现黄色降级横幅，
   失败图片显示占位块；先用 `network-first` 建缓存再断网，页面仍可完整展示
