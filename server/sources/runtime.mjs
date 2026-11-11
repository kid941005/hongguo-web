import { Worker } from "node:worker_threads";
import { fail } from "../errors.mjs";
import { safeFetch, PRIVATE_FETCH_ALLOWED } from "../net.mjs";

// 元信息与核心方法约定，与糖葫芦（THLRedGuo / CatPaw）单文件源保持一致。
const RE_ID = /\bid\s*:\s*["']([^"']+)["']/;
const RE_NAME = /\bname\s*:\s*["']([^"']+)["']/;
const RE_VER = /\bversion\s*:\s*["']([^"']+)["']/;
const RE_UPDATE_URL = /\bupdateUrl\s*:\s*["']([^"']+)["']/;
const CORE_METHODS = ["home", "category", "detail", "search", "play"];
const LOG_LIMIT = 120;
const LOG_CHARS = 400;

const WORKER_LOAD_TIMEOUT = 45000;
const WORKER_OLD_MB = Math.max(32, Number(process.env.SOURCE_WORKER_MAX_OLD_MB) || 64);
const WORKER_YOUNG_MB = Math.max(8, Number(process.env.SOURCE_WORKER_MAX_YOUNG_MB) || 16);
const WORKER_STACK_MB = Math.max(2, Number(process.env.SOURCE_WORKER_STACK_MB) || 4);
const WORKER_URL = new URL("./worker.mjs", import.meta.url);

export function parseMeta(code) {
  const id = RE_ID.exec(code);
  const name = RE_NAME.exec(code);
  const version = RE_VER.exec(code);
  const updateUrl = RE_UPDATE_URL.exec(code);
  return {
    id: id ? id[1] : "",
    name: name ? name[1] : "",
    version: version ? version[1] : "",
    updateUrl: updateUrl ? updateUrl[1] : "",
  };
}

export function validateMeta(code) {
  const meta = parseMeta(code);
  const problems = [];
  if (!meta.id) problems.push('缺少 id: "..."');
  else if (!/^[\w.\-]{1,64}$/.test(meta.id)) problems.push("id 只能包含字母、数字、下划线、点、横线（1–64 位）");
  if (!meta.name) problems.push('缺少 name: "..."');
  if (meta.version && !/^\d{1,9}\.\d{1,9}\.\d{1,9}/.test(meta.version)) problems.push("version 不是 x.y.z 形式");
  if (!/\bspider\b/.test(code)) problems.push("没有 spider 对象");
  if (/^\s*(import|export)\s/m.test(code)) problems.push("含 ES Module 语法（沙箱不支持）");
  if (/\brequire\s*\(/.test(code)) problems.push("含 require()（沙箱不支持）");
  const missing = CORE_METHODS.filter((method) => !new RegExp("\\b" + method + "\\s*[:(]").test(code));
  if (missing.length) problems.push("缺少方法: " + missing.join(", "));
  return { meta, problems };
}

async function performFetch(payload) {
  const options = payload || {};
  const response = await safeFetch(String(options.url || ""), {
    method: String(options.method || "GET").toUpperCase(),
    headers: options.headers || {},
    body: options.body,
    redirect: options.redirect || "follow",
    timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000,
    allowPrivate: PRIVATE_FETCH_ALLOWED,
    message: "源脚本不允许访问内网地址（如确需内网，设置 ALLOW_PRIVATE_FETCH=1）",
  });
  const MAX_FETCH_BYTES = 32 * 1024 * 1024;
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_FETCH_BYTES) {
    try { response.discard(); } catch {}
    throw fail("TOO_BIG", "源脚本请求的响应超过 32MB 上限");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FETCH_BYTES) throw fail("TOO_BIG", "源脚本请求的响应超过 32MB 上限");
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return {
    status: response.status,
    ok: response.ok,
    url: response.url,
    headers: headers,
    text: buffer.toString("utf8"),
    bytes: new Uint8Array(buffer),
  };
}

// 每个源一个独立 worker_threads isolate：模块级状态（缓存、会话）在多次调用之间保留。
// 主线程只通过消息通道执行 fetch/返回结果；源本身拿不到主进程的 require/process/文件系统。
export class SourceRuntime {
  constructor({ code, meta, file }) {
    this.code = code;
    this.meta = meta;
    this.file = file;
    this.worker = null;
    this.loading = null;
    this.readyState = "idle";
    this.pendingCalls = new Map();
    this.callSeq = 0;
    this.logs = [];
    this.disposed = false;
  }

  pushLog(line) {
    this.logs.push(String(line).slice(0, LOG_CHARS));
    while (this.logs.length > LOG_LIMIT) this.logs.shift();
  }

  // 并发安全：同时到达的请求共享同一次装载。
  async ensure() {
    if (this.disposed) throw fail("SOURCE_LOAD", "源已释放");
    if (this.readyState === "ready" && this.worker) return;
    if (!this.loading) {
      this.loading = this.startWorker().finally(() => { this.loading = null; });
    }
    await this.loading;
  }

  startWorker() {
    if (this.disposed) return Promise.reject(fail("SOURCE_LOAD", "源已释放"));
    this.terminateWorker();
    let worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: { code: this.code, file: this.file },
        resourceLimits: {
          maxOldGenerationSizeMb: WORKER_OLD_MB,
          maxYoungGenerationSizeMb: WORKER_YOUNG_MB,
          stackSizeMb: WORKER_STACK_MB,
        },
      });
    } catch (error) {
      return Promise.reject(fail("SOURCE_LOAD", "源运行时创建失败: " + String((error && error.message) || error)));
    }
    worker.unref();
    this.worker = worker;
    this.readyState = "starting";

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.terminateWorker();
          reject(error);
        } else {
          this.readyState = "ready";
          resolve();
        }
      };
      const timer = setTimeout(() => {
        finish(fail("SOURCE_LOAD", "源脚本加载超时"));
      }, WORKER_LOAD_TIMEOUT);

      worker.on("message", (message) => {
        if (!message || typeof message !== "object") return;
        if (message.type === "log") { this.pushLog(message.line); return; }
        if (message.type === "ready") { finish(); return; }
        if (message.type === "load-error") {
          finish(fail("SOURCE_LOAD", "源脚本执行失败: " + ((message.error && message.error.message) || "未知错误")));
          return;
        }
        if (message.type === "crash") {
          const failure = fail("SOURCE_CRASH", "源进程运行期异常: " + ((message.error && message.error.message) || "未知错误"));
          if (!settled) {
            finish(failure);
            return;
          }
          if (this.worker === worker) {
            this.worker = null;
            this.readyState = "dead";
          }
          this.failPending(failure);
          // 运行期异常后该 isolate 状态不可信，直接回收，避免留下半死进程。
          try { const pending = worker.terminate(); if (pending && typeof pending.catch === "function") pending.catch(() => {}); } catch {}
          return;
        }
        if (message.type === "fetch") { this.handleFetch(message); return; }
        if (message.type === "result") { this.resolveCall(message); return; }
      });
      worker.on("error", (error) => {
        const failure = error && error.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? fail("SOURCE_OOM", "源脚本内存超限")
          : fail("SOURCE_LOAD", "源脚本执行失败: " + String((error && error.message) || error));
        if (!settled) {
          finish(failure);
          this.failPending(failure);
          return;
        }
        // 已就绪后发生错误（含运行期 OOM）：标记不可用并让所有在途调用失败。
        if (this.worker === worker) {
          this.worker = null;
          this.readyState = "dead";
        }
        this.failPending(failure);
      });
      worker.on("exit", (code) => {
        if (!settled) {
          finish(fail("SOURCE_LOAD", "源进程异常退出: " + code));
          return;
        }
        if (this.worker === worker) {
          this.worker = null;
          this.readyState = "dead";
          this.failPending(fail("SOURCE_CRASH", "源进程异常退出: " + code));
        }
      });
    });
  }

  handleFetch(message) {
    const worker = this.worker;
    performFetch(message.payload).then(
      (result) => {
        try { if (worker && this.worker === worker) worker.postMessage({ type: "fetch-result", id: message.id, ok: true, result: result }); } catch {}
      },
      (error) => {
        const failure = {
          code: (error && error.code) || "HTTP_0",
          message: String((error && error.message) || "网络请求失败"),
        };
        try { if (worker && this.worker === worker) worker.postMessage({ type: "fetch-result", id: message.id, ok: false, error: failure }); } catch {}
      },
    );
  }

  resolveCall(message) {
    const pending = this.pendingCalls.get(message.id);
    if (!pending) return;
    this.pendingCalls.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(String((message.error && message.error.message) || "源执行失败"));
      error.code = (message.error && message.error.code) || "SOURCE_ERROR";
      this.pushLog("[" + pending.method + "] 失败 " + (Date.now() - pending.started) + "ms: " + error.message);
      pending.reject(error);
      return;
    }
    this.pushLog("[" + pending.method + "] ok " + (Date.now() - pending.started) + "ms");
    const json = message.json;
    if (json == null) { pending.resolve(null); return; }
    try { pending.resolve(JSON.parse(json)); } catch { pending.resolve(json); }
  }

  failPending(error) {
    const calls = Array.from(this.pendingCalls.values());
    this.pendingCalls.clear();
    for (const pending of calls) {
      clearTimeout(pending.timer);
      try { pending.reject(error); } catch {}
    }
  }

  terminateWorker() {
    const worker = this.worker;
    this.worker = null;
    this.readyState = "dead";
    if (!worker) return;
    try { worker.removeAllListeners(); } catch {}
    try {
      const pending = worker.terminate();
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch {}
  }

  async call(method, args = [], timeoutMs = 40000) {
    await this.ensure();
    if (!this.worker || this.readyState !== "ready") throw fail("SOURCE_LOAD", "源运行时不可用");
    const id = ++this.callSeq;
    const started = Date.now();
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        this.pushLog("[" + method + "] 超时 " + (Date.now() - started) + "ms");
        const error = fail("TIMEOUT", "源响应超时: " + method);
        // 只有最后一个在途调用超时才回收 worker；否则仅结束当前请求，避免误伤并发调用。
        if (this.pendingCalls.size === 0) {
          this.terminateWorker();
          this.failPending(error);
        }
        reject(error);
      }, timeoutMs);
      this.pendingCalls.set(id, { resolve: resolve, reject: reject, timer: timer, method: method, started: started });
      try {
        worker.postMessage({ type: "invoke", id: id, method: method, args: args });
      } catch (error) {
        clearTimeout(timer);
        this.pendingCalls.delete(id);
        reject(fail("SOURCE_LOAD", "源运行时不可用: " + String((error && error.message) || error)));
      }
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.failPending(fail("SOURCE_LOAD", "源已释放"));
    this.terminateWorker();
  }
}
