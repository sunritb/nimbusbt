# NimbusBT

A modern, privacy-first, open-source BitTorrent client with a web UI and a CLI.
Built on Node.js + WebTorrent. Works on macOS, Linux, and Windows.

- **Website:** https://sunritb.github.io/nimbusbt
- **Releases:** https://github.com/sunritb/nimbusbt/releases
- **Packages:** https://github.com/sunritb/nimbusbt/pkgs/container/nimbusbt
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md)
- **Security:** see [SECURITY.md](SECURITY.md)

## Features

| Feature | Status |
| --- | :---: |
| Add torrents from `.torrent` files, magnet links, or local paths | ✓ |
| Download, seed, pause / resume, recheck, remove | ✓ |
| File priority (download only what you need) | ✓ |
| DHT (BEP-5), PEX (BEP-11), LSD (BEP-14), uTP (BEP-29) | ✓ |
| HTTP + UDP trackers, web seeds (BEP-19), magnet links | ✓ |
| IP blocklist (PeerGuardian / PGL format) | ✓ |
| Time-of-day bandwidth scheduling + speed limits | ✓ |
| Private torrent mode (disables DHT/PEX) | ✓ |
| SOCKS4/5 proxy for peer traffic (proxy-side DNS) | ✓ |
| Malware scan hook + VirusTotal lookup by info hash | ✓ |
| Responsive web UI (PWA) with live WebSocket updates | ✓ |
| REST + WebSocket API, bearer-token auth, CORS, CSP | ✓ |
| CLI (`nimbusbt add/list/status/...`) | ✓ |
| Cross-platform desktop launch (`npm run desktop`) | ✓ |

Known limitation: wire encryption (MSE/PE) is not provided by the underlying
WebTorrent stack. See the **Security** tab in the web UI for the full posture.

## Install

```sh
npm install
npm start            # start the web UI + engine
npm run desktop      # start server and open the browser
npm run cli -- help  # command-line usage
```

Requirements: Node.js >= 22.5.0 (uses built-in `node:sqlite`).

## Usage

Start the server, then open `http://127.0.0.1:5050/` (token auto-generated on
first run, shown in the server banner). From the CLI:

```sh
npm run cli -- add <magnet-or-torrent-file-or-url>
npm run cli -- list
npm run cli -- status <infoHash>
npm run cli -- pause <infoHash>
npm run cli -- resume <infoHash>
npm run cli -- settings
npm run cli -- remove <infoHash>
```

Configuration lives in `data/nimbusbt.db` (SQLite). Settings such as the API
token, blocklist, proxy, and speed schedule can be changed from the web UI
(Settings) or `npm run cli -- settings`.

## API

- `GET /api/health`
- `GET /api/torrents`, `POST /api/torrents` (raw `.torrent` body or JSON `{magnet}`)
- `GET /api/torrents/:hash`, `POST /api/torrents/:hash/pause|resume|recheck`, `DELETE /api/torrents/:hash`
- `GET/PUT /api/settings`
- `WS /ws` — live status + `torrent` / `done` / `removed` events

Authenticate with the header `x-nimbus-token: <token>` (or `?token=`).

## Security

- Bearer-token auth for all `/api` routes; strict CSP, no inline scripts.
- SOCKS4/5 proxy tunnels peer traffic; invalid handshakes are rejected
  (regression-tested in `test/integration/security.test.js`).
- See the **Security** tab in the UI, and the audit checklist in the spec.

## Development

```sh
npm run check    # syntax check all source files
npm run lint     # eslint
npm test         # unit + integration tests
npm run test:e2e # end-to-end server + CLI tests
```

## Support the project

Report issues, request features, and contribute at the project repository.
See [CONTRIBUTORS.md](CONTRIBUTORS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

Created and maintained by [@sunritb](https://github.com/sunritb).
