import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countSetBits, serializeBitfield } from '../../src/engine/bitfield.js'

function makeBitfield (bytes) {
  // Minimal { get } shim matching BitField v5 (MSB-first) semantics.
  const buf = new Uint8Array(bytes)
  return {
    buffer: buf,
    get: i => {
      const byte = buf[i >> 3]
      return byte !== undefined && (byte & (0x80 >> (i & 7))) !== 0
    }
  }
}

test('countSetBits matches per-bit get() across random sizes', () => {
  let seed = 12345
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let trial = 0; trial < 300; trial++) {
    const bytes = Math.floor(rand() * 40) + 1
    const data = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) data[i] = Math.floor(rand() * 256)
    const total = Math.floor(rand() * (bytes * 8)) + 1
    const bf = makeBitfield(data)
    let expected = 0
    for (let i = 0; i < total; i++) if (bf.get(i)) expected++
    assert.equal(countSetBits(bf.buffer, total), expected)
  }
})

test('serializeBitfield round-trips through the BitField v5 reader', () => {
  const source = new Uint8Array([0b10110010, 0b00000001, 0b11001100])
  const bf = makeBitfield(source)
  for (const total of [16, 17, 23, 24]) {
    const stored = serializeBitfield(bf, total)
    assert.equal(stored.length, Math.ceil(total / 8))
    const restored = makeBitfield(stored)
    for (let i = 0; i < total; i++) assert.equal(restored.get(i), bf.get(i))
  }
})

test('serializeBitfield masks unused trailing bits', () => {
  const bf = makeBitfield([0xff])
  const stored = serializeBitfield(bf, 3)
  assert.equal(stored[0], 0b11100000)
  assert.equal(countSetBits(stored, 3), 3)
  assert.equal(countSetBits(stored, 8), 3)
})

test('countSetBits handles empty buffer and zero total', () => {
  assert.equal(countSetBits(null, 8), 0)
  assert.equal(countSetBits(new Uint8Array(0), 8), 0)
  assert.equal(countSetBits(new Uint8Array([0xff]), 0), 0)
})
