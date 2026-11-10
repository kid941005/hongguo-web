import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SourceRuntime, parseMeta, validateMeta } from "./runtime.mjs";
import { fail } from "../errors.mjs";
import { safeFetch, PRIVATE_FETCH_ALLOWED } from "../net.mjs";

const BUILTIN_ID = "hongguo";
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 15000;
const SELF_TEST_TIMEOUT = 30000;
const STATE_FILE = "sources-state.json";
const AUTO_UPDATE_CONCURRENCY = 2;

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function versionParts(version) {
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})/.exec(String(version || ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function isHttps(url) {
  try {
    return new URL(String(url)).protocol === "https:";
  } catch {
    return false;
  }
}

function safeFileName(id) {
  return String(id).replace(/[^\w.\-]/g, "_");
}

// 源管理：内置源 + data 目录中的用户源 + 更新状态。
// 更新只写 data/sources，不修改镜像内只读的内置源；内置源被更新后由同 id 的用户文件覆盖。
export class SourceManager {
  constructor({ builtinDir, dataDir }) {
    this.builtinDir = builtinDir;
    this.dataDir = dataDir;
    this.userDir = path.join(dataDir, "sources");
    this.configPath = path.join(dataDir, "config.json");
    this.statePath = path.join(dataDir, STATE_FILE);
    this.registry = new Map();
    this.runtimes = new Map();
    this.state = null;
    this.updatingIds = new Set();
    this.updateAllPromise = null;
    this.autoUpdateTimers = [];
    fs.mkdirSync(this.userDir, { recursive: true });
    this.scan();
  }

  readState() {
    if (this.state === null) {
      let parsed = {};
      try {
        parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      } catch {
        parsed = {};
      }
      this.state = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    return this.state;
  }

  writeState(state) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temporary = this.statePath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    try {
      fs.renameSync(temporary, this.statePath);
    } catch {
      try { fs.unlinkSync(this.statePath); } catch {}
      fs.renameSync(temporary, this.statePath);
    }
    this.state = state;
  }

  stateFor(id) {
    const state = this.readState();
    return state[id] || null;
  }

  patchState(id, patch) {
    const state = { ...this.readState() };
    state[id] = { ...(state[id] || {}), ...patch };
    this.writeState(state);
    return state[id];
  }

  deleteState(id) {
    const state = { ...this.readState() };
    if (Object.prototype.hasOwnProperty.call(state, id)) {
      delete state[id];
      this.writeState(state);
    }
  }

  readActive() {
    try {
      const config = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      return typeof config.activeId === "string" ? config.activeId : BUILTIN_ID;
    } catch {
      return BUILTIN_ID;
    }
  }

  writeActive(id) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let config = {};
    try { config = JSON.parse(fs.readFileSync(this.configPath, "utf8")); } catch {}
    config.activeId = id;
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  scan() {
    const registry = new Map();
    registry.set(BUILTIN_ID, {
      id: BUILTIN_ID,
      name: "红果短剧（内置）",
      version: "1.0.0",
      type: "builtin",
      builtin: true,
      file: "",
      hasCategories: false,
      updateUrl: "",
    });

    const readDirectory = (directory, builtin) => {
      let names = [];
      try { names = fs.readdirSync(directory); } catch { return; }
      for (const name of names) {
        if (!name.endsWith(".js")) continue;
        const file = path.join(directory, name);
        let code = "";
        try { code = fs.readFileSync(file, "utf8"); } catch { continue; }
        const meta = parseMeta(code);
        if (!meta.id || !/^[\w.\-]{1,64}$/.test(meta.id)) continue;
        const entry = {
          id: meta.id,
          name: meta.name || meta.id,
          version: meta.version || "",
          type: "js",
          builtin,
          file,
          hasCategories: true,
          updateUrl: meta.updateUrl || "",
        };
        const existing = registry.get(meta.id);
        if (existing) {
          if (!existing.builtin || builtin) continue;
          // 内置源的同 id 用户文件视为上游更新覆盖，仍保留内置属性。
          registry.set(meta.id, {
            ...existing,
            name: entry.name || existing.name,
            version: entry.version || existing.version,
            file,
            override: true,
            updateUrl: entry.updateUrl || existing.updateUrl || "",
          });
          continue;
        }
        registry.set(meta.id, entry);
      }
    };

    readDirectory(this.builtinDir, true);
    readDirectory(this.userDir, false);

    for (const id of Array.from(this.runtimes.keys())) {
      if (!registry.has(id)) this.disposeRuntime(id);
    }
    this.registry = registry;
    this.activeId = registry.has(this.readActive()) ? this.readActive() : BUILTIN_ID;
  }

  get(id) {
    return this.registry.get(id || this.activeId) || null;
  }

  runtime(id) {
    const entry = this.get(id);
    if (!entry || entry.type !== "js") return null;
    let runtime = this.runtimes.get(id);
    if (!runtime || runtime.file !== entry.file) {
      if (runtime) this.disposeRuntime(id);
      runtime = new SourceRuntime({ code: fs.readFileSync(entry.file, "utf8"), meta: entry, file: entry.file });
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  disposeRuntime(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    this.runtimes.delete(id);
    try { runtime.dispose(); } catch {}
  }

  close() {
    this.stopAutoUpdate();
    for (const id of Array.from(this.runtimes.keys())) this.disposeRuntime(id);
  }

  list() {
    const state = this.readState();
    const sources = [];
    for (const source of this.registry.values()) {
      const saved = state[source.id] || {};
      const updateUrl = saved.url || source.updateUrl || "";
      sources.push({
        id: source.id,
        name: source.name,
        version: source.version,
        type: source.type,
        builtin: Boolean(source.builtin),
        hasCategories: Boolean(source.hasCategories),
        active: source.id === this.activeId,
        updateable: Boolean(updateUrl),
        autoUpdate: Boolean(updateUrl) && saved.autoUpdate !== false,
        lastCheckAt: Number(saved.lastCheckAt || 0),
        lastError: saved.lastError || "",
      });
    }
    return { active: this.activeId, sources };
  }

  async fetchSource(url, { etag = "" } = {}) {
    const target = String(url);
    const headers = { "user-agent": "hongguo-web-source-updater" };
    if (etag) headers["if-none-match"] = etag;
    let response;
    try {
      response = await safeFetch(target, {
        redirect: "follow",
        headers,
        timeoutMs: DOWNLOAD_TIMEOUT,
        allowPrivate: PRIVATE_FETCH_ALLOWED,
        message: "不允许下载内网地址的源（如确需内网，设置 ALLOW_PRIVATE_FETCH=1）",
      });
    } catch (error) {
      if (error && error.code === "BAD_URL") throw error;
      throw fail("DOWNLOAD", "下载源失败：网络错误或超时");
    }
    if (response.status === 304) {
      return { notModified: true, etag, finalUrl: response.url || target };
    }
    if (!response.ok) throw fail("DOWNLOAD", "下载源失败: HTTP " + response.status);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_SOURCE_BYTES) throw fail("TOO_BIG", "源文件不能超过 2 MB");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) throw fail("TOO_BIG", "源文件不能超过 2 MB");
    return {
      notModified: false,
      text,
      etag: response.headers.get("etag") || "",
      lastModified: response.headers.get("last-modified") || "",
      finalUrl: response.url || target,
    };
  }

  async download(url) {
    const fetched = await this.fetchSource(url);
    return fetched.text;
  }

  writeSource(id, code) {
    fs.mkdirSync(this.userDir, { recursive: true });
    const file = path.join(this.userDir, safeFileName(id) + ".js");
    const temporary = file + ".tmp";
    fs.writeFileSync(temporary, code);
    try {
      fs.renameSync(temporary, file);
    } catch {
      try { fs.unlinkSync(file); } catch {}
      fs.renameSync(temporary, file);
    }
    return file;
  }

  async selfTest(code, meta, file) {
    const runtime = new SourceRuntime({ code, meta, file });
    try {
      await runtime.call("home", [{}, false], SELF_TEST_TIMEOUT);
    } finally {
      runtime.dispose();
    }
  }

  async install({ code, url }) {
    const source = code || (url ? await this.download(url) : "");
    if (!source) throw fail("BAD_INPUT", "请提供源代码或下载地址");
    if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) throw fail("TOO_BIG", "源文件不能超过 2 MB");
    const { meta, problems } = validateMeta(source);
    if (problems.length) throw fail("INVALID_SOURCE", problems.join("；"));
    const existing = this.get(meta.id);
    if (existing && existing.builtin) throw fail("PROTECTED", "内置源不能覆盖，请换一个 id");
    // 覆盖安装前先备份旧源码：新源自检失败时恢复，避免把用户原来的可用源一起弄丢。
    let previous = null;
    if (existing && !existing.builtin) {
      try { previous = fs.readFileSync(existing.file, "utf8"); } catch { previous = null; }
    }

    this.writeSource(meta.id, source);
    this.disposeRuntime(meta.id);
    this.scan();
    const entry = this.get(meta.id);
    const runtime = this.runtime(meta.id);
    try {
      await runtime.call("home", [{}, false], SELF_TEST_TIMEOUT);
    } catch (error) {
      // 自检失败必须回滚：否则坏源会留在 data/sources，之后每次启动扫描都会带着它。
      if (previous !== null) {
        try { fs.writeFileSync(entry.file, previous); } catch { /* 恢复失败也不能掩盖原始错误 */ }
      } else {
        try { fs.unlinkSync(entry.file); } catch { /* 文件可能已被外部删除 */ }
      }
      this.disposeRuntime(meta.id);
      this.scan();
      throw fail("INVALID_SOURCE", "源初始化失败: " + ((error && error.message) || error));
    }

    const updateUrl = String(url || meta.updateUrl || "").trim();
    if (updateUrl) {
      const secure = isHttps(updateUrl);
      this.patchState(meta.id, {
        url: updateUrl,
        autoUpdate: secure,
        contentHash: sha256(source),
        lastCheckAt: Date.now(),
        lastVersion: meta.version || "",
        lastError: secure ? "" : "自动更新需要 HTTPS 源地址",
      });
    } else {
      this.deleteState(meta.id);
    }
    return this.get(meta.id) || entry;
  }

  async checkUpdate(id, { force = false } = {}) {
    const entry = this.get(id);
    if (!entry || entry.type !== "js") throw fail("NOT_JS", "不是 JS 源: " + id);
    const saved = this.stateFor(id) || {};
    const updateUrl = String(saved.url || entry.updateUrl || "").trim();
    if (!updateUrl) throw fail("BAD_INPUT", "该源没有配置上游地址");
    if (!isHttps(updateUrl)) throw fail("BAD_URL", "自动更新仅支持 HTTPS 源地址");
    if (this.updatingIds.has(id)) return { id, status: "busy" };

    this.updatingIds.add(id);
    try {
      const fetched = await this.fetchSource(updateUrl, { etag: force ? "" : saved.etag || "" });
      const checkedAt = Date.now();
      if (fetched.notModified) {
        this.patchState(id, { lastCheckAt: checkedAt, lastError: "" });
        return { id, status: "not-modified", version: entry.version };
      }

      const { meta, problems } = validateMeta(fetched.text);
      if (problems.length) throw fail("INVALID_SOURCE", "上游源不可用: " + problems.join("；"));
      if (meta.id !== entry.id) throw fail("INVALID_SOURCE", "上游源 id 不一致: " + meta.id);
      const localVersion = String(entry.version || "");
      const nextVersion = String(meta.version || "");
      if (localVersion && nextVersion && compareVersions(nextVersion, localVersion) < 0) {
        this.patchState(id, { lastCheckAt: checkedAt, lastError: "" });
        return { id, status: "older", version: localVersion, upstreamVersion: nextVersion };
      }

      const nextHash = sha256(fetched.text);
      const localHash = saved.contentHash || (entry.file ? sha256(fs.readFileSync(entry.file, "utf8")) : "");
      if (localHash === nextHash) {
        this.patchState(id, {
          lastCheckAt: checkedAt,
          lastError: "",
          contentHash: nextHash,
          etag: fetched.etag || saved.etag || "",
        });
        return { id, status: "not-modified", version: entry.version };
      }

      await this.selfTest(
        fetched.text,
        { id: entry.id, name: meta.name || entry.name, version: nextVersion },
        path.join(this.userDir, safeFileName(entry.id) + ".js"),
      );
      this.writeSource(entry.id, fetched.text);
      this.disposeRuntime(entry.id);
      this.patchState(entry.id, {
        url: updateUrl,
        autoUpdate: saved.autoUpdate !== false,
        etag: fetched.etag || "",
        lastModified: fetched.lastModified || "",
        contentHash: nextHash,
        lastCheckAt: checkedAt,
        lastVersion: nextVersion,
        lastError: "",
      });
      this.scan();
      return { id: entry.id, status: "updated", from: localVersion, to: nextVersion, name: meta.name || entry.name };
    } catch (error) {
      try {
        this.patchState(id, { lastCheckAt: Date.now(), lastError: String((error && error.message) || error) });
      } catch {}
      throw error;
    } finally {
      this.updatingIds.delete(id);
    }
  }

  async checkAllUpdates({ force = false } = {}) {
    if (this.updateAllPromise) return this.updateAllPromise;
    const state = this.readState();
    const ids = [];
    for (const entry of this.registry.values()) {
      if (entry.type !== "js") continue;
      const saved = state[entry.id] || {};
      if (saved.autoUpdate === false) continue;
      if (!(saved.url || entry.updateUrl)) continue;
      ids.push(entry.id);
    }

    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor];
        cursor += 1;
        try {
          results.push(await this.checkUpdate(id, { force }));
        } catch (error) {
          results.push({ id, status: "failed", error: String((error && error.message) || error) });
        }
      }
    };
    this.updateAllPromise = Promise.all(
      Array.from({ length: Math.min(AUTO_UPDATE_CONCURRENCY, ids.length) }, worker),
    ).then(() => results).finally(() => { this.updateAllPromise = null; });
    return this.updateAllPromise;
  }

  startAutoUpdate({ intervalMs = 6 * 60 * 60 * 1000, initialDelayMs = 15000 } = {}) {
    if (this.autoUpdateTimers.length) return;
    const run = () => {
      this.checkAllUpdates().catch((error) => {
        console.error(JSON.stringify({ event: "source_auto_update_failed", message: String((error && error.message) || error) }));
      });
    };
    const first = setTimeout(run, Math.max(0, initialDelayMs));
    const timer = setInterval(run, Math.max(60 * 1000, intervalMs));
    first.unref?.();
    timer.unref?.();
    this.autoUpdateTimers = [first, timer];
  }

  stopAutoUpdate() {
    for (const timer of this.autoUpdateTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.autoUpdateTimers = [];
  }

  setAutoUpdate(id, enabled) {
    const entry = this.get(id);
    if (!entry || entry.type !== "js") throw fail("NOT_JS", "不是 JS 源: " + id);
    const saved = this.stateFor(id) || {};
    const updateUrl = String(saved.url || entry.updateUrl || "").trim();
    if (!updateUrl) throw fail("BAD_INPUT", "该源没有配置上游地址");
    if (enabled && !isHttps(updateUrl)) throw fail("BAD_URL", "自动更新仅支持 HTTPS 源地址");
    this.patchState(id, { url: updateUrl, autoUpdate: Boolean(enabled) });
    return this.list();
  }

  setActive(id) {
    if (!this.registry.has(id)) throw fail("NOT_FOUND", "源不存在");
    this.writeActive(id);
    this.activeId = id;
    return this.list();
  }

  remove(id) {
    const entry = this.get(id);
    if (!entry) throw fail("NOT_FOUND", "源不存在");
    if (entry.builtin) throw fail("PROTECTED", "内置源不能删除");
    try { fs.unlinkSync(entry.file); } catch {}
    this.disposeRuntime(id);
    this.deleteState(id);
    if (this.activeId === id) this.writeActive(BUILTIN_ID);
    this.scan();
    return this.list();
  }

  logs(id) {
    const runtime = this.runtimes.get(id);
    const lines = runtime ? runtime.logs.slice(-80) : [];
    const saved = this.stateFor(id);
    if (saved && saved.lastError) lines.unshift("[更新] " + saved.lastError);
    return lines;
  }
}
