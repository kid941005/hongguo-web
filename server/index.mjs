import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { provider } from "./provider.mjs";
import { SourceManager } from "./sources/manager.mjs";
import { createCatalog } from "./catalog.mjs";
import { createServer } from "./http.mjs";
import { createMonitor } from "./monitor.mjs";
import { createRecommend } from "./recommend.mjs";
import { openDb } from "./db.mjs";
import { UserStore } from "./users.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const BUILTIN_DIR = process.env.SOURCES_DIR || path.join(ROOT, "sources", "builtin");
const TOKEN = process.env.TOKEN || "";
const MAX_STREAMS = Number(process.env.MAX_STREAMS || 6);
const SOURCE_AUTO_UPDATE = process.env.SOURCE_AUTO_UPDATE !== "0";
const updateIntervalHours = Number(process.env.SOURCE_UPDATE_INTERVAL_HOURS);
const SOURCE_UPDATE_INTERVAL_HOURS = Number.isFinite(updateIntervalHours) && updateIntervalHours > 0 ? updateIntervalHours : 6;
const updateStartDelaySeconds = Number(process.env.SOURCE_UPDATE_START_DELAY_SECONDS);
const SOURCE_UPDATE_START_DELAY_SECONDS = Number.isFinite(updateStartDelaySeconds) && updateStartDelaySeconds >= 0 ? updateStartDelaySeconds : 15;

// 播放通道监控：定时深探针 + 状态翻转告警（可选 webhook），默认开启、10 分钟一轮。
const PLAYBACK_MONITOR = process.env.PLAYBACK_MONITOR !== "0";
const monitorMinutes = Number(process.env.PLAYBACK_MONITOR_INTERVAL_MINUTES);
const PLAYBACK_MONITOR_INTERVAL_MINUTES = Number.isFinite(monitorMinutes) && monitorMinutes >= 1 ? monitorMinutes : 10;
const alertThreshold = Number(process.env.PLAYBACK_ALERT_THRESHOLD);
const PLAYBACK_ALERT_THRESHOLD = Number.isFinite(alertThreshold) && alertThreshold >= 1 ? Math.floor(alertThreshold) : 3;
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT 无效: " + process.env.PORT);
  process.exit(1);
}

const sources = new SourceManager({ builtinDir: BUILTIN_DIR, dataDir: DATA_DIR });
const catalog = createCatalog({ provider, sources });
const monitor = PLAYBACK_MONITOR
  ? createMonitor({
    provider,
    catalog,
    intervalMs: PLAYBACK_MONITOR_INTERVAL_MINUTES * 60 * 1000,
    threshold: PLAYBACK_ALERT_THRESHOLD,
    webhookUrl: ALERT_WEBHOOK_URL,
    version,
  })
  : null;
const db = openDb(DATA_DIR);
const users = new UserStore(db);
const recommend = createRecommend({ catalog, users, sources });
const server = createServer({
  provider,
  sources,
  catalog,
  users,
  monitor,
  recommend,
  webDir: path.join(ROOT, "web"),
  token: TOKEN,
  version,
  maxStreams: Number.isInteger(MAX_STREAMS) && MAX_STREAMS > 0 ? MAX_STREAMS : 6,
});

server.on("error", (error) => {
  const hint = error.code === "EADDRINUSE" ? "（端口被占用，换个 PORT 或先停掉占用进程）" : "";
  console.error(JSON.stringify({ event: "listen_failed", code: error.code || "", message: String(error.message || error) + hint }));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({ event: "listening", url: "http://" + HOST + ":" + PORT, version, active: sources.activeId, sources: sources.list().sources.length }),
  );
  // 后台预热搜索池（不阻塞启动，失败只记日志）。
  setTimeout(() => {
    Promise.resolve(catalog.warmup && catalog.warmup()).catch(() => {});
  }, 1500).unref();
  if (SOURCE_AUTO_UPDATE) {
    sources.startAutoUpdate({
      intervalMs: SOURCE_UPDATE_INTERVAL_HOURS * 60 * 60 * 1000,
      initialDelayMs: SOURCE_UPDATE_START_DELAY_SECONDS * 1000,
    });
  }
  // 首轮探针等预热跑完再开始，避免和推荐池抓取抢上游配额。
  if (monitor) monitor.start({ initialDelayMs: 20000 });
});

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ event: "unhandled_rejection", message: String((reason && reason.message) || reason) }));
});

// 兜底：定时器/缓存清理等异步路径抛出的未捕获异常不应让进程静默退出；
// 记录后走受控关闭流程，避免在状态不确定时继续服务（Docker 会自动拉起）。
process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({
    event: "uncaught_exception",
    message: String((error && error.message) || error),
    stack: String((error && error.stack) || "").slice(0, 2000),
  }));
  try { shutdown("uncaught_exception"); } catch { process.exit(1); }
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(JSON.stringify({ event: "shutdown", signal }));
  try { if (monitor) monitor.stop(); } catch {}
  try { sources.close(); } catch {}
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  // 兜底：长连接（正在播放的流）不阻塞退出
  setTimeout(() => process.exit(0), 5000).unref();
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(signal));
