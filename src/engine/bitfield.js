/**
 * Bitfield helpers for the BitField v5 representation used by WebTorrent.
 *
 * BitField v5 stores bit *i* as the `(i % 8)`-th most-significant bit of
 * byte `i >> 3` (MSB-first). These helpers must agree with that ordering or
 * persisted bitfields get re-read with every piece offset wrong.
 */

const POPCOUNT = new Uint8Array(256)
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1]

/**
 * Count set bits in a raw bitfield byte buffer, counting only `total` bits.
 * @param {Uint8Array|Buffer} buf
 * @param {number} total number of bits that are meaningful
 * @returns {number}
 */
export function countSetBits (buf, total) {
  if (!buf) return 0
  const full = Math.min(Math.floor(total / 8), buf.length)
  let n = 0
  for (let i = 0; i < full; i++) n += POPCOUNT[buf[i]]
  const tail = total & 7
  if (tail && full < buf.length) {
    n += POPCOUNT[buf[full] & (0xff << (8 - tail))]
  }
  return n
}

/**
 * Serialize a `{ get(i) -> boolean }` bitfield into a MSB-first byte buffer,
 * i.e. the format BitField v5 / WebTorrent consume on restore.
 * @param {{get: (i: number) => boolean}} bitfield
 * @param {number} total number of bits
 * @returns {Uint8Array}
 */
export function serializeBitfield (bitfield, total) {
  const bytes = new Uint8Array(Math.ceil(total / 8))
  for (let i = 0; i < total; i++) {
    if (bitfield.get(i)) bytes[i >> 3] |= (0x80 >> (i & 7))
  }
  return bytes
}
