# 上游调研与可行性验证

本项目在实现前对 5 个相关开源仓库做了逐一看码与接口实测，结论如下（2026-11 时点）。

## 一、结论速览

| 仓库 | 形态 | 可用性 | 对本项目的作用 |
| --- | --- | --- | --- |
| [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) | Node 服务端 + Docker，含 `server/` 与 `vendor/hongguo.cjs`（68 KB，drpys 派生，GPL） | **可用**：服务端分块解密，可直接播 | 内置红果源的解析与解密核心（本项目 `server/vendor/hongguo.cjs`） |
| [never88gone/THLRedGuo](https://github.com/never88gone/THLRedGuo) | Flutter 全平台客户端（糖葫芦 Haw，包名 `com.never88gone.redlook`） | 客户端不可网页化 | **JS 源规范**被完整沿用（见下文第四节） |
| [waligoraamodio288-rgb/hongguo-desktop-releases](https://github.com/waligoraamodio288-rgb/hongguo-desktop-releases) | 只有 README + 截图（发布页） | 无源码 | 无 |
| [yangbin1322/hongguo-player](https://github.com/yangbin1322/hongguo-player) | 只有 README + 截图 | 无源码 | 无 |
| [KEJIYUNB/hongguo](https://github.com/KEJIYUNB/hongguo) | LSPosed 模块（Android 注入） | 与网页播放无关 | 无 |

结论：**只有 N3urda/hongguoTV 提供了可运行的红果解析实现**，本项目在其基础上重写了服务端（统一目录层、源管理、错误码、SSRF 防护、流控），并把糖葫芦的 JS 源格式接成第二类数据源。

## 二、内置红果源实测

直接调用 `vendor/hongguo.cjs` 的 provider：

- `home(1)` → 24 条（首页推荐）
- `detail(id)` → 标题 + 102 集
- `stream(第一集)` → `total = 15798103` 字节
- `chunk(0, 131071)` → 返回 131072 字节，开头 `0000001c 66747970 69736f6d`（即 ISO BMFF 的 `ftyp isom`）

说明解密在服务端可完成、分块边界正确，因此本项目采用「服务端解密 + Range 透传」的方案（`/api/stream/:epId`），浏览器只连本站。

## 三、内置搜索为何降级为推荐池

- 官方搜索接口 `api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/search/tab/v` 返回 200 但 body 为空（风控）。
- 网页搜索页 `/search/<kw>` 返回 37 KB 反爬壳（`data-sdk-glue-default="pre-handler"`，无 `_ROUTER_DATA`），拿不到结果。

因此内置源的搜索退化为「首页推荐池检索」：抓 8 页 × 24 条 ≈ 192 条，缓存 10 分钟，响应里带 `fallback: true` 与 `poolSize`，前端会提示。真正的多源搜索靠聚合（JS 源）。

## 四、糖葫芦 JS 源规范（从 THLRedGuo 源码提取）

依据 `lib/core/js/catpaw_js_runtime.dart`、`lib/core/js/dart_core_engine.dart`：

- 源是**单个 .js 文件**，声明全局 `spider` 对象。
- 必备方法：`home(filter)`、`category(tid, page, filter, extend)`、`detail(id)`、`search(wd, quick, page)`、`play(flag, id, flags)`；可选 `init`、`feed`、`rankings`、`recommendations`、`suggestions`、`rankingBoards`、`seriesSeasons`、`danmaku`。
- meta（id / name）由正则从源码抓第一处 `id: "..."`、`name: "..."`；`version` 若给出必须是 `x.y.z`。
- 运行时沙箱只提供 `fetch`（默认 12s，可传 timeoutMs）、`html.parse`（选择器仅 tag / .class / #id / tag.class / 空格后代）、`console`（App 里是空实现）、JSON / Promise / Map / Set；**没有** `require`/`import`/`local`/`req`/`pdfh`/`setTimeout`/`btoa`/`Buffer`/`TextDecoder`/`document`。
- `play` 的 `flag` 在 Dart 兜底引擎里恒为字符串 `'flag'`；**没有 webview 嗅探**，所以 `parse: 1` 无效，必须返回直链 mp4/m3u8（或 32 位 hex 的 decryptionKey）。
- `vod_play_url` 用 `$$$` 分线路、`#` 分集、`$` 分「集名$集ID」；网页版只取第一条线路。
- 超时口径：home / category / detail 40s，search / play 60s，danmaku 20s。

本项目 `server/sources/` 按同一口径实现（`runtime.mjs` 用 `node:vm` + 垫片，`shims.js` 对齐 fetch/HTML 解析），差异只有：

| 项 | 糖葫芦 App | 本项目网页版 |
| --- | --- | --- |
| 沙箱 | CatPaw 自研 JS 引擎 | `node:vm` + 显式垫片（无 Node API） |
| webview 嗅探 | 不支持 | 不支持（一致） |
| 线路 | 可切换 | 只取第一条 |
| 额外能力 | — | `fetch` 超时可配、错误码统一、源热插拔 |

## 五、参考链接

- <https://github.com/N3urda/hongguoTV>
- <https://github.com/never88gone/THLRedGuo>
- <https://t.me/tanghulutvos>（作者频道，明确说明不提供其他「果」的 JS 源）
