# Third-party source

`hongguo.cjs` is based on `spider/js/红果果[短].js` from
https://github.com/woshishiq1/drpys/tree/22261adfa31435e3b3ef5a730b8a2a75bcaf1715
retrieved on 2026-09-21. Upstream license: GPL-3.0; see LICENSE.drpys.
The filename was changed for local loading. The original header and comments remain.

Local modifications (hongguo-web, 2026-11): adapted playback address discovery to the
`video_tab` endpoint (new per-request device registration, tab query signing, and a
`codec_type=3` fallback for HEVC renditions); 2026-11-11 that endpoint was closed too, so
playback now prefers the official website player channel
(`POST https://hongguoduanju.com/api/video/protected/fallback-play-info` -> plain
non-CENC MP4), and only falls back to the App `video_tab`/`multi_video_model` chain when
that fails. Changes are confined to the playback layer; the upstream original and
GPL-3.0 license are preserved in this directory.
The source is loaded only by the Node content service, not bundled into the TV app.
The service adapter and HTTP layer are original project code.

The Android/tvOS project skeleton is derived from
@react-native-tvos/template-tv 0.81.0-0 (MIT); see LICENSE.template-tv.
