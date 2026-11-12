# hongguo-web · 网页版红果短剧（Docker 自托管）

[![docker](https://github.com/kid941005/hongguo-web/actions/workflows/docker.yml/badge.svg)](https://github.com/kid941005/hongguo-web/actions/workflows/docker.yml)
[![release](https://img.shields.io/github/v/release/kid941005/hongguo-web)](https://github.com/kid941005/hongguo-web/releases)
[![license](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)

一个可自托管的短剧网页播放器。自带「红果短剧」内置源（服务端解密、浏览器直连播放，无需客户端），并预留与**糖葫芦（THLRedGuo / CatPaw）同款格式的 JS 源**接口——把单文件 `spider` 源丢进来即可多源聚合。

- 前端：原生 JS 单页（暗色、响应式），HLS 用内置 hls.js，MP4 直连
- 后端：Node.js（ESM），账号数据存 SQLite（`node:sqlite`）
- 容器：`node:22-bookworm-slim`，非 root、`read_only` + `cap_drop: ALL` 加固，镜像多架构（amd64 / arm64）

## 功能特性

| 分类 | 能力 |
| --- | --- |
| 内置红果源 | 服务端签名取址 + CENC 分块解密 + Range 转发；可播档位 1080P（HEVC）与 360P（H.264），不支持 HEVC 的浏览器自动回落 |
| JS 源（糖葫芦格式） | 单文件 `spider`，独立 worker 线程沙箱运行；网页内导入 / 自检 / 删除 / 自动更新 |
| 检索 | 首页分类、分类分页、搜索；**多源聚合搜索**（并发、先回先展示、逐源失败信息） |
| 发现 | 推荐页（四榜单真实评分合并）、猜你喜欢（协同过滤 + 相似题材 + 热门兜底） |
| 播放 | HLS 多码率切档、当前分辨率徽标、倍速、全屏、下一集预取；播放失败自动找替代源 |
| 个人数据 | 账号登录、观看历史 / 续播、收藏、追剧提醒、倍速偏好，跨设备同步 |
| 运维 | `/health`、`/api/metrics`、`/api/alerts` 通道监控、`/api/cache/clear` 一键清缓存、`/api/*` 访问日志、Webhook 告警 |
| 质量 | `server/selftest.mjs` 离线自测（130 断言），CI 构建镜像前先跑 |

## 目录

- [1. 快速开始](#1-快速开始)
- [2. 环境变量](#2-环境变量)
- [3. 使用指南](#3-使用指南)
- [4. 自定义 JS 源格式（糖葫芦同款）](#4-自定义-js-源格式糖葫芦同款)
- [5. HTTP API](#5-http-api)
- [6. 目录结构与离线自测](#6-目录结构与离线自测)
- [7. 已知限制](#7-已知限制)
- [8. 截图](#8-截图)
- [9. 许可](#9-许可)

## 1. 快速开始

### 1.1 前置条件

- Docker Engine 20.10+ 或 Docker Desktop（自带 `docker compose` v2）：`docker compose version` 能输出版本即可
- 能访问 `ghcr.io`：镜像已设为 Public，直接拉取无需登录（拉取慢可先 `docker login ghcr.io`，或按 1.6 从源码构建）

### 1.2 三步启动

```bash
git clone https://github.com/kid941005/hongguo-web.git
cd hongguo-web
docker compose up -d        # 默认使用 ghcr.io/kid941005/hongguo-web:latest
```

首次会拉取镜像，并创建容器 `hongguo-web` 与命名卷 `hongguo-data`。浏览器打开 <http://localhost:8787> 即可。端口、访问口令等都在 [compose.yaml](compose.yaml) 里，需要调整先改再启动（见 1.4）。

### 1.3 确认部署成功

```bash
docker compose ps                        # STATUS 里应出现 running (healthy)
docker compose logs -f                   # 实时日志，Ctrl+C 退出
curl -s http://localhost:8787/health     # {"service":"hongguo-web","ok":true,"version":"0.10.0","active":"hongguo","sources":7,"accounts":true}
```

`healthy` 来自 compose 的 healthcheck：每 30 秒请求一次 `/health`，连续 3 次失败标记 unhealthy。发布后还可以跑六项冒烟（health / 源列表 / 首页 / 猜你喜欢 / 源自检取流 / 播放监控）：

```bash
BASE=http://127.0.0.1:8787 node server/scripts/smoke.mjs
```

### 1.4 常用配置

所有值都在 [compose.yaml](compose.yaml) 里，改完 `docker compose up -d` 生效；完整变量表见 [第 2 节](#2-环境变量)。

| 需求 | 做法 |
| --- | --- |
| 换宿主机端口 | `ports` 改成 `9000:8787`（左=宿主机，右=容器） |
| 连容器端口一起换 | `environment.PORT` 与 `ports` 右边改成同一个值（如都改 9000） |
| 加访问口令 | `environment.TOKEN` 填口令；浏览器首次访问 `http://<host>:8787/?token=<口令>`，之后前端会记住，并自动给媒体地址带 token |
| 放大并发播放 | `environment.MAX_STREAMS: "12"` |
| 允许代理内网媒体 | `environment.ALLOW_PRIVATE_MEDIA: "1"`（默认 `0` 拒绝，防 SSRF） |
| 改时区 | `environment.TZ: "Asia/Shanghai"` |

### 1.5 不克隆代码，直接跑

任意空目录新建 `compose.yaml`，粘最小示例后 `docker compose up -d`：

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

从源码构建：把 `compose.yaml` 的 `image:` 注释掉、取消 `build: .` 的注释，再 `docker compose up -d --build`。

完全不用 compose 时，先 `docker build -t hongguo-web .`，然后：

```bash
docker run -d --name hongguo-web \
  -p 8787:8787 \
  -e PORT=8787 -e HOST=0.0.0.0 \
  -e DATA_DIR=/app/data -e SOURCES_DIR=/app/sources/builtin \
  -e TZ=Asia/Shanghai -e TOKEN= \
  -e MAX_STREAMS=6 -e ALLOW_PRIVATE_MEDIA=0 -e ALLOW_PRIVATE_FETCH=0 \
  -v hongguo-data:/app/data \
  --restart unless-stopped \
  --read-only --tmpfs /tmp --security-opt no-new-privileges --cap-drop ALL \
  hongguo-web
```

参数与 [compose.yaml](compose.yaml) 对应（示例只列常用项，未列出的变量取默认值，如源自动更新、播放监控）。直接跑发布镜像时把最后的 `hongguo-web` 换成 `ghcr.io/kid941005/hongguo-web:latest`，想固定版本可写 `:0.10.0`。

### 1.7 升级、停止与卸载

```bash
docker compose pull && docker compose up -d   # 有新镜像时重建（数据保留）
docker compose down                           # 停止并删除容器，数据卷保留
docker compose down -v                        # 连数据卷一起删（会丢失账号、导入的源与配置）
```

### 1.8 镜像与版本（GHCR）

镜像由仓库自带工作流 [.github/workflows/docker.yml](.github/workflows/docker.yml) 产出：

- push 到 `main` → 推 `:edge`
- 打 `v*` 标签 → 同时推 `:版本号` 与 `:latest`
- 多架构 `linux/amd64` + `linux/arm64`，层缓存走 GHA；构建前先跑离线自测
- 构建记录见 Actions 页，镜像在 GitHub Packages；包已设为 Public，可直接 `docker pull`（拉取限流时先 `docker login ghcr.io`）

## 2. 环境变量

以下变量都在 [compose.yaml](compose.yaml) 的 `environment` 里设置；从源码直接跑时也可用同名环境变量覆盖。

### 2.1 基础

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `/app/data` | 配置、用户源、源更新状态与账号库（`hongguo.db`）目录（需可写，建议挂持久卷） |
| `SOURCES_DIR` | `/app/sources/builtin` | 内置源目录 |
| `TOKEN` | 空 | 设置后所有 `/api/*` 需带 `Authorization: Bearer <TOKEN>` 或 `?token=<TOKEN>`；浏览器打开 `http://<host>:8787/?token=<TOKEN>` 一次即可，前端会记住并自动给媒体地址追加 token |

### 2.2 播放与安全

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAX_STREAMS` | `6` | 内置红果解密流的最大并发数 |
| `ALLOW_PRIVATE_MEDIA` | 空 | `1` 时允许 `/api/media`、`/api/hls` 代理内网地址（默认拒绝，防 SSRF） |
| `ALLOW_PRIVATE_FETCH` | 空 | `1` 时允许 JS 源 `fetch` 与按 URL 导入源访问内网地址（默认拒绝，防 SSRF） |
| `HONGGUO_DEVICE_ID` | 空 | 钉死红果播放通道的匿名设备号（10~20 位纯数字）。不设置时首次注册后存 `DATA_DIR/device.json` 长期复用；设置后不再自动轮换 |
| `HONGGUO_INSTALL_ID` | 空 | 配合 `HONGGUO_DEVICE_ID` 的 install id（10~20 位纯数字）；只钉 device_id 时由注册补一次 |
| `FFMPEG_PATH` | `ffmpeg` | 服务端转码用的 ffmpeg 可执行文件。官方镜像已装（`/usr/bin/ffmpeg`，7.1+ 带 VVC 解码）；裸机运行时需自行安装 7.1 以上版本，否则 VVC 高清档不会出现在清晰度菜单 |
| `TRANSCODE_MAX_INPUT_BYTES` | `100663296` | 单集转码的输入上限（字节，默认 96 MB）；超限直接报错而不是拖垮内存 |

### 2.3 JS 源沙箱

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SOURCE_WORKER_MAX_OLD_MB` | `64` | 每个 JS 源沙箱线程的 V8 老生代内存上限（MB，最小 32）；超限自动终止该源 |
| `SOURCE_WORKER_MAX_YOUNG_MB` | `16` | V8 新生代内存上限（MB，最小 8） |
| `SOURCE_WORKER_STACK_MB` | `4` | 栈上限（MB，最小 2） |
| `SOURCE_AUTO_UPDATE` | `1` | 启动后自动检查 JS 源上游更新；`0` 关闭（内置红果解密源不参与） |
| `SOURCE_UPDATE_INTERVAL_HOURS` | `6` | 自动检查间隔（小时，最小 1） |
| `SOURCE_UPDATE_START_DELAY_SECONDS` | `15` | 启动后首次检查延迟（秒） |

### 2.4 播放通道监控

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PLAYBACK_MONITOR` | `1` | 定时探针检测内置红果通道；`0` 关闭（关闭后 `/api/alerts` 返回 `enabled:false`，前端不显示通道横幅） |
| `PLAYBACK_MONITOR_INTERVAL_MINUTES` | `10` | 探针间隔（分钟，最小 1）。探针会真实取一集首块并校验 `ftyp` |
| `PLAYBACK_ALERT_THRESHOLD` | `3` | 连续失败多少次判定「不可用」并告警（最小 1） |
| `ALERT_WEBHOOK_URL` | 空 | 状态翻转时 POST JSON（`{event,level,status,channel,message,at,version,text}`），可接钉钉/飞书/Slack 机器人或自建收集端 |

## 3. 使用指南

### 3.1 界面、浏览与搜索

- **顶栏**：三组菜单「账号 ▾」「历史 ▾」「源 ▾」，点开为二级菜单；导航（首页 / 🔥 推荐 / ✨ 猜你喜欢）与搜索框同一行。
- **首页 / 分类**：首页给分类与推荐；分类页分页浏览。首页、分类、搜索、推荐页都支持**无限滚动**（「加载更多」按钮作为兜底保留）。
- **推荐页**：把内置红果四个榜单（热播 / 真人 / 漫剧 / AI）按真实评分合并排序，卡片右上角显示「★ 9.5」，可一直向下浏览。
- **猜你喜欢**：基于观看历史的三路信号合并排序——①协同过滤（看过同一部剧的其他用户还看了什么）、②相似题材（标题相近的在架内容）、③热门兜底。结果按稳定键排序并缓存 2 分钟，**同一账号在任何设备上看到相同结果**，不同账号互相隔离；未登录时只用本机历史做种子（不上传），没有历史时先给热门榜单。卡片徽标标明「同好也在看 / 相似内容 / 热门」。
- **搜索**：回车即搜。红果内置源走官网 JSON 搜索，每页 10 条、支持翻页；只有该通道真的不可用时才降级为「首页推荐池检索」（结果偏少，界面会提示原因）。关键词超过 30 字时按前 30 字检索（官网硬限制）。
- **多源聚合搜索**：源下拉框选「🔎 全部源（聚合搜索）」后搜索，**并发查询所有可用源、谁先返回先展示**（慢源不阻塞），卡片左上角带源名徽标，点开自动带上所属源；顶部提示条显示「已返回 X/Y 个源、共 N 条」及各源命中数/失败原因。模板与示例源不参与聚合。

### 3.2 播放与清晰度

- **选集**：点卡片 → 详情页选集；多线路时先选线路。播放器支持 HLS（m3u8）与 MP4 直链；`flv` 能识别但没有播放器。
- **分辨率与切档**：控制条常显**当前解码分辨率**徽标（360P/720P/1080P…，取自 `video.videoWidth/Height`）。点「清晰度」查看档位——HLS master 多码率源可在「自动 / 各档」间切换并尽量保持播放位置；单码率 HLS 与 MP4 直链只显示「该源仅此一种清晰度」，不伪造选项。切档时按钮显示「切换中…」、进度保留、地址栏记录档位。
- **倍速**：0.5×–2×（点 `1.0×` 循环，控制条实时显示当前倍速）；刷新、换集都保持，点开新剧默认 1.0×。未登录记在本机，登录后随账号跨设备同步。
- **全屏**：按钮 / 双击画面 / `F`。
- **下一集预取**：接近结尾时后台预取下一集首段（最多缓存 6 个），点「下一集」秒开。
- **红果内置档位**：服务端用 Android App 签名（x-argus + x-ladon）直连官方多档接口，拿 CENC 加密流后服务端解密、按 Range 转发。播放器先探测浏览器 HEVC 解码能力：支持（Safari、装了 HEVC 扩展的 Edge/Chrome、部分安卓）用 1080P，不支持（Chrome/Windows 默认）自动落到 360P H.264 兼容线路，菜单里也可手选。

### 3.3 播放失败排查

- **四类诊断**：播放出错时浮层直接说明原因——「内容源暂时不可用」/「设备不支持 H.266/VVC」/「解不了这一档画面（HEVC 有声音无画面）」/「地址可用但播放异常」，并给对应操作（重试 / 切到 360P 兼容 / 换数据源）。编码类问题不会引导用户点无效重试。
- **自动找替代源**：浮层多一个按钮「换到「源名」看第 N 集」——后端拿当前剧名到其它源搜索、按标题相似度（≥0.62）匹配并校验集数覆盖，取最像的前 3 个候选；点一下即切到同名剧并定位到同一集。找不到同名剧时按钮不出现（红果独播剧在别家通常没有）。
- **通道状态**：服务端每 10 分钟真实取一集首块（校验 `ftyp`）探测内置红果通道，连续 3 次失败判定不可用；状态翻转时写日志（`event:"playback_alert"`）并按需推 Webhook，网页顶部出现红色横幅。状态随时可查 `GET /api/alerts`。
- **上游限流**：连续 3 次被上游拒绝（空响应 / 风控 / 403 / 429）即熔断 30 秒，冷却期内请求快速失败（`503 UPSTREAM_COOLDOWN` + `Retry-After`），到期只放行一个探测，探测再失败冷却翻倍（上限 5 分钟），成功立即恢复。官方通道与兼容通道各自独立熔断。

### 3.4 账号与多设备同步

- **账号（可选）**：顶栏「账号 ▾」→「登录 / 注册」（用户名 3–20 位中英文数字下划线，密码 6–64 位）。账号只用于同步个人数据，不登录也能正常看剧。
- **观看历史 / 续播**：进度每 5 秒、暂停、关闭播放器时落盘（上限 100 条）。详情页顶部出现「上次看到 第N集 12:34 / 20:50（60%）」续播条，点「继续播放」跳回上次位置；已看过的集变暗、当前集高亮。顶栏「历史 ▾」→「🕘 在看」可查看/续播/删除/清空。
- **收藏 / 追剧提醒**：详情页「☆ 收藏」「🔔 追更」；列表在「历史 ▾」菜单里。追更定时（默认 10 分钟，打开面板或页面重新可见时也检查）检查集数变化，有新集时角标显示新增集数并提示，面板里「检查更新」可立即检查。
- **多设备同步**：历史、收藏、追更、倍速偏好都存服务端 SQLite（`DATA_DIR/hongguo.db`）。本地历史与服务端按时间戳取新合并，旧进度不会覆盖新进度。

### 3.5 源管理

- **切换源**：顶栏「源 ▾」→「目前数据源」。内置红果 + 随包附带的七猫 / 西饭 / 星芽 / 牛牛等 JS 源。
- **管理面板**：「源 ▾」→「⚙ 管理」，看每个源的版本 / 类型 / 是否使用中，一键启用，点「自检」做连通性检查（默认校验首页 / 详情，按住 Shift 点击会对内置红果真实取流校验首块是否为 `ftyp`，较慢），展开最近运行日志，删除导入源（内置源不可删）。有上游地址的源显示「自动更新」开关，底部「检查源更新」可立即检查全部源；更新失败只记错误并保留旧版本。
- **导入源**：「源 ▾」→「＋ 新增」，粘贴源文件 URL 或直接粘贴 JS 源码；导入后即时出现在下拉框。按 URL 导入的源会记住地址并默认自动更新（仅 HTTPS）；直接粘贴源码的源若 meta 里带 `updateUrl` 也会自动更新。导入时会先跑一次 `home` 自检，失败不保存。

### 3.6 PWA / 移动端

Chrome/Edge 地址栏右侧会出现「安装」；手机浏览器「添加到主屏幕」后以独立窗口运行。Service Worker 需要安全上下文（`http://localhost` 或 HTTPS），用局域网 IP 的纯 HTTP 打开时页面可用但没有离线缓存、不能安装。

### 3.7 播放器快捷键

| 按键 | 作用 |
| --- | --- |
| `空格` / `K` | 播放 / 暂停 |
| `←` / `→` | 后退 / 前进 5 秒 |
| `↑` / `↓` | 音量 ±10% |
| `M` | 静音切换 |
| `F` | 全屏 / 退出全屏（双击画面同效） |
| `,` / `.` | 减速 / 加速（0.5× → 2×） |
| `N` | 下一集 |

快捷键在播放器打开时生效；焦点在输入框（搜索框、导入框）里时不拦截。

### 3.8 前端存储

| key | 位置 | 内容 |
| --- | --- | --- |
| `hg_watch_v1` | 浏览器 localStorage | 观看历史（source/id/title/cover/lineIdx/epIdx/pos/dur/at），最多 100 条；登录后同步到服务端 |
| `hg_rate_v1` | 浏览器 localStorage | 上次选择的播放倍速（未登录时的本机缓存；登录后以服务端 `prefs` 为准） |
| `hg_user_token` | 浏览器 localStorage | 登录令牌（30 天有效），退出登录即清除 |

### 3.9 深链

`/?rec=1`（推荐页）、`/?foryou=1`（猜你喜欢）、`/?source=qimao`、`/?source=__all&q=总裁`、`/?source=qimao&id=5207`、`/?source=qimao&id=5207&ep=0`（直接播放第 N 集，从 0 计数）。

## 4. 自定义 JS 源格式（糖葫芦同款）

源是**单个 .js 文件**，声明一个全局 `spider` 对象。每个源在独立的 `worker_threads` 线程里运行（内存上限默认 64 MB，调用超时直接终止该源线程），只通过消息通道获得 `fetch`，拿不到 `require` / `process` / 文件系统等 Node API。

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
      vod_play_url: "第1集$ep1#第2集$ep2" }] };                  // 集用 #，集名与集 ID 用 $
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
- `updateUrl` 必须是 HTTPS 且返回同一个 `id` 的源；更新前会跑一次 `home` 自检，失败保留旧版本。按 URL 导入时即使 meta 没写 `updateUrl`，也会用导入地址作为上游。
- `play` 返回**可直连**的 `m3u8` / `mp4`（`flv` 能识别但没有播放器）。返回 `parse: 1`（需要 webview 嗅探）本服务**不支持**，会报「需要 webview 嗅探解析」。
- 分页约定：`pagecount` 建议返回 `hasMore ? page + 1 : page`，`hasMore` 明确有无下一页（写死 `page + 1` 会让前端无限翻页）。
- 除上述方法外还可选实现 `feed / rankings / recommendations / rankingBoards / seriesSeasons / danmaku` 等（本服务目前只用核心方法）。
- 不得 `import` / `require`，不得访问 Node 内置模块或文件系统。

## 5. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（含 `accounts` 是否启用账号系统） |
| GET | `/api/metrics` | 运行指标：uptime、RSS、取流尝试/失败/空响应、熔断（`breakers`）、同集取址去重（`dedupe`）、通道计数（`channels`）、监控快照（`playback`）、`official.device` |
| GET | `/api/alerts` | 通道监控快照：`status`（`ok` / `degraded` / `down` / `unknown`）、通道、失败次数、最近告警（最多 50 条） |
| POST | `/api/alerts/check` | 立即跑一次通道探针（同步返回最新快照） |
| POST | `/api/cache/clear` | 一键清缓存（排查上游风控/签名变化第一步）：清首页 SWR、推荐池、vendor 四层缓存与官方播放模型缓存，返回各层条目数 |
| POST | `/api/auth/register` | 注册：`{ username, password }` → `{ token, user }` |
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
| GET/PUT | `/api/me/prefs` | 个人偏好（播放倍速）：GET `{prefs:{rate,updatedAt}}`，PUT `{rate}`（0.5/0.75/1/1.25/1.5/2） |
| GET | `/api/sources` | 源列表 + 当前启用源 |
| POST | `/api/sources/import` | 导入源：`{ url }` 或 `{ code }` |
| POST | `/api/sources/active` | 切换启用源：`{ id }` |
| GET | `/api/sources/:id/log` | 源最近运行日志 |
| GET | `/api/sources/:id/health` | 源健康检查：默认校验首页/详情；`?deep=1` 时内置红果额外走 home→detail→stream 真实取流（首块 `ftyp`），JS 源校验首页可达 |
| DELETE | `/api/sources/:id` | 删除用户源（内置源不可删） |
| POST | `/api/sources/check-updates` | 立即检查所有可自动更新的 JS 源（`{ force: false }` 走 ETag） |
| POST | `/api/sources/:id/check-update` | 立即检查单个源更新 |
| POST | `/api/sources/:id/auto-update` | 开关单个源自动更新：`{ enabled: true }` |
| GET | `/api/home?source=&page=` | 首页（`classes` + `items`），带 SWR 语义（`stale` / `age`） |
| GET | `/api/recommend?page=` | 推荐页：内置红果四榜单按真实评分合并排序（`items[].score/heat/bang`） |
| POST | `/api/for-you` | 猜你喜欢：`{ seeds?: [{source,id,title,cover}], refresh?: bool }`；登录用户用云端历史做种子。返回 `{items, basis:{mode,seeds,coUsers,total,counts}, generatedAt}` |
| GET | `/api/category?source=&tid=&page=` | 分类列表 |
| GET | `/api/search?source=&q=&page=` | 搜索；`source=__all`（或 `all=1`）为多源聚合，返回 `{aggregate:true, groups:[{source,name,count,ms,hasMore,error}]}` |
| GET | `/api/detail?source=&id=` | 详情（含标签、线路与剧集） |
| GET | `/api/play?source=&flag=&id=` | 取播放地址（`{type,url}`；内置红果额外带 `quality:{options:[{key,label,height,codec,url}],note}`） |
| GET | `/api/play/fallback?source=&id=&index=` | 播放失败时的替代源：按剧名跨源匹配，返回 `{candidates:[{source,name,id,title,episodeCount,targetIndex,episodeName,score}]}`（最多 3 个） |
| GET | `/api/media?u=&r=&token=` | 媒体透传（支持 Range，`r` 为 Referer）；图片请求（`Accept: image/*` 或图片后缀）上游失败时回内置占位图 **200**，响应头 `x-media-fallback` 标明原因 |
| GET | `/api/hls?u=&r=&token=` | HLS 清单重写（分片走 `/api/media`，自动带 token） |
| GET/HEAD | `/api/stream/:epId?q=&token=&vvc=` | 内置红果分集流（服务端解密 + Range）；`q` 取 `auto`（最高可播档）/ `1080p`（HEVC）/ `720p` / `540p` / `480p` / `360p` / `compat`（官网 360P H.264 兜底）；响应头 `x-stream-quality`、`x-stream-codec` 标明实际档位与编码。显式点 VVC 档（`q=720p` 等）默认回 **415** `CODEC_UNSUPPORTED`，确需直取时加 `vvc=1`；加 `tc=1` 则由服务端用 ffmpeg 把该 VVC 档**转码成 H.264** 下发（200、`x-stream-transcode:1`、`accept-ranges:none`，可播但不可拖动） |

认证：

- 个人数据接口（`/api/me/*`、`/api/auth/me`、`/api/auth/logout`）需登录，请求头带 `X-Auth-Token: <token>`
- 应用级 `TOKEN` 支持 `Authorization: Bearer` 或 `?token=`（媒体/流地址由前端自动追加）

错误与日志：

- 所有错误统一 `{ error, code }`。常见 code：`BAD_INPUT` / `BAD_JSON` / `BAD_URL`（400）、`UNAUTHORIZED`（401）、`PROTECTED`（403）、`NOT_FOUND`（404）、`USER_EXISTS`（409）、`CODEC_UNSUPPORTED`（415）、`RATE_LIMITED`（429）、`BUSY` / `UPSTREAM_COOLDOWN` / `UPSTREAM_EMPTY`（503）、`TIMEOUT`（504），其余上游问题 502。凡「过一会儿再来」的码（429 / 503）都带 `Retry-After`。
- 访问日志：每个 `/api/*` 请求与失败的静态请求写一条 `{"event":"access",method,path,status,ms}`，排查慢接口按 `ms` 排序即可（静态资源 200 不记，避免刷屏）。

## 6. 目录结构与离线自测

```
hongguo-web/
├─ Dockerfile / compose.yaml / .dockerignore
├─ LICENSE                          # GPL-3.0 全文
├─ .github/workflows/docker.yml     # 镜像构建（GHCR，main→:edge，tag→:版本+:latest）
├─ docs/                            # research.md（上游调研）+ screenshots/
├─ server/
│  ├─ index.mjs                     # 入口：装配 provider + 源管理 + 目录 + HTTP + 监控
│  ├─ provider.mjs                  # 内置红果取流编排（官网明文 / App 分块解密）+ 熔断
│  ├─ official.mjs                  # 官方多档接口：签名、设备身份、档位解析
│  ├─ vendor/hongguo.cjs            # 红果解析核心（drpys 派生，GPL，见 LICENSE*）
│  ├─ breaker.mjs                   # 上游熔断状态机（阈值 / 冷却 / 半开单探测）
│  ├─ device.mjs                    # 设备身份持久化、校验与节流轮换
│  ├─ catalog.mjs                   # 统一目录层：内置源与 JS 源归一成同一套 API
│  ├─ media.mjs                     # /api/media 透传（Range）+ /api/hls 清单重写 + 占位图
│  ├─ stream.mjs                    # /api/stream 内置解密流（Range、并发上限、取址去重）
│  ├─ mp4.mjs                       # 首块 MP4 盒校验
│  ├─ transcode.mjs                 # H.266/VVC → H.264 服务端转码（ffmpeg，边转边发、不可拖动）
│  ├─ monitor.mjs                   # 播放通道定时探针与告警
│  ├─ recommend.mjs                 # 推荐 / 猜你喜欢排序
│  ├─ static.mjs                    # 静态文件托管（越界校验、MIME、HEAD）
│  ├─ errors.mjs                    # 错误码 → HTTP 状态映射、Retry-After 与对外文案
│  ├─ net.mjs                       # 出站 URL/DNS 校验与安全请求（SSRF / DNS Rebinding 防护）
│  ├─ db.mjs / users.mjs            # SQLite（node:sqlite）与 UserStore
│  ├─ http.mjs                      # 路由表、鉴权、访问日志
│  ├─ selftest.mjs                  # 离线自测：密钥派生 / 分块解密 / 签名 / 解析 / 熔断 / 错误码
│  ├─ sign/                         # argus.cjs、sm3.cjs（播放签名，见 NOTICE.md）
│  ├─ scripts/smoke.mjs             # 发布冒烟：health / 源 / 首页 / 猜你喜欢 / 取流 / 监控
│  └─ sources/
│     ├─ runtime.mjs                # JS 源运行时装配（每源独立 worker_threads）
│     ├─ worker.mjs                 # 沙箱线程：node:vm + resourceLimits
│     ├─ manager.mjs                # 源的扫描 / 安装 / 删除 / 启用 / 自动更新
│     └─ shims.js                   # fetch / HTML 解析垫片（对齐 App 内 CatPaw 运行时）
├─ sources/builtin/                 # 内置 JS 源：qimao / xifan / xingya / niuniu / template / maccms
└─ web/                             # 前端静态页 + hls.js + PWA（manifest / sw.js / icons/）
```

### 6.1 离线自测

改密钥派生、分块解密、播放签名这类「改一行就可能让所有播放失效」的代码前后，先跑一遍离线自测（不联网、不读 `data/`）：

```bash
docker run --rm -v "$PWD":/w -w /w node:22-bookworm-slim sh -c \
  "npm --prefix server install --omit=dev --no-audit --no-fund && node server/selftest.mjs"
```

本机有 Node 22.5+ 时直接 `npm --prefix server install --omit=dev && npm --prefix server run selftest` 即可。黄金向量钉住的是「当前已验证行为」：上游 vendor 换算法时它会失败，这是预期——先人工确认新算法，再更新向量。

## 7. 已知限制

- **内置红果搜索**：主通道是官网搜索页自己用的 JSON 接口 `GET /api/search/result?query=`（只校验 UA，不依赖 App 签名），响应带 `channel: "web"`、`total`、`hasMore`；失败才降级为首页推荐池检索（`fallback: true`、`channel: "pool"`，结果不全）。
- **需要 webview 嗅探的源**（`parse: 1`）不可用：本服务没有浏览器内核。
- **同时播放上限**：内置红果解密流默认最多 6 路并发（`MAX_STREAMS` 可调）。同一集同一档位被多人同时点开只取址一次，`/api/metrics` 的 `dedupe.shared` 可看合并次数。
- **红果内置流的分档**：1080P 是 **HEVC**，360P 是 **H.264**，两者浏览器可解（HEVC 需设备/浏览器支持，Chrome 有 GPU 时可硬解）；官方 360P–720P 中间档是 **H.266/VVC**，任何浏览器都没有解码器，只有服务端装了 7.1+ 的 ffmpeg 才由服务端转成 H.264 提供（菜单里标注「转码」）。转码线路是**边转边发、不可拖动**，CPU 占用约 12× 实时（单核），并发多了会排队；没有 ffmpeg 时这些档不列入菜单。给能解 VVC 的外部播放器直取仍可用 `?q=720p&vvc=1`。官方签名接口再变动时，服务端自动回落官网明文 360P；若连档位信息都取不到，`/api/play` 只降级为「仅 360P 兼容线路」，不会整条播放失败。
- **设备身份会被风控**：红果播放模型接口把「匿名注册的设备」当风控维度，同一份身份被判异常后签名重算多少次都只会拿到 200 空正文。服务端把身份存 `DATA_DIR/device.json` 长期复用，只有真收到空正文才换一份，且同一身份 60 秒内最多换一次。身份来源、注册 / 轮换 / 被节流次数见 `/api/metrics` 的 `official.device`（已脱敏）；`HONGGUO_DEVICE_ID` 钉死时不轮换。
- **降级换源依赖别家也有同名剧**：替代源按标题相似度在其它源搜索结果里找，红果独播剧、译名差异大的剧通常找不到候选；此时只能换剧或等通道恢复。
- **账号数据库**：用户、令牌、历史、收藏、追更都存 `DATA_DIR/hongguo.db`（SQLite，WAL 模式）。`DATA_DIR` 必须挂持久卷，否则重建容器会丢账号数据；备份直接拷这个文件即可（建议先停容器）。
- **PWA 需要安全上下文**：Service Worker 只在 `https://` 或 `http://localhost` 启用；用局域网 IP 的纯 HTTP 访问时页面可用，但没有离线缓存、不能安装。
- **清晰度取决于源**：分辨率徽标始终显示**实际解码分辨率**（权威）。只有提供 master playlist（多 `#EXT-X-STREAM-INF`）的 HLS 源才有档位可切；单码率 HLS 与 MP4 直链只有一项，菜单明确标注「该源仅此一种清晰度」，不伪造档位。
- **推荐页首次加载慢**：需要抓红果四个榜单共 20 页（约 10 秒），结果在服务端缓存 10 分钟，之后翻页很快；单页抓取失败只丢当页。
- **聚合搜索耗时**：各源并发、先回先展示，不等最慢的源；单源聚合上限 12 秒（内置红果 30 秒），超时或失败只丢该源并在提示条注明。模板 / 示例源（`template`、`maccms`）默认不参与聚合，避免 404 与示例数据噪音。
- **JS 源默认禁止访问内网**：默认只允许公网 http(s)；确有内网源自建需求时设 `ALLOW_PRIVATE_FETCH=1`。
- **JS 源沙箱**：每源独立 `worker_threads`，默认 64 MB 内存上限；死循环 / 超时或内存超限自动终止该源线程，不影响主服务，下次调用自动重启；单次同步执行超过 5 秒会被中断。可用 `SOURCE_WORKER_MAX_OLD_MB` 等调整。
- **源自动更新**：只对 HTTPS 上游生效；内置红果解密源不在自动更新范围内（依赖服务端解密模块，需随镜像升级）。更新失败保留旧版本并记录原因，可在源管理面板查看。
- 仅供个人学习与自用；内容版权归各平台所有，请勿用于商业分发。

## 8. 截图

| 首页 | 推荐页 | 全屏播放 | 手机端 |
| --- | --- | --- | --- |
| ![首页](docs/screenshots/home.png) | ![推荐](docs/screenshots/recommend.png) | ![全屏](docs/screenshots/fullscreen.png) | ![手机端](docs/screenshots/mobile.png) |

## 9. 许可

- 本项目代码：[GPL-3.0-only](LICENSE)。
- `server/vendor/hongguo.cjs` 派生自 [drpys](https://github.com/drpys) 的实现，遵循 GPL，详见 `server/vendor/LICENSE.drpys`、`LICENSE.template-tv`、`NOTICE.md`。
- 上游调研与可行性验证过程见 [docs/research.md](docs/research.md)。
