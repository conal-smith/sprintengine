import { expect, test } from 'vitest'
import { icnsFile, pngOfWidth } from '../../tests/icns'
import { extractIcnsPng } from './project-logo-icns'

const widthOf = (png: Buffer | null) => (png ? png.readUInt32BE(16) : null)

test('takes the smallest PNG that covers the slot', () => {
  const file = icnsFile(
    ['TOC ', Buffer.alloc(16)],
    ['ic10', pngOfWidth(1024)],
    ['icp4', pngOfWidth(16)],
    ['ic07', pngOfWidth(128)],
    ['icp6', pngOfWidth(64)],
  )
  expect(widthOf(extractIcnsPng(file, 32))).toBe(64)
})

test('takes the largest PNG when none covers the slot', () => {
  const file = icnsFile(['icp4', pngOfWidth(16)], ['is32', Buffer.alloc(64)], ['icp5', pngOfWidth(32)])
  expect(widthOf(extractIcnsPng(file, 96))).toBe(32)
})

test('returns a copy of the whole embedded PNG', () => {
  const file = icnsFile(['ic07', pngOfWidth(128)])
  const png = extractIcnsPng(file, 32)
  expect(png).toEqual(pngOfWidth(128))
  // Not a view of the file's bytes, which the caller lets go of.
  file.fill(0)
  expect(png).toEqual(pngOfWidth(128))
})

test('skips chunks that are not PNG', () => {
  // A JPEG 2000 payload, a packed bitmap, and a PNG signature with no header.
  const jpeg2000 = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])
  const file = icnsFile(
    ['ic09', Buffer.concat([jpeg2000, Buffer.alloc(32)])],
    ['it32', Buffer.alloc(64)],
    ['ic08', pngOfWidth(256).subarray(0, 12)],
  )
  expect(extractIcnsPng(file, 32)).toBeNull()
})

test('a file that is not an icns yields nothing', () => {
  expect(extractIcnsPng(pngOfWidth(128), 32)).toBeNull()
  expect(extractIcnsPng(Buffer.from('icn'), 32)).toBeNull()
  expect(extractIcnsPng(Buffer.alloc(0), 32)).toBeNull()
  expect(extractIcnsPng(Buffer.from('garbage that is long enough to walk'), 32)).toBeNull()
})

test('a truncated file yields the PNGs before the cut', () => {
  const file = icnsFile(['ic07', pngOfWidth(128)], ['ic08', pngOfWidth(256)])
  // The header still claims the whole file; the bytes stop inside the second chunk.
  expect(widthOf(extractIcnsPng(file.subarray(0, file.byteLength - 4), 200))).toBe(128)
})

test('a chunk claiming more than the file holds ends the walk', () => {
  const file = icnsFile(['ic07', pngOfWidth(128)], ['ic08', pngOfWidth(256)], ['ic09', pngOfWidth(512)])
  const second = 8 + 8 + pngOfWidth(128).byteLength
  file.writeUInt32BE(0xffffffff, second + 4)
  expect(widthOf(extractIcnsPng(file, 200))).toBe(128)
})

test('a chunk shorter than its own header ends the walk', () => {
  const file = icnsFile(['ic07', pngOfWidth(128)], ['ic08', pngOfWidth(256)])
  const second = 8 + 8 + pngOfWidth(128).byteLength
  file.writeUInt32BE(0, second + 4)
  expect(widthOf(extractIcnsPng(file, 200))).toBe(128)
})

test('a header claiming less than the file holds bounds the walk', () => {
  const file = icnsFile(['ic07', pngOfWidth(128)], ['ic08', pngOfWidth(256)])
  file.writeUInt32BE(8 + 8 + pngOfWidth(128).byteLength, 4)
  expect(widthOf(extractIcnsPng(file, 200))).toBe(128)
})
