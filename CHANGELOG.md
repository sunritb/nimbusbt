# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-16

### Performance

- Skip the per-second status snapshot when nothing subscribes to `status`
  (the WS hub has its own ticker).
- Skip status snapshotting entirely while no WebSocket clients are connected.
- Count bitfield bits per byte with a lookup table instead of one `get()` per
  bit in `snapshot()`.
- Persist all bitfields in a single SQLite transaction on the 30s tick.
- Cache hot prepared statements (piece-verify, pause/resume/remove, priorities).
- Tune SQLite PRAGMAs for the write-heavy path (`synchronous=NORMAL`,
  `journal_size_limit`, `temp_store=MEMORY`, `busy_timeout`).
- Re-apply bandwidth schedule exactly at rule boundaries instead of polling
  every 30s; the scheduler idles entirely when no rules are configured.
- Restore persisted torrents concurrently (bounded) at startup.
- WebSocket hub uses `perMessageDeflate` (level 3) and skips clients whose
  send buffer has grown past a high-water mark.

### Fixes

- Persist torrent bitfields MSB-first to match WebTorrent's BitField v5, so
  restarts no longer misread every piece and re-download data (regression
  covered by `test/unit/bitfield.test.js`).
- Bound malware-scanner stdout/stderr accumulation to 64 KiB and SIGKILL a
  scanner that exceeds its run timeout.
- Make `Settings.setMany` atomic: validate every key before any write and
  commit the batch in one transaction.
- Never route unix-socket `net.connect` calls through the SOCKS proxy.
- Normalize `announce` query/body values into arrays for WebTorrent.
- Destroy orphan torrents when a metadata fetch times out; unref the wait
  timer.
- Rate-limit failed API token attempts per source IP (429 past the threshold).

### Features

- New CLI commands: `seed`, `recheck`, `scan`, `summary`, and `--json` output
  for `list`, `status` and `settings`.
- `/api/torrents` accepts `state` filtering and `limit`/`offset` pagination;
  new `/api/torrents/summary` aggregates dashboard counters.
- `/api/log` returns real entries with `limit`/`level` filters and a `DELETE`
  to clear; the WS hub reads the same ring buffer instead of duplicating it.
- `/api/health` reports version, uptime, RSS and Node/platform versions.
- Web UI About tab and blocklist UA read the version from the build; the
  service worker cache name is version-stamped to bust stale app shells.

## [0.1.0] - 2026-08-08

- Initial release: secure BitTorrent client with web UI, CLI, SOCKS proxy,
  blocklists, scheduling, malware-scan hooks, and REST + WebSocket APIs.

[Unreleased]: https://github.com/sunritb/nimbusbt/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sunritb/nimbusbt/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sunritb/nimbusbt/releases/tag/v0.1.0
