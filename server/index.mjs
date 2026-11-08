import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { provider } from "./provider.mjs";
import { SourceManager } from "./sources/manager.mjs";
import { createCatalog } from "./catalog.mjs";
import { createServer } from "./http.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const BUILTIN_DIR = process.env.SOURCES_DIR || path.join(ROOT, "sources", "builtin");
const TOKEN = process.env.TOKEN || "";
const MAX_STREAMS = Number(process.env.MAX_STREAMS || 6);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT 无效: " + process.env.PORT);
  process.exit(1);
}

const sources = new SourceManager({ builtinDir: BUILTIN_DIR, dataDir: DATA_DIR });
const catalog = createCatalog({ provider, sources });
const server = createServer({
  provider,
  sources,
  catalog,
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
});

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ event: "unhandled_rejection", message: String((reason && reason.message) || reason) }));
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(JSON.stringify({ event: "shutdown", signal }));
  server.close(() => process.exit(0));
  // 兜底：长连接（正在播放的流）不阻塞退出
  setTimeout(() => process.exit(0), 5000).unref();
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(signal));
