import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import { htmlShim } from "./shims.js";

const sourceCode = String((workerData && workerData.code) || "");
const sourceFile = String((workerData && workerData.file) || "source.js");

let activeContext = null;
let nextFetchId = 1;
const pendingFetches = new Map();

function send(message) {
  try { parentPort.postMessage(message); } catch {}
}

function sendLog(line) {
  send({ type: "log", line: String(line).slice(0, 400) });
}

function serializeError(error) {
  const code = error && error.code ? String(error.code) : "SOURCE_ERROR";
  if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
    return { message: "源脚本执行超时", code: "TIMEOUT" };
  }
  return {
    message: String((error && error.message) || error || "未知错误"),
    code: code,
  };
}

function rpcFetch(payload) {
  const id = nextFetchId++;
  return new Promise((resolve, reject) => {
    pendingFetches.set(id, { resolve, reject });
    send({ type: "fetch", id, payload });
  });
}

// 这个函数会被 toString() 后放进 vm 上下文里重新编译。
// 它只能依赖 deps 参数，不能闭包引用模块作用域中的任何东西。
function createBridge(deps) {
  const hostLog = deps.log;
  const hostFetch = deps.fetch;
  const hostSetTimeout = deps.setTimeout;
  const hostClearTimeout = deps.clearTimeout;
  const HostURL = deps.URL;
  const HostURLSearchParams = deps.URLSearchParams;
  const HostTextEncoder = deps.TextEncoder;
  const HostTextDecoder = deps.TextDecoder;
  const hostAtob = deps.atob;
  const hostBtoa = deps.btoa;

  function printable(value) {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  function makeLog() {
    return function (...args) {
      try { hostLog(args.map(printable).join(" ")); } catch {}
    };
  }

  const console = {
    log: makeLog(),
    info: makeLog(),
    warn: makeLog(),
    error: makeLog(),
    debug: makeLog(),
    trace: makeLog(),
  };

  const urlStore = new WeakMap();
  const paramsStore = new WeakMap();
  const paramsCache = new WeakMap();

  class URLSearchParams {
    constructor(init) {
      try {
        let text = "";
        if (init !== undefined && init !== null) {
          if (typeof init === "string") text = init;
          else if (typeof init.forEach === "function" && typeof init.get === "function") {
            const pairs = [];
            init.forEach(function (value, key) { pairs.push(String(key) + "=" + encodeURIComponent(String(value))); });
            text = pairs.join("&");
          } else text = String(init);
        }
        paramsStore.set(this, new HostURLSearchParams(text));
      } catch (error) {
        throw new Error(String((error && error.message) || error));
      }
    }
    append(key, value) { paramsStore.get(this).append(String(key), String(value)); }
    delete(key) { paramsStore.get(this).delete(String(key)); }
    get(key) { return paramsStore.get(this).get(String(key)); }
    getAll(key) { const out = []; paramsStore.get(this).forEach(function (value, name) { if (name === String(key)) out.push(value); }); return out; }
    has(key) { return paramsStore.get(this).has(String(key)); }
    set(key, value) { paramsStore.get(this).set(String(key), String(value)); }
    sort() { paramsStore.get(this).sort(); }
    toString() { return paramsStore.get(this).toString(); }
    forEach(callback, thisArg) {
      const self = this;
      paramsStore.get(this).forEach(function (value, key) { callback.call(thisArg, value, key, self); });
    }
    entries() {
      const out = [];
      paramsStore.get(this).forEach(function (value, key) { out.push([key, value]); });
      return out[Symbol.iterator]();
    }
    keys() {
      const out = [];
      paramsStore.get(this).forEach(function (value, key) { out.push(key); });
      return out[Symbol.iterator]();
    }
    values() {
      const out = [];
      paramsStore.get(this).forEach(function (value) { out.push(value); });
      return out[Symbol.iterator]();
    }
    [Symbol.iterator]() { return this.entries(); }
  }

  class URL {
    constructor(input, base) {
      try {
        const value = base === undefined ? new HostURL(String(input)) : new HostURL(String(input), String(base));
        urlStore.set(this, value);
      } catch (error) {
        throw new Error(String((error && error.message) || error));
      }
    }
    get href() { return urlStore.get(this).href; }
    set href(value) { urlStore.get(this).href = String(value); }
    get origin() { return urlStore.get(this).origin; }
    get protocol() { return urlStore.get(this).protocol; }
    set protocol(value) { urlStore.get(this).protocol = String(value); }
    get username() { return urlStore.get(this).username; }
    set username(value) { urlStore.get(this).username = String(value); }
    get password() { return urlStore.get(this).password; }
    set password(value) { urlStore.get(this).password = String(value); }
    get host() { return urlStore.get(this).host; }
    set host(value) { urlStore.get(this).host = String(value); }
    get hostname() { return urlStore.get(this).hostname; }
    set hostname(value) { urlStore.get(this).hostname = String(value); }
    get port() { return urlStore.get(this).port; }
    set port(value) { urlStore.get(this).port = String(value); }
    get pathname() { return urlStore.get(this).pathname; }
    set pathname(value) { urlStore.get(this).pathname = String(value); }
    get search() { return urlStore.get(this).search; }
    set search(value) { urlStore.get(this).search = String(value); }
    get hash() { return urlStore.get(this).hash; }
    set hash(value) { urlStore.get(this).hash = String(value); }
    get searchParams() {
      let cached = paramsCache.get(this);
      if (!cached) {
        cached = new URLSearchParams(urlStore.get(this).searchParams.toString());
        paramsCache.set(this, cached);
      }
      return cached;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
    static canParse(input, base) {
      try {
        if (base === undefined) new HostURL(String(input));
        else new HostURL(String(input), String(base));
        return true;
      } catch { return false; }
    }
  }

  const encoderStore = new WeakMap();
  const decoderStore = new WeakMap();

  class TextEncoder {
    constructor() { encoderStore.set(this, new HostTextEncoder()); }
    get encoding() { return "utf-8"; }
    encode(input) {
      try { return Uint8Array.from(encoderStore.get(this).encode(String(input))); }
      catch (error) { throw new Error(String((error && error.message) || error)); }
    }
  }

  class TextDecoder {
    constructor(label, options) {
      try { decoderStore.set(this, new HostTextDecoder(label === undefined ? "utf-8" : String(label), options)); }
      catch (error) { throw new Error(String((error && error.message) || error)); }
    }
    get encoding() { return decoderStore.get(this).encoding; }
    get fatal() { return Boolean(decoderStore.get(this).fatal); }
    get ignoreBOM() { return Boolean(decoderStore.get(this).ignoreBOM); }
    decode(input, options) {
      try {
        if (input === undefined) return decoderStore.get(this).decode();
        let buffer;
        if (input instanceof ArrayBuffer) buffer = input;
        else if (ArrayBuffer.isView(input)) buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
        else throw new TypeError("TextDecoder.decode 参数必须是 ArrayBuffer 或 TypedArray");
        return decoderStore.get(this).decode(buffer, options);
      } catch (error) {
        throw new Error(String((error && error.message) || error));
      }
    }
  }

  async function fetch(input, options) {
    options = options || {};
    const rawUrl = typeof input === "string" ? input : String((input && input.url) || input);
    const method = String(options.method || "GET").toUpperCase();
    const headers = {};
    if (options.headers) {
      try {
        if (Array.isArray(options.headers)) {
          options.headers.forEach(function (pair) {
            if (pair && pair.length >= 2) headers[String(pair[0])] = String(pair[1]);
          });
        } else if (typeof options.headers.forEach === "function") {
          options.headers.forEach(function (value, key) { headers[key] = String(value); });
        } else {
          Object.keys(options.headers).forEach(function (key) { headers[key] = String(options.headers[key]); });
        }
      } catch {
        Object.assign(headers, options.headers);
      }
    }
    let body = options.body;
    if (body && typeof body === "object" && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
      try { body = JSON.stringify(body); } catch { body = String(body); }
    }
    const payload = {
      url: rawUrl,
      method: method,
      headers: headers,
      body: body,
      timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000,
      redirect: options.redirect || "follow",
    };
    let result;
    try {
      result = await hostFetch(payload);
    } catch (error) {
      const code = String((error && error.code) || "");
      if (code === "BAD_URL") {
        const blocked = new Error(String((error && error.message) || "地址不可访问"));
        blocked.code = "BAD_URL";
        throw blocked;
      }
      const aborted = code === "TIMEOUT" || (error && (error.name === "AbortError" || error.name === "TimeoutError"));
      const failure = new Error(aborted ? "网络请求超时" : "网络请求失败");
      failure.code = aborted ? "TIMEOUT" : "HTTP_0";
      throw failure;
    }
    const bytes = result && result.bytes ? new Uint8Array(result.bytes) : new Uint8Array(0);
    const text = String((result && result.text) || "");
    const responseHeaders = {};
    if (result && result.headers) {
      Object.keys(result.headers).forEach(function (key) { responseHeaders[key] = String(result.headers[key]); });
    }
    return {
      status: result ? result.status : 0,
      ok: Boolean(result && result.ok),
      url: String((result && result.url) || rawUrl),
      headers: responseHeaders,
      body: text,
      text: async function () { return text; },
      json: async function () {
        try { return JSON.parse(text); }
        catch {
          const failure = new Error("源接口返回的不是合法 JSON");
          failure.code = "INVALID_RESPONSE";
          throw failure;
        }
      },
      arrayBuffer: async function () {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  let nextTimerId = 1;
  const timerHandles = new Map();
  function setTimeoutWrapped(callback, delay, ...args) {
    const id = nextTimerId++;
    const handle = hostSetTimeout(function () {
      timerHandles.delete(id);
      try { callback.apply(undefined, args); } catch (error) { try { hostLog("定时器回调异常: " + String((error && error.message) || error)); } catch {} }
    }, Number(delay) || 0);
    timerHandles.set(id, handle);
    return id;
  }
  function clearTimeoutWrapped(id) {
    const handle = timerHandles.get(id);
    if (handle !== undefined) {
      timerHandles.delete(id);
      try { hostClearTimeout(handle); } catch {}
    }
  }
  function queueMicrotaskWrapped(callback) {
    Promise.resolve().then(function () {
      try { callback(); } catch (error) { try { hostLog("微任务回调异常: " + String((error && error.message) || error)); } catch {} }
    });
  }
  function atobWrapped(value) {
    try { return hostAtob(String(value)); }
    catch (error) { throw new Error(String((error && error.message) || error)); }
  }
  function btoaWrapped(value) {
    try { return hostBtoa(String(value)); }
    catch (error) { throw new Error(String((error && error.message) || error)); }
  }

  return {
    console: console,
    fetch: fetch,
    setTimeout: setTimeoutWrapped,
    clearTimeout: clearTimeoutWrapped,
    queueMicrotask: queueMicrotaskWrapped,
    atob: atobWrapped,
    btoa: btoaWrapped,
    URL: URL,
    URLSearchParams: URLSearchParams,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
  };
}

function buildContext() {
  const context = vm.createContext({}, {
    name: sourceFile,
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext("Object.defineProperty(globalThis, 'constructor', { value: Object, writable: false, configurable: false });", context);
  const factory = vm.runInContext("(" + createBridge.toString() + ")", context);
  const bridge = factory({
    log: sendLog,
    fetch: rpcFetch,
    setTimeout: function (callback, delay) { return setTimeout(callback, delay); },
    clearTimeout: function (handle) { return clearTimeout(handle); },
    URL: URL,
    URLSearchParams: URLSearchParams,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    atob: atob,
    btoa: btoa,
  });
  Object.keys(bridge).forEach(function (name) { context[name] = bridge[name]; });
  vm.runInContext(htmlShim, context, { filename: "html-shim.js", timeout: 5000 });
  vm.runInContext(
    "globalThis.__invoke = async function (method, args) {" +
      "  if (typeof spider === 'undefined' || !spider) throw new Error('spider 未定义');" +
      "  var fn = spider[method];" +
      "  if (typeof fn !== 'function') throw new Error('缺少方法 ' + method);" +
      "  var result = await fn.apply(spider, args);" +
      "  return JSON.stringify(result === undefined ? null : result);" +
      "};",
    context,
    { timeout: 5000 },
  );
  vm.runInContext(sourceCode, context, { filename: sourceFile, timeout: 5000 });
  return context;
}

parentPort.on("message", function (message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "fetch-result") {
    const pending = pendingFetches.get(message.id);
    if (!pending) return;
    pendingFetches.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error((message.error && message.error.message) || "网络请求失败");
      error.code = (message.error && message.error.code) || "HTTP_0";
      pending.reject(error);
    }
    return;
  }
  if (message.type === "invoke") {
    if (!activeContext) {
      send({ type: "result", id: message.id, error: { message: "源尚未加载", code: "SOURCE_LOAD" } });
      return;
    }
    const script = "__invoke(" + JSON.stringify(String(message.method)) + ", " + JSON.stringify(message.args || []) + ")";
    let pending;
    try { pending = vm.runInContext(script, activeContext, { timeout: 5000 }); }
    catch (error) { send({ type: "result", id: message.id, error: serializeError(error) }); return; }
    Promise.resolve(pending).then(
      function (json) { send({ type: "result", id: message.id, json: json === undefined ? null : json }); },
      function (error) { send({ type: "result", id: message.id, error: serializeError(error) }); },
    );
  }
});

function boot() {
  try {
    activeContext = buildContext();
  } catch (error) {
    send({ type: "load-error", error: serializeError(error) });
    return;
  }
  let hasInit = false;
  try {
    hasInit = vm.runInContext("typeof spider !== 'undefined' && spider && typeof spider.init === 'function'", activeContext);
  } catch (error) {
    send({ type: "load-error", error: serializeError(error) });
    return;
  }
  if (!hasInit) {
    send({ type: "ready" });
    return;
  }
  let pending;
  try { pending = vm.runInContext("__invoke('init', [])", activeContext, { timeout: 5000 }); }
  catch (error) { send({ type: "load-error", error: serializeError(error) }); return; }
  Promise.resolve(pending).then(
    function () { send({ type: "ready" }); },
    function (error) { send({ type: "load-error", error: serializeError(error) }); },
  );
}

process.on("unhandledRejection", function (reason) {
  sendLog("未处理的 Promise 拒绝: " + String((reason && reason.message) || reason));
});
process.on("uncaughtException", function (error) {
  send({ type: "load-error", error: serializeError(error) });
});

boot();
