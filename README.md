# hongguo-web · 网页版红果短剧（Docker 部署）

[![docker](https://github.com/kid941005/hongguo-web/actions/workflows/docker.yml/badge.svg)](https://github.com/kid941005/hongguo-web/actions/workflows/docker.yml)
[![license](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)

一个可自托管的短剧网页播放器：自带「红果短剧」内置源（服务端解密直链播放，无需客户端），并预留与**糖葫芦（THLRedGuo / CatPaw）同款格式的 JS 源**接口——把单文件 `spider` 源丢进来即可多源聚合。

- 前端：原生 JS 单页（暗色响应式），HLS 由内置 hls.js 播放，MP4 直连
- 后端：Node.js（ESM），无数据库；源与配置落在 `DATA_DIR`
- 容器：`node:22-bookworm-slim`，非 root 运行，`read_only` + `cap_drop: ALL` 加固

## 1. 快速开始（Docker）

```bash
git clone https://github.com/kid941005/hongguo-web.git
cd hongguo-web
docker compose up -d --build
```

打开 <http://localhost:8787>。

修改端口：编辑 `compose.yaml` 里的 `ports: "8787:8787"`（左侧为宿主机端口）。

源与配置保存在命名卷 `hongguo-data`（容器内 `/app/data`），升级/重建不丢：

```bash
docker compose down          # 保留数据
docker compose up -d --build # 重新构建
```

### 不用 compose

```bash
docker build -t hongguo-web .
docker run -d --name hongguo-web -p 8787:8787 -v hongguo-data:/app/data hongguo-web
```

### 直接用现成镜像（GHCR）

仓库自带镜像构建工作流 [ci/docker.yml](ci/docker.yml)（打 tag 构建 linux/amd64 + linux/arm64 并推 GHCR，main 推 `:edge`）。

> 该文件需要放到 `.github/workflows/` 才会生效；GitHub 要求推送工作流文件的 token 具备 `workflow` scope，首次请执行：
> ```bash
> gh auth refresh -h github.com -s workflow
> mkdir -p .github/workflows && git mv ci/docker.yml .github/workflows/docker.yml && git commit -m "ci: enable docker workflow" && git push
> ```

镜像发布后：

```bash
docker run -d --name hongguo-web -p 8787:8787 -v hongguo-data:/app/data \
  ghcr.io/kid941005/hongguo-web:latest
```

若拉取提示无权限（包默认私有），在仓库的 Package 设置里把可见性改成 Public，或先 `docker login ghcr.io`。

## 2. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `/app/data` | 配置 + 用户源目录（需可写） |
| `SOURCES_DIR` | `/app/sources/builtin` | 内置源目录 |
| `TOKEN` | 空 | 设置后所有 `/api/*` 需带 `Authorization: Bearer <TOKEN>`；浏览器打开 `http://<host>:8787/?token=<TOKEN>` 一次即可，前端会记住 |
| `MAX_STREAMS` | `6` | 内置红果解密流的最大并发数 |
| `ALLOW_PRIVATE_MEDIA` | 空 | 设为 `1` 时允许 `/api/media`、`/api/hls` 代理内网地址（默认拒绝，防 SSRF） |

## 3. 使用

- **切换源**：顶栏「源」下拉框；内置红果 + 随包附带的七猫/西饭等 JS 源。
- **聚合搜索**：下拉框选「🔎 全部源（聚合搜索）」后搜索，会并发查询所有源并按源交错合并，卡片左上角带源名徽标；点开卡片时自动带上它所属的源。顶部提示条会列出每个源命中多少条、哪些源失败。
- **源管理**：点「⚙ 源」打开面板，可看每个源的版本/类型/是否使用中，一键启用、展开最近运行日志、删除导入源（内置源不可删）。
- **导入源**：点「＋源」，粘贴源文件 URL 或直接粘贴 JS 源码。导入后即时出现在下拉框里。
- **搜索**：输入关键词回车。红果内置源的官方搜索接口被风控，会自动降级为「首页推荐池检索」（结果偏少，界面会提示）；JS 源走各自搜索接口，完整可用。
- **播放**：点卡片 → 详情页选集。多线路时先选线路。播放器支持 HLS（m3u8，含多码率清晰度切换）与 MP4 直链；FLV 没有对应播放器，源里返回 flv 会播不了。
- **观看历史 / 续播**：播放进度存在浏览器 localStorage（每 5 秒、暂停、关闭播放器时落盘，上限 100 条）。详情页顶部会出现「上次看到 第N集 12:34 / 20:50（60%）」续播条，点「继续播放」直接跳到上次的位置；已看过的集在选集区变暗，当前集高亮。顶栏「🕘 历史」可查看/续播/删除记录或清空。
- **播放器**：倍速 0.5×–2×（点 `1.0×` 循环，选择记在 localStorage）、清晰度切换（仅 HLS 多码率源出现，单码率自动隐藏）、全屏（按钮 / 双击画面 / F 键）。
- **深链**：`/?source=qimao`、`/?source=__all&q=总裁`、`/?source=qimao&id=5207`、`/?source=qimao&id=5207&ep=0`（直接播放第 N 集，从 0 开始计数）。

## 3.1 前端存储

| key | 位置 | 内容 |
| --- | --- | --- |
| `hg_watch_v1` | 浏览器 localStorage | 观看历史（source/id/title/cover/lineIdx/epIdx/pos/dur/at），最多 100 条，不上传服务器 |
| `hg_rate_v1` | 浏览器 localStorage | 上次选择的播放倍速 |

## 3.2 播放器快捷键

| 按键 | 作用 |
| --- | --- |
| `空格` / `K` | 播放 / 暂停 |
| `←` / `→` | 后退 / 前进 5 秒 |
| `↑` / `↓` | 音量 ±10% |
| `M` | 静音切换 |
| `F` | 全屏 / 退出全屏（双击画面同效） |
| `,` / `.` | 减速 / 加速（0.5× → 2×） |
| `N` | 下一集 |

快捷键在播放器打开时生效；焦点在输入框（搜索框、导入框）里时不拦截按键。

## 4. 目录结构

```
hongguo-web/
├─ Dockerfile / compose.yaml / .dockerignore
├─ LICENSE                 # GPL-3.0 全文
├─ ci/docker.yml           # 镜像构建工作流（放到 .github/workflows/ 生效）
├─ docs/                   # research.md（上游调研）+ screenshots/
├─ server/
│  ├─ index.mjs            # 入口：装配 provider + 源管理 + 目录 + HTTP
│  ├─ provider.mjs         # 内置红果：home/search/detail/stream（服务端分块解密）
│  ├─ vendor/hongguo.cjs   # 红果解析核心（drpys 派生，GPL，见 LICENSE*）
│  ├─ catalog.mjs          # 统一目录层：把内置源与 JS 源归一成同一套 API
│  ├─ media.mjs            # /api/media 透传（支持 Range）、/api/hls 清单重写
│  ├─ stream.mjs           # /api/stream 内置解密流（Range + 并发上限）
│  ├─ static.mjs           # 静态文件托管（越界校验、MIME、HEAD）
│  ├─ errors.mjs           # 错误码 → HTTP 状态映射与对外文案
│  ├─ http.mjs             # 路由表、鉴权、请求分发
│  └─ sources/
│     ├─ runtime.mjs       # 单文件 JS 源的沙箱运行时（node:vm）
│     ├─ manager.mjs       # 源的扫描/安装/删除/启用
│     └─ shims.js          # fetch/HTML 解析垫片（对齐 App 内 CatPaw 运行时）
├─ sources/builtin/        # 内置 JS 源：qimao / xifan / template / maccms
└─ web/                    # 前端静态页 + hls.js
```

## 5. 自定义 JS 源格式（糖葫芦同款）

源是**单个 .js 文件**，声明一个全局 `spider` 对象。运行时只提供必要的垫片，不提供 Node API。

```js
var spider = {
  id: "my_source",        // 唯一 id
  name: "我的源",          // 显示名
  version: "1.0.0",       // 可选；给了就必须是 x.y.z
  init: function (extend) {},                                   // 可选
  home: function (filter, isFirst) {                            // 首页：分类 + 推荐
    return { class: [{ type_id: "1", type_name: "全部" }], list: [] };  // list 可省略，服务端会用第一个分类兜底
  },
  category: function (tid, page, filter, extend) {              // 分类列表（分页）
    return { page: page, pagecount: page + 1, hasMore: true,
             list: [{ vod_id: "id1", vod_name: "剧名", vod_pic: "https://…", vod_remarks: "更新至10集" }] };
  },
  detail: function (id) {                                       // 详情 + 播放串
    return { list: [{ vod_id: id, vod_name: "剧名",               // 必须放 list[0]，返回 {vod:{...}} 不被识别
      vod_play_from: "线路A",                                   // 多个用 $$$
      vod_play_url: "第1集$ep1#第2集$ep2" }] };                  // 集用 #，集名与集ID 用 $
  },
  search: function (wd, quick, page) {                          // 搜索（分页）
    return { page: page, pagecount: page + 1, hasMore: false, list: [] };
  },
  play: function (flag, id, flags) {                            // 取播放地址
    return "https://example.com/stream.m3u8";                   // 或 { url, header }
  }
};
```

要点：

- 有网可用 `await fetch(url, { headers, timeoutMs })`；`html.parse(...)` 可用（支持 `tag`、`.class`、`#id`、`tag.class`、空格后代选择器）。
- `play` 返回**可直连**的 `m3u8` / `mp4`（`flv` 能识别但没有播放器）。若返回 `parse: 1`（需要 webview 嗅探），本服务**不支持**，会报「需要 webview 嗅探解析」。
- 除上述方法外还可选实现 `feed / rankings / recommendations / rankingBoards / seriesSeasons / danmaku` 等（本服务目前只用核心方法）。
- 不得 `import` / `require`，不得访问 Node 内置模块或文件系统。

## 6. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/api/sources` | 源列表 + 当前启用源 |
| POST | `/api/sources/import` | 导入源：`{ "url": "…" }` 或 `{ "code": "…" }` |
| POST | `/api/sources/active` | 切换启用源：`{ "id": "qimao" }` |
| GET | `/api/sources/:id/log` | 源最近运行日志 |
| DELETE | `/api/sources/:id` | 删除用户源（内置源不可删） |
| GET | `/api/home?source=&page=` | 首页（`classes` + `items`） |
| GET | `/api/category?source=&tid=&page=` | 分类列表 |
| GET | `/api/search?source=&q=&page=` | 搜索；`source=__all`（或 `all=1`）为多源聚合，返回 `{aggregate:true, groups:[{source,name,count,ms,hasMore,error}]}` |
| GET | `/api/detail?source=&id=` | 详情（含线路与剧集） |
| GET | `/api/play?source=&flag=&id=` | 取播放地址（返回 `{type,url}`） |
| GET | `/api/media?u=&r=` | 媒体透传（支持 Range，`r` 为 Referer） |
| GET | `/api/hls?u=&r=` | HLS 清单重写（分片走 `/api/media`） |
| GET/HEAD | `/api/stream/:epId` | 内置红果分集流（服务端解密 + Range） |

所有错误统一返回 `{ "error": "…", "code": "…" }`。常见 code：`BAD_INPUT` / `BAD_JSON`（400）、`UNAUTHORIZED`（401）、`PROTECTED`（403）、`NOT_FOUND`（404）、`BUSY`（503，并发流已满）、`TIMEOUT`（504），其余上游问题为 502。

## 7. 已知限制

- **内置红果搜索**：官方搜索接口已被风控，降级为首页推荐池检索（`fallback: true`，结果不全）。需要完整搜索请用 JS 源。
- **需要 webview 嗅探的源**（`parse: 1`）不可用：本服务没有浏览器内核。
- **同时播放上限**：内置红果解密流默认最多 6 路并发（`MAX_STREAMS` 可调）。
- **观看历史仅存本地**：换浏览器/清缓存即丢失，多设备不同步（没有账号体系）。
- **清晰度切换依赖源**：只有提供 master playlist（多 `#EXT-X-STREAM-INF`）的 HLS 源才有清晰度可切；单码率 HLS 与 MP4 直链没有可选清晰度，按钮会自动隐藏。
- **聚合搜索耗时**：受最慢的源制约（单源超时：搜索 60s、首页/分类/详情 40s、聚合里的内置红果 30s），源多时首屏会慢；已按源交错合并，不会让某个源霸屏。
- 仅供个人学习与自用；内容版权归各平台所有，请勿用于商业分发。

## 8. 截图

首页与播放器（全屏）：

| 首页 | 全屏播放 |
| --- | --- |
| ![首页](docs/screenshots/home.png) | ![全屏](docs/screenshots/fullscreen.png) |

## 9. 许可

- 本项目代码：[GPL-3.0-only](LICENSE)。
- `server/vendor/hongguo.cjs` 派生自 [drpys](https://github.com/drpys) 的实现，遵循 GPL，详见 `server/vendor/LICENSE.drpys`、`LICENSE.template-tv`、`NOTICE.md`。
- 上游调研与可行性验证过程见 [docs/research.md](docs/research.md)。
