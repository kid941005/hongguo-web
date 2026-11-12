# 签名算法来源与许可（server/sign）

本目录下的 `argus.cjs` / `sm3.cjs` 是红果（番茄小说 App，aid=8662）播放接口所需的
`x-argus` / `x-ladon` 签名实现，属于逆向复刻代码，**不是**上游 GPL 源的一部分。

- 来源：`fqapp` / `N3urda/hongguoTV`（`vendor/hongguo.cjs` 同源实现）
- 许可：GPL-3.0-only（与 `server/vendor/hongguo.cjs` 一致）
- 本地改动：仅调整 `require('./sm3')` → `require('./sm3.cjs')` 以适配 `type: module` 的包，
  算法常量与位运算顺序未改动（改动会直接导致签名失效）。
- 校验：`test/unit/argus.test.js` 的 6 条黄金向量（SM3 三向量、Simon 往返、Ladon 定值、argus 定值）全部通过。

用途：仅向官方播放接口取回**用户本机可播放的清晰度列表**（含 1080P），
服务端解密后按 Range 转发给浏览器，不存储、不再分发。
