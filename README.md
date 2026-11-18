# DeepSeek 助手（自托管 PWA）

官方 [chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）的二次封装：

- 补了 `manifest.json` 和图标，Chrome 可以直接“安装”，不再是快捷方式；
- 补了 `sw.js`，装好后静态界面从本地缓存启动，断网也能打开界面（API 仍需要网络）；
- 其余文件与官方 v0.1.1 一致。

API Key 和对话都只存在你自己的手机浏览器里，页面直连 `api.deepseek.com`，不经过任何第三方服务器。

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` | 入口，注册 service worker |
| `manifest.json` | PWA 清单 |
| `sw.js` | 离线缓存 |
| `icon-192.png` / `icon-512.png` | 图标 |
| `static/` | 官方前端构建产物 |
| `LICENSE` | 官方 MIT 许可证 |

## 许可证

前端来自 deepseek-ai/chat-demo，MIT。
