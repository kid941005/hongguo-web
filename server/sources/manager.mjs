import fs from "node:fs";
import path from "node:path";
import { SourceRuntime, parseMeta, validateMeta } from "./runtime.mjs";
import { fail } from "../errors.mjs";
import { assertPublicUrl, PRIVATE_FETCH_ALLOWED } from "../net.mjs";

const BUILTIN_ID = "hongguo"; // 内置红果解密源：始终存在、不可删除
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 15000;

export class SourceManager {
  constructor({ builtinDir, dataDir }) {
    this.builtinDir = builtinDir;
    this.dataDir = dataDir;
    this.userDir = path.join(dataDir, "sources");
    this.configPath = path.join(dataDir, "config.json");
    fs.mkdirSync(this.userDir, { recursive: true });
    this.registry = new Map();
    this.runtimes = new Map();
    this.config = null;
    this.scan();
  }

  // ---- 配置（activeId） ----
  readConfig() {
    if (!this.config) {
      try { this.config = JSON.parse(fs.readFileSync(this.configPath, "utf8")); }
      catch { this.config = {}; }
    }
    return this.config;
  }

  writeConfig(config) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.configPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, this.configPath);
    this.config = config;
  }

  // ---- 源注册表 ----
  scan() {
    const registry = new Map();
    registry.set(BUILTIN_ID, {
      id: BUILTIN_ID,
      name: "红果短剧（内置）",
      version: "1.0.0",
      type: "builtin",
      builtin: true,
      file: null,
      hasCategories: false,
    });

    for (const [dir, builtin] of [[this.builtinDir, true], [this.userDir, false]]) {
      if (!fs.existsSync(dir)) continue;
      for (const fileName of fs.readdirSync(dir)) {
        if (!fileName.endsWith(".js")) continue;
        const full = path.join(dir, fileName);
        let meta;
        try { meta = parseMeta(fs.readFileSync(full, "utf8")); }
        catch { continue; }
        const id = meta.id || path.basename(fileName, ".js");
        if (registry.has(id)) continue;
        registry.set(id, {
          id,
          name: meta.name || id,
          version: meta.version || "0.0.0",
          type: "js",
          builtin,
          file: full,
          hasCategories: true,
        });
      }
    }

    this.registry = registry;
    // 只为已经消失的源回收运行时；其余源的 vm 状态（缓存/会话）保留
    for (const id of [...this.runtimes.keys()]) if (!registry.has(id)) this.runtimes.delete(id);
  }

  list() {
    const active = this.activeId;
    return {
      active,
      sources: [...this.registry.values()].map((source) => ({
        id: source.id,
        name: source.name,
        version: source.version,
        type: source.type,
        builtin: source.builtin,
        hasCategories: source.hasCategories,
        active: source.id === active,
      })),
    };
  }

  get(id) {
    return this.registry.get(id || this.activeId) || null;
  }

  get activeId() {
    const config = this.readConfig();
    if (config.activeId && this.registry.has(config.activeId)) return config.activeId;
    return BUILTIN_ID;
  }

  setActive(id) {
    if (!this.registry.has(id)) throw fail("NOT_FOUND", "源不存在: " + id);
    this.writeConfig({ ...this.readConfig(), activeId: id });
    return this.list();
  }

  runtime(id) {
    const entry = this.get(id);
    if (!entry || entry.type !== "js") throw fail("NOT_JS", "不是 JS 源: " + id);
    let runtime = this.runtimes.get(entry.id);
    if (!runtime) {
      const code = fs.readFileSync(entry.file, "utf8");
      runtime = new SourceRuntime({
        code,
        meta: { id: entry.id, name: entry.name, version: entry.version },
        file: entry.file,
      });
      this.runtimes.set(entry.id, runtime);
    }
    return runtime;
  }

  async download(url) {
    const target = String(url);
    assertPublicUrl(target, "不允许从内网地址导入源（如确需内网，设置 ALLOW_PRIVATE_FETCH=1）", PRIVATE_FETCH_ALLOWED);
    let response;
    try {
      response = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
    } catch {
      throw fail("DOWNLOAD", "下载源失败：网络错误或超时");
    }
    assertPublicUrl(response.url || target, "源地址跳转到了内网地址", PRIVATE_FETCH_ALLOWED);
    if (!response.ok) throw fail("DOWNLOAD", "下载源失败: HTTP " + response.status);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_SOURCE_BYTES) throw fail("TOO_BIG", "源文件过大（>2MB）");
    const text = await response.text();
    if (text.length > MAX_SOURCE_BYTES) throw fail("TOO_BIG", "源文件过大（>2MB）");
    return text;
  }

  async install({ code, url }) {
    const source = code || (url ? await this.download(url) : "");
    if (!source || typeof source !== "string") throw fail("BAD_INPUT", "缺少源内容");
    if (source.length > MAX_SOURCE_BYTES) throw fail("TOO_BIG", "源文件过大（>2MB）");

    const { meta, problems } = validateMeta(source);
    if (problems.length) throw fail("INVALID_SOURCE", "源不可用: " + problems.join("；"));

    const id = meta.id;
    const existing = this.registry.get(id);
    if (existing && existing.builtin) throw fail("PROTECTED", "不能覆盖内置源: " + id);

    const file = path.join(this.userDir, id.replace(/[^\w.\-]/g, "_") + ".js");
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, source);
    try {
      fs.renameSync(tmp, file);
    } catch {
      try { fs.unlinkSync(file); } catch { /* 目标不存在 */ }
      fs.renameSync(tmp, file);
    }
    this.runtimes.delete(id); // 同 id 重新导入：丢掉旧代码的上下文
    this.scan();

    // 立刻跑一次 home，尽早暴露坏源（失败仍保留安装，问题写进日志供面板查看）
    try {
      await this.runtime(id).call("home", [{}, false], 30000);
    } catch (error) {
      this.runtimes.get(id)?.pushLog("初始化自检失败: " + ((error && error.message) || error));
    }

    return this.registry.get(id);
  }

  remove(id) {
    const entry = this.get(id);
    if (!entry) throw fail("NOT_FOUND", "源不存在");
    if (entry.builtin) throw fail("PROTECTED", "内置源不可删除");
    this.runtimes.delete(id);
    try { fs.unlinkSync(entry.file); } catch { /* 文件已不在，注册表刷新即可 */ }
    if (this.activeId === id) this.writeConfig({ ...this.readConfig(), activeId: BUILTIN_ID });
    this.scan();
    return this.list();
  }

  logs(id) {
    const runtime = this.runtimes.get(id);
    return runtime ? runtime.logs.slice(-80) : [];
  }
}
