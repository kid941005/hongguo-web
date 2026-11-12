import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// 静态资源托管：只允许 webDir 之内的文件，路径逃逸一律 404（不泄露目录是否存在）。
export function createStaticHandler(webDir) {
  const root = path.resolve(webDir);
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* webDir 不存在时保持字面路径 */ }

  return async function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw fail("BAD_INPUT", "路径编码无效");
    }
    if (rel.endsWith("/")) rel += "index.html";

    const full = path.resolve(root, "." + (rel.startsWith("/") ? rel : "/" + rel));
    const relative = path.relative(root, full);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw fail("NOT_FOUND", "文件不存在");
    }

    // 再解析一次真实路径，防止 webDir 内的符号链接指向目录外。
    let real;
    try {
      real = await fs.promises.realpath(full);
    } catch {
      throw fail("NOT_FOUND", "文件不存在");
    }
    const realRelative = path.relative(realRoot, real);
    if (realRelative === ".." || realRelative.startsWith(".." + path.sep) || path.isAbsolute(realRelative)) {
      throw fail("NOT_FOUND", "文件不存在");
    }

    // 只 stat 不读文件：ETag 只依赖 size+mtime，304 命中时不必把 app.js 整个读进内存（review S9）。
    let stat;
    try {
      stat = await fs.promises.stat(real);
    } catch {
      throw fail("NOT_FOUND", "文件不存在");
    }
    if (!stat.isFile()) throw fail("NOT_FOUND", "文件不存在");

    // ETag 让「每次都回源校验」变成廉价的 304：静态资源一律 no-cache（可缓存但必须校验），
    // 内容没变时只回 304 空响应，Service Worker 与浏览器都不必重新下载 app.js/style.css。
    const etag = '"' + stat.size.toString(16) + "-" + Math.floor(stat.mtimeMs).toString(16) + '"';
    const cacheHeaders = { "cache-control": "no-cache", etag };
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch && ifNoneMatch.split(",").some((tag) => {
      const value = tag.trim();
      return value === "*" || value === etag || value === "W/" + etag;
    })) {
      res.writeHead(304, cacheHeaders);
      return res.end();
    }

    res.writeHead(200, {
      "content-type": MIME[path.extname(real).toLowerCase()] || "application/octet-stream",
      "content-length": stat.size,
      ...cacheHeaders,
    });
    if (req.method === "HEAD") return res.end();
    // 流式发送：大文件（hls.js 300KB、图标）不再整份进内存。
    await new Promise((resolve, reject) => {
      const source = fs.createReadStream(real);
      source.on("error", reject);
      res.on("close", () => source.destroy());
      source.on("end", resolve);
      source.pipe(res);
    });
  };
}
