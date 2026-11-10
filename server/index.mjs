import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { provider } from "./provider.mjs";
import { SourceManager } from "./sources/manager.mjs";
import { createCatalog } from "./catalog.mjs";
import { createServer } from "./http.mjs";
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

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT 无效: " + process.env.PORT);
  process.exit(1);
}

const sources = new SourceManager({ builtinDir: BUILTIN_DIR, dataDir: DATA_DIR });
const catalog = createCatalog({ provider, sources });
const db = openDb(DATA_DIR);
const users = new UserStore(db);
const server = createServer({
  provider,
  sources,
  catalog,
  users,
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
  if (SOURCE_AUTO_UPDATE) {
    sources.startAutoUpdate({
      intervalMs: SOURCE_UPDATE_INTERVAL_HOURS * 60 * 60 * 1000,
      initialDelayMs: SOURCE_UPDATE_START_DELAY_SECONDS * 1000,
    });
  }
});

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ event: "unhandled_rejection", message: String((reason && reason.message) || reason) }));
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(JSON.stringify({ event: "shutdown", signal }));
  try { sources.close(); } catch {}
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  // 兜底：长连接（正在播放的流）不阻塞退出
  setTimeout(() => process.exit(0), 5000).unref();
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(signal));
