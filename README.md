# hongguo-web · 网页版红果短剧（Docker 部署）

[![docker](https://github.com/kid941005/hongguo-web/actions/workflows/docker.yml/badge.svg)](https://github.com/kid941005/hongguo-web/actions/workflows/docker.yml)
[![license](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)

一个可自托管的短剧网页播放器：自带「红果短剧」内置源（服务端解密直链播放，无需客户端），并预留与**糖葫芦（THLRedGuo / CatPaw）同款格式的 JS 源**接口——把单文件 `spider` 源丢进来即可多源聚合。

- 前端：原生 JS 单页（暗色响应式），HLS 由内置 hls.js 播放，MP4 直连
- 后端：Node.js（ESM），账号数据存 SQLite（`node:sqlite`）；源与配置落在 `DATA_DIR`
- 容器：`node:22-bookworm-slim`，非 root 运行，`read_only` + `cap_drop: ALL` 加固

## 1. 快速开始（docker compose）

### 1.1 前置条件

- Docker Engine 20.10+ 或 Docker Desktop（自带 `docker compose` v2）：`docker compose version` 能输出版本即可
- 能访问 `ghcr.io`：镜像已设为 Public，直接拉取无需登录（拉取慢可先 `docker login ghcr.io`，或走 1.6 从源码构建）

### 1.2 三步启动

```bash
git clone https://github.com/kid941005/hongguo-web.git
cd hongguo-web
docker compose up -d        # 默认使用已发布镜像 ghcr.io/kid941005/hongguo-web:latest
```

首次会拉取镜像，并创建容器 `hongguo-web` 与命名卷 `hongguo-data`。浏览器打开 <http://localhost:8787> 即可。端口、访问口令等全部直接写在 [compose.yaml](compose.yaml) 里，需要调整就先改再启动（见 1.4）。

### 1.3 确认部署成功

```bash
docker compose ps                        # STATUS 里应出现 running (healthy)
docker compose logs -f                   # 实时日志，Ctrl+C 退出
curl -s http://localhost:8787/health     # {"service":"hongguo-web","ok":true,"version":"0.5.6","active":"hongguo","sources":7,"accounts":true}
```

`healthy` 来自 compose 里的 healthcheck：每 30 秒请求一次 `/health`，连续 3 次失败会标记为 unhealthy。

### 1.4 改配置（直接改 compose.yaml）

所有值都在 [compose.yaml](compose.yaml) 里，改完执行 `docker compose up -d` 生效。

| 需求 | 做法 |
| --- | --- |
| 换宿主机端口 | `ports` 改成 `"9000:8787"`（左边是宿主机端口，右边是容器端口） |
| 连容器端口一起换 | 同时把 `environment.PORT` 与 `ports` 右边改成同一个值（如都改 9000） |
| 加访问口令 | `environment.TOKEN: "你的口令"`；浏览器首次访问 `http://<host>:8787/?token=你的口令`，之后前端会记住，播放/封面等媒体地址也会自动带 `?token=` |
| 放大并发播放 | `environment.MAX_STREAMS: "12"` |
| 允许代理内网媒体 | `environment.ALLOW_PRIVATE_MEDIA: "1"`（默认 `"0"` 拒绝，防 SSRF） |
| 改时区 | `environment.TZ: "Asia/Shanghai"` |

### 1.5 不克隆代码，直接跑

任意空目录里新建 `compose.yaml`，粘最小示例，然后 `docker compose up -d`：

```yaml
services:
  hongguo-web:
    image: ghcr.io/kid941005/hongguo-web:latest
    ports: ["8787:8787"]
    environment:
      TOKEN: ""                      # 需要访问口令就填
    volumes: ["hongguo-data:/app/data"]
    restart: unless-stopped
volumes:
  hongguo-data:
```

### 1.6 从源码构建 / 不用 compose

要从源码构建镜像：把 `compose.yaml` 的 `image:` 注释掉、取消 `build: .` 的注释，再 `docker compose up -d --build`。

完全不用 compose 也可以：

```bash
docker build -t hongguo-web .
docker run -d --name hongguo-web \
  -p 8787:8787 \
  -e PORT=8787 -e HOST=0.0.0.0 \
  -e DATA_DIR=/app/data -e SOURCES_DIR=/app/sources/builtin \
  -e TZ=Asia/Shanghai -e TOKEN= \
  -e MAX_STREAMS=6 -e ALLOW_PRIVATE_MEDIA=0 \
  -v hongguo-data:/app/data \
  --restart unless-stopped \
  --read-only --tmpfs /tmp --security-opt no-new-privileges --cap-drop ALL \
  hongguo-web
```

上面的端口、环境变量、数据卷和安全选项与 [compose.yaml](compose.yaml) 对应（示例只列常用项，未列出的变量使用默认值），要改哪项直接改对应的 `-e` 或 `-p`。

### 1.7 升级与停止

```bash
docker compose pull && docker compose up -d   # 换了 tag 或镜像有更新时重建（数据保留）
docker compose down                           # 停止并删除容器，数据卷保留
docker compose down -v                        # 连数据卷一起删（会丢失导入的源与配置）
```

### 1.8 镜像从哪来（GHCR）

镜像由仓库自带的构建工作流 [.github/workflows/docker.yml](.github/workflows/docker.yml) 产出：push 到 `main` 推 `:edge`，打 `v*` 标签同时推 `:版本` 与 `:latest`，多架构 `linux/amd64` + `linux/arm64`，层缓存走 GHA。构建记录见 Actions 页，镜像在 GitHub Packages。也可以直接：

```bash
docker run -d --name hongguo-web \
  -p 8787:8787 \
  -e PORT=8787 -e HOST=0.0.0.0 \
  -e DATA_DIR=/app/data -e SOURCES_DIR=/app/sources/builtin \
  -e TZ=Asia/Shanghai -e TOKEN= \
  -e MAX_STREAMS=6 -e ALLOW_PRIVATE_MEDIA=0 \
  -v hongguo-data:/app/data \
  --restart unless-stopped \
  --read-only --tmpfs /tmp --security-opt no-new-privileges --cap-drop ALL \
  ghcr.io/kid941005/hongguo-web:latest  # 想固定版本可写 :0.5.6
```

参数与 [compose.yaml](compose.yaml) 对应（示例省略了 `ALLOW_PRIVATE_FETCH` 与源自动更新变量，未写时使用默认值），只是不经过 compose。

GHCR 包已设为 Public，可直接 `docker pull`（多架构 linux/amd64 + linux/arm64）；若遇拉取限流或私有仓库，先 `docker login ghcr.io` 再拉。

## 2. 环境变量

以下变量都在 [compose.yaml](compose.yaml) 的 `environment` 里设置；从源码直接跑时也可用同名环境变量覆盖。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `/app/data` | 配置、用户源、源更新状态与账号数据库（`hongguo.db`）目录（需可写，建议挂持久卷） |
| `SOURCES_DIR` | `/app/sources/builtin` | 内置源目录 |
| `TOKEN` | 空 | 设置后所有 `/api/*` 需带 `Authorization: Bearer <TOKEN>` 或 `?token=<TOKEN>`；浏览器打开 `http://<host>:8787/?token=<TOKEN>` 一次即可，前端会记住，并自动给 `/api/media`、`/api/hls`、`/api/stream` 等媒体地址追加 token |
| `MAX_STREAMS` | `6` | 内置红果解密流的最大并发数 |
| `ALLOW_PRIVATE_MEDIA` | 空 | 设为 `1` 时允许 `/api/media`、`/api/hls` 代理内网地址（默认拒绝，防 SSRF） |
| `ALLOW_PRIVATE_FETCH` | 空 | 设为 `1` 时允许 JS 源脚本 `fetch` 与按 URL 导入源访问内网地址（默认拒绝，防 SSRF） |
| `SOURCE_WORKER_MAX_OLD_MB` | `64` | 每个 JS 源沙箱线程的 V8 老生代内存上限（MB，最小 32）；超限自动终止该源 |
| `SOURCE_WORKER_MAX_YOUNG_MB` | `16` | 每个 JS 源沙箱线程的 V8 新生代内存上限（MB，最小 8） |
| `SOURCE_WORKER_STACK_MB` | `4` | 每个 JS 源沙箱线程的栈上限（MB，最小 2） |
| `SOURCE_AUTO_UPDATE` | `1` | 启动后自动检查 JS 源上游更新；设为 `0` 关闭（内置红果解密源不参与） |
| `SOURCE_UPDATE_INTERVAL_HOURS` | `6` | 自动检查间隔（小时，最小 1） |
| `SOURCE_UPDATE_START_DELAY_SECONDS` | `15` | 启动后首次检查延迟（秒） |

## 3. 使用

- **切换源**：顶栏「源」下拉框；内置红果 + 随包附带的七猫/西饭/星芽/牛牛等 JS 源。
- **聚合搜索**：下拉框选「🔎 全部源（聚合搜索）」后搜索，会并发查询所有源并按源交错合并，卡片左上角带源名徽标；点开卡片时自动带上它所属的源。顶部提示条会列出每个源命中多少条、哪些源失败。
- **源管理**：点「⚙ 源」打开面板，可看每个源的版本/类型/是否使用中，一键启用、展开最近运行日志、删除导入源（内置源不可删）。有上游地址的源会显示「自动更新」开关，面板底部「检查源更新」可立即检查全部源；更新失败只记录错误并保留旧版本。
- **导入源**：点「＋源」，粘贴源文件 URL 或直接粘贴 JS 源码。导入后即时出现在下拉框里。按 URL 导入的源会记住地址并默认自动更新（仅 HTTPS）；直接粘贴源码的源若 meta 里带 `updateUrl` 也会自动更新。
- **推荐页**：顶栏「🔥 推荐」，把内置红果四个榜单（热播 / 真人 / 漫剧 / AI）按真实评分合并排序，卡片右上角显示「★ 9.5」评分，可一直向下浏览。
- **无限滚动**：首页、分类、搜索结果和推荐页滑到底部会自动加载下一页；「加载更多」按钮仍保留作为兜底（自动加载不可用时手动点）。
- **搜索**：输入关键词回车。红果内置源的官方搜索接口被风控，会自动降级为「首页推荐池检索」（结果偏少，界面会提示）；JS 源走各自搜索接口，完整可用。
- **播放**：点卡片 → 详情页选集。多线路时先选线路。播放器支持 HLS（m3u8，含多码率清晰度切换）与 MP4 直链；FLV 没有对应播放器，源里返回 flv 会播不了。
- **账号（可选）**：顶栏「登录」注册/登录（用户名 3–20 位中英文数字下划线，密码 6–64 位）。账号只用来同步下面的个人数据，不登录也能正常看剧。
- **观看历史 / 续播**：播放进度会记住（每 5 秒、暂停、关闭播放器时落盘，上限 100 条）。详情页顶部出现「上次看到 第N集 12:34 / 20:50（60%）」续播条，点「继续播放」直接跳到上次位置；已看过的集变暗、当前集高亮。顶栏「🕘 历史」可查看/续播/删除/清空。登录后历史同步到服务端，换设备登录同一账号即可接着看。
- **收藏 / 追剧提醒**：详情页「☆ 收藏」「🔔 追更」；顶栏「☆ 收藏」「🔔 追剧」打开列表。追更会定时（默认 10 分钟，打开面板或页面重新可见时也会）检查集数变化，有新集时角标显示新增集数并弹出提示，面板里点「检查更新」可立即检查。
- **多设备同步**：历史、收藏、追更都存在服务端 SQLite（`DATA_DIR/hongguo.db`）。本地历史与服务端按时间戳取新合并，旧进度不会覆盖新进度。
- **PWA（装到桌面/手机主屏）**：Chrome/Edge 地址栏右侧会出现「安装」；手机浏览器「添加到主屏幕」后以独立窗口运行。Service Worker 需要安全上下文（`http://localhost` 或 HTTPS），用局域网 IP 的纯 HTTP 打开时页面可用但没有离线缓存、不能安装。
- **播放器**：倍速 0.5×–2×（点 `1.0×` 循环，选择记在 localStorage）、清晰度切换（仅 HLS 多码率源出现，单码率自动隐藏）、全屏（按钮 / 双击画面 / F 键）。
- **深链**：`/?rec=1`（直接打开推荐页）、`/?source=qimao`、`/?source=__all&q=总裁`、`/?source=qimao&id=5207`、`/?source=qimao&id=5207&ep=0`（直接播放第 N 集，从 0 开始计数）。

## 3.1 前端存储

| key | 位置 | 内容 |
| --- | --- | --- |
| `hg_watch_v1` | 浏览器 localStorage | 观看历史（source/id/title/cover/lineIdx/epIdx/pos/dur/at），最多 100 条；登录后同步到服务端（未登录只存本地） |
| `hg_rate_v1` | 浏览器 localStorage | 上次选择的播放倍速 |
| `hg_user_token` | 浏览器 localStorage | 登录令牌（30 天有效），退出登录即清除 |

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
├─ .github/workflows/docker.yml  # 镜像构建工作流（GHCR，main→:edge，tag→:版本+:latest）
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
│  ├─ net.mjs              # 出站 URL/DNS 校验与安全请求（SSRF/DNS Rebinding 防护，供媒体/源/导入复用）
│  ├─ db.mjs               # SQLite（node:sqlite）：用户/令牌/历史/收藏/追更
│  ├─ users.mjs            # 账号与个人数据读写（UserStore）
│  ├─ http.mjs             # 路由表、鉴权、请求分发
│  └─ sources/
│     ├─ runtime.mjs       # 单文件 JS 源的沙箱运行时装配（每源独立 worker_threads，仅消息通道暴露 fetch）
│     ├─ worker.mjs        # 源沙箱线程：node:vm 上下文 + resourceLimits，执行源并回传结果/日志
│     ├─ manager.mjs       # 源的扫描/安装/删除/启用/自动更新
│     └─ shims.js          # fetch/HTML 解析垫片（对齐 App 内 CatPaw 运行时）
├─ sources/builtin/        # 内置 JS 源：qimao / xifan / xingya / niuniu / template / maccms
└─ web/                    # 前端静态页 + hls.js + PWA（manifest / sw.js / icons/）
```

## 5. 自定义 JS 源格式（糖葫芦同款）

源是**单个 .js 文件**，声明一个全局 `spider` 对象。每个源在独立的 `worker_threads` 线程里运行（内存上限默认 64 MB，调用超时会直接终止该源线程），只通过消息通道获得 `fetch`，拿不到 `require`/`process`/文件系统等 Node API。

```js
var spider = {
  id: "my_source",        // 唯一 id
  name: "我的源",          // 显示名
  version: "1.0.0",       // 可选；给了就必须是 x.y.z
  updateUrl: "https://example.com/my_source.js",  // 可选；HTTPS 上游地址，用于自动更新
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
      vod_tag: "都市/甜宠",                                     // 可选，多个用 / 分隔
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
- `updateUrl` 必须是 HTTPS 且返回同一个 `id` 的源；更新前会先跑一次 `home` 自检，失败则保留旧版本。按 URL 导入时即使 meta 没写 `updateUrl`，也会用导入地址作为上游。
- `play` 返回**可直连**的 `m3u8` / `mp4`（`flv` 能识别但没有播放器）。若返回 `parse: 1`（需要 webview 嗅探），本服务**不支持**，会报「需要 webview 嗅探解析」。
- 除上述方法外还可选实现 `feed / rankings / recommendations / rankingBoards / seriesSeasons / danmaku` 等（本服务目前只用核心方法）。
- 不得 `import` / `require`，不得访问 Node 内置模块或文件系统。

## 6. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（含 `accounts` 是否启用账号系统） |
| POST | `/api/auth/register` | 注册：`{ "username": "…", "password": "…" }` → `{ token, user }` |
| POST | `/api/auth/login` | 登录：同上 → `{ token, user }` |
| POST | `/api/auth/logout` | 注销当前令牌 |
| GET | `/api/auth/me` | 当前用户 |
| GET/PUT/DELETE | `/api/me/history` | 云端观看历史：GET 列表 / PUT 上报一条 / DELETE 清空 |
| DELETE | `/api/me/history/:source/:id` | 删除一条历史 |
| GET/POST | `/api/me/favorites` | 收藏列表 / 新增（`{source,id,title,cover,remarks}`） |
| DELETE | `/api/me/favorites/:source/:id` | 取消收藏 |
| GET/POST | `/api/me/follows` | 追剧列表 / 新增（`{source,id,title,cover}`） |
| DELETE | `/api/me/follows/:source/:id` | 取消追剧 |
| GET | `/api/me/follows/updates?force=1` | 检查追更（默认 10 分钟节流），返回 `{updates:[{source,id,title,added,epCount}],follows}` |
| GET | `/api/sources` | 源列表 + 当前启用源 |
| POST | `/api/sources/import` | 导入源：`{ "url": "…" }` 或 `{ "code": "…" }` |
| POST | `/api/sources/active` | 切换启用源：`{ "id": "qimao" }` |
| GET | `/api/sources/:id/log` | 源最近运行日志 |
| DELETE | `/api/sources/:id` | 删除用户源（内置源不可删） |
| POST | `/api/sources/check-updates` | 立即检查所有可自动更新的 JS 源（`{ "force": false }` 走 ETag） |
| POST | `/api/sources/:id/check-update` | 立即检查单个源更新 |
| POST | `/api/sources/:id/auto-update` | 开关单个源自动更新：`{ "enabled": true }` |
| GET | `/api/home?source=&page=` | 首页（`classes` + `items`） |
| GET | `/api/recommend?page=` | 推荐页：内置红果四榜单按真实评分合并排序（`items[].score/heat/bang`） |
| GET | `/api/category?source=&tid=&page=` | 分类列表 |
| GET | `/api/search?source=&q=&page=` | 搜索；`source=__all`（或 `all=1`）为多源聚合，返回 `{aggregate:true, groups:[{source,name,count,ms,hasMore,error}]}` |
| GET | `/api/detail?source=&id=` | 详情（含标签、线路与剧集） |
| GET | `/api/play?source=&flag=&id=` | 取播放地址（返回 `{type,url}`） |
| GET | `/api/media?u=&r=&token=` | 媒体透传（支持 Range，`r` 为 Referer，`token` 为应用访问口令） |
| GET | `/api/hls?u=&r=&token=` | HLS 清单重写（分片走 `/api/media`，自动带上 token） |
| GET/HEAD | `/api/stream/:epId?token=` | 内置红果分集流（服务端解密 + Range） |

个人数据接口（`/api/me/*`、`/api/auth/me`、`/api/auth/logout`）需要登录，请求头带 `X-Auth-Token: <token>`；应用级 `TOKEN` 支持 `Authorization: Bearer` 或 `?token=`（媒体/流地址由前端自动追加）。

所有错误统一返回 `{ "error": "…", "code": "…" }`。常见 code：`BAD_INPUT` / `BAD_JSON` / `BAD_URL`（400）、`USER_EXISTS`（409）、`UNAUTHORIZED`（401）、`PROTECTED`（403）、`NOT_FOUND`（404）、`RATE_LIMITED`（429，注册/登录过于频繁）、`BUSY`（503，并发流已满）、`TIMEOUT`（504），其余上游问题为 502。

## 7. 已知限制

- **内置红果搜索**：官方搜索接口已被风控，降级为首页推荐池检索（`fallback: true`，结果不全）。需要完整搜索请用 JS 源。
- **需要 webview 嗅探的源**（`parse: 1`）不可用：本服务没有浏览器内核。
- **同时播放上限**：内置红果解密流默认最多 6 路并发（`MAX_STREAMS` 可调）。
- **红果内置流是 HEVC 1080×1920**：需要浏览器支持 HEVC/H.265 解码（Edge、Chrome 在支持硬解的机器上正常，实测 Edge 可直接播放）；缺 HEVC 支持的环境会黑屏或报解码错误，可改用 JS 源。
- **账号数据库**：用户、令牌、历史、收藏、追更都存 `DATA_DIR/hongguo.db`（SQLite，WAL 模式）。`DATA_DIR` 必须挂持久卷，否则重建容器会丢账号数据；备份直接拷这个文件即可（建议先停容器）。
- **PWA 需要安全上下文**：Service Worker 只在 `https://` 或 `http://localhost` 下启用；用局域网 IP 的纯 HTTP 访问时页面照常可用，但没有离线缓存、也不能安装。
- **清晰度切换依赖源**：只有提供 master playlist（多 `#EXT-X-STREAM-INF`）的 HLS 源才有清晰度可切；单码率 HLS 与 MP4 直链没有可选清晰度，按钮会自动隐藏。
- **推荐页首次加载慢**：需要抓取红果四个榜单共 20 页（约 10 秒），结果在服务端缓存 10 分钟，之后翻页很快；单页抓取失败只丢当页，不影响整体。
- **聚合搜索耗时**：受最慢的源制约（单源超时：搜索 60s、首页/分类/详情 40s、聚合里的内置红果 30s），源多时首屏会慢；已按源交错合并，不会让某个源霸屏。
- **JS 源默认禁止访问内网**：恶意源可能借 `fetch` 探测内网，默认只允许公网 http(s)；确有内网源自建需求时设 `ALLOW_PRIVATE_FETCH=1`。
- **JS 源沙箱**：每个 JS 源在独立 `worker_threads` 线程内运行，默认 64 MB 内存上限；死循环/超时或内存超限会自动终止该源线程，不影响主服务，下次调用自动重启。单次同步执行超过 5 秒会被中断，防止死循环占满 CPU。可用 `SOURCE_WORKER_MAX_OLD_MB` 等变量调整。
- **源自动更新**：只对 HTTPS 上游生效；内置红果解密源不在自动更新范围内（它依赖服务端解密模块，需随镜像升级）。更新失败会保留旧版本并记录原因，可在源管理面板查看。
- 仅供个人学习与自用；内容版权归各平台所有，请勿用于商业分发。

## 8. 截图

首页与播放器（全屏）：

| 首页 | 推荐页 | 全屏播放 | 手机端 |
| --- | --- | --- | --- |
| ![首页](docs/screenshots/home.png) | ![推荐](docs/screenshots/recommend.png) | ![全屏](docs/screenshots/fullscreen.png) | ![手机端](docs/screenshots/mobile.png) |

## 9. 许可

- 本项目代码：[GPL-3.0-only](LICENSE)。
- `server/vendor/hongguo.cjs` 派生自 [drpys](https://github.com/drpys) 的实现，遵循 GPL，详见 `server/vendor/LICENSE.drpys`、`LICENSE.template-tv`、`NOTICE.md`。
- 上游调研与可行性验证过程见 [docs/research.md](docs/research.md)。
