import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export const NAME = pkg.name
export const VERSION = pkg.version
export const ENGINE = 'webtorrent'
export const PROTOCOLS = [
  'BitTorrent v1',
  'magnet',
  'DHT (BEP-5)',
  'PEX (BEP-11)',
  'LSD (BEP-14)',
  'HTTP/UDP trackers',
  'Web seeds (BEP-19)',
  'uTP (BEP-29, opt-in)'
]
