# Security Policy

## Reporting a vulnerability

Please report security issues privately — do **not** open a public issue.
Email the maintainers or open a private advisory on GitHub
(Security → "Report a vulnerability").

Please include:
- The affected version and how to reproduce
- Impact assessment if known

## Security model

- The web UI / REST API is protected by a bearer token (`x-nimbus-token`
  header or `?token=` query). Keep the token secret.
- Bind the server to `127.0.0.1` unless you explicitly need LAN/remote access.
  When exposing it, always keep a strong token set.
- The API token, SOCKS proxy credentials, and other secrets live only in the
  local SQLite database (`data/`), which is **not** committed to the repository.
- Peer traffic can optionally be routed through a SOCKS4/5 proxy
  (proxy-side DNS). Tracker announces use HTTPS.
- Invalid peer handshakes are rejected by the engine
  (regression-tested in `test/integration/security.test.js`).

## Supported versions

The latest `main` branch is supported. Report issues against the newest
release whenever possible.
