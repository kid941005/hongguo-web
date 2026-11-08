import vm from "node:vm";
import { htmlShim } from "./shims.js";
import { fail } from "../errors.mjs";

// 元信息与核心方法约定，与糖葫芦（THLRedGuo / CatPaw）单文件源保持一致。
const RE_ID = /\bid\s*:\s*["']([^"']+)["']/;
const RE_NAME = /\bname\s*:\s*["']([^"']+)["']/;
const RE_VER = /\bversion\s*:\s*["']([^"']+)["']/;
const CORE_METHODS = ["home", "category", "detail", "search", "play"];
const LOG_LIMIT = 120;
const LOG_CHARS = 400;

const nodeFetch = globalThis.fetch;

export function parseMeta(code) {
  const id = RE_ID.exec(code);
  const name = RE_NAME.exec(code);
  const version = RE_VER.exec(code);
  return { id: id ? id[1] : "", name: name ? name[1] : "", version: version ? version[1] : "" };
}

export function validateMeta(code) {
  const meta = parseMeta(code);
  const problems = [];
  if (!meta.id) problems.push('缺少 id: "..."');
  if (!meta.name) problems.push('缺少 name: "..."');
  if (meta.version && !/^\d{1,9}\.\d{1,9}\.\d{1,9}/.test(meta.version)) problems.push("version 不是 x.y.z 形式");
  if (!/\bspider\b/.test(code)) problems.push("没有 spider 对象");
  if (/^\s*(import|export)\s/m.test(code)) problems.push("含 ES Module 语法（沙箱不支持）");
  if (/\brequire\s*\(/.test(code)) problems.push("含 require()（沙箱不支持）");
  const missing = CORE_METHODS.filter((method) => !new RegExp("\\b" + method + "\\s*[:(]").test(code));
  if (missing.length) problems.push("缺少方法: " + missing.join(", "));
  return { meta, problems };
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function makeFetch() {
  return async function fetch(input, options = {}) {
    const url = typeof input === "string" ? input : String((input && input.url) || input);
    const method = String(options.method || "GET").toUpperCase();
    const headers = { ...(options.headers || {}) };
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let body = options.body;
      if (body && typeof body === "object" && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
        try { body = JSON.stringify(body); } catch { body = String(body); }
      }
      const response = await nodeFetch(url, {
        method,
        headers,
        body,
        redirect: options.redirect || "follow",
        signal: controller.signal,
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const text = buffer.toString("utf8");
      const responseHeaders = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      return {
        status: response.status,
        ok: response.ok,
        url: response.url || url,
        headers: responseHeaders,
        body: text,
        text: async () => text,
        json: async () => { try { return JSON.parse(text); } catch { return {}; } },
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      };
    } catch (error) {
      const aborted = error && error.name === "AbortError";
      const failure = new Error(aborted ? "网络请求超时" : "网络请求失败");
      failure.code = aborted ? "TIMEOUT" : "HTTP_0";
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail("TIMEOUT", "源响应超时: " + label)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// 每个源一个常驻 vm 上下文：模块级状态（缓存、会话）在多次调用之间保留。
export class SourceRuntime {
  constructor({ code, meta, file }) {
    this.code = code;
    this.meta = meta;
    this.file = file;
    this.context = null;
    this.loading = null;
    this.logs = [];
  }

  pushLog(line) {
    this.logs.push(String(line).slice(0, LOG_CHARS));
    while (this.logs.length > LOG_LIMIT) this.logs.shift();
  }

  // 并发安全：同时到达的请求共享同一次装载。
  async ensure() {
    if (this.context) return;
    if (!this.loading) {
      this.loading = this.load().finally(() => { this.loading = null; });
    }
    await this.loading;
  }

  async load() {
    const context = vm.createContext({
      console: {
        log: (...args) => this.pushLog(args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")),
        info: (...args) => this.pushLog(args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")),
        warn: (...args) => this.pushLog(args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")),
        error: (...args) => this.pushLog(args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")),
        debug: (...args) => this.pushLog(args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")),
        trace: (...args) => this.pushLog(args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")),
      },
      fetch: makeFetch(),
      URL,
      URLSearchParams,
      TextDecoder,
      TextEncoder,
      atob: (value) => Buffer.from(String(value), "base64").toString("binary"),
      btoa: (value) => Buffer.from(String(value), "binary").toString("base64"),
      setTimeout,
      clearTimeout,
      queueMicrotask,
    });

    vm.runInContext(htmlShim, context, { filename: "html-shim.js" });
    vm.runInContext(
      'globalThis.__invoke = async function (method, args) {' +
        '  if (typeof spider === "undefined" || !spider) throw new Error("spider 未定义");' +
        '  var fn = spider[method];' +
        '  if (typeof fn !== "function") throw new Error("缺少方法 " + method);' +
        '  var result = await fn.apply(spider, args);' +
        '  return JSON.stringify(result === undefined ? null : result);' +
        '};',
      context,
    );

    try {
      vm.runInContext(this.code, context, { filename: this.file || "source.js", timeout: 5000 });
      this.context = context;
      const hasInit = vm.runInContext(
        'typeof spider !== "undefined" && spider && typeof spider.init === "function"',
        context,
      );
      if (hasInit) await this.call("init", [], 30000);
    } catch (error) {
      this.context = null;
      const message = String((error && error.message) || error);
      throw fail("SOURCE_LOAD", "源脚本执行失败: " + message);
    }
  }

  async call(method, args = [], timeoutMs = 40000) {
    await this.ensure();
    const started = Date.now();
    const script = "__invoke(" + JSON.stringify(method) + ", " + JSON.stringify(args) + ")";
    try {
      const pending = vm.runInContext(script, this.context, { timeout: 5000 });
      pending.catch(() => {});
      const json = await withTimeout(pending, timeoutMs, method);
      this.pushLog("[" + method + "] ok " + (Date.now() - started) + "ms");
      if (json == null) return null;
      try { return JSON.parse(json); } catch { return json; }
    } catch (error) {
      this.pushLog("[" + method + "] 失败 " + (Date.now() - started) + "ms: " + ((error && error.message) || error));
      throw error;
    }
  }
}
