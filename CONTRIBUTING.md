# Contributing to NimbusBT

Thanks for helping! Please keep the project's conventions:

- **Node.js >= 22.5.0**, ESM only, no native dependencies beyond `node:sqlite`.
- Follow existing code style (see `eslint.config.js`; `npm run lint` must pass).
- Do not add dependencies unless strictly necessary. WebTorrent is pinned —
  changing it requires re-verifying the full test suite.
- No telemetry, no analytics, no external data collection. Privacy is a
  core design constraint.

## Getting started

```sh
npm install
npm run check && npm run lint
npm test
npm run test:e2e
```

## How to contribute

1. Open an issue describing the change before starting large work.
2. Branch from `main`, keep changes focused, add tests.
3. Run `npm run check`, `npm run lint`, `npm test`, `npm run test:e2e`.
4. Open a pull request referencing the issue.

## Code layout

- `src/server.js` — entry point; wires DB, settings, engine, API, WS, static UI.
- `src/engine/` — WebTorrent wrapper (`core.js`), speed scheduler, blocklist +
  scanner (`security.js`), SOCKS proxy (`proxy.js`).
- `src/api/` — REST routes, auth, WebSocket hub.
- `src/webui/` — vanilla-JS single-page app (no framework).
- `src/cli.js` — command-line interface.
- `test/unit`, `test/integration` — Node test-runner suites + e2e scripts.

## Security notes for contributors

- Never log tokens, credentials, or proxy passwords.
- New settings must be registered in `src/config.js` `DEFAULTS`.
- Anything accepting user input goes through the existing validation paths.
- Update `test/integration/security.test.js` when peer/transport behavior changes.
