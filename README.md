# Netbridge for macOS

Netbridge is a small desktop dashboard for Flowseal's separate macOS tools:

- **ZapretMac** for YouTube access: [official releases](https://github.com/Flowseal/zapret-mac-discord-youtube/releases)
- **TG WS Proxy** for Telegram: [official releases](https://github.com/Flowseal/tg-ws-proxy/releases)

Install each upstream app from its official release page. Netbridge's **Open** button opens that installed app; it does not silently install, elevate, or start a system daemon. Start or stop ZapretMac from its menu bar menu. TG WS Proxy runs from its own menu bar app. The Telegram local endpoint defaults to `127.0.0.1:1443`.

## Run from source

Requires macOS, Node.js 22.12 or newer, and npm.

```sh
npm install
npm run dev
```

Create the renderer bundle with `npm run build`, or build macOS `.dmg` and `.zip` packages with `npm run dist:mac`. These local packages are unsigned; macOS may require a user-confirmed first launch. Developer ID signing and notarization require the owner's Apple Developer credentials and are not included.

Theme preferences are stored locally in browser storage. No credentials or proxy secrets are collected by Netbridge.
