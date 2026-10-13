/**
 * The retained pty stream of one terminal, held as UTF-8 bytes.
 *
 * It used to be an array of the JS strings node-pty handed over. Agent CLIs
 * paint with box-drawing characters and braille spinners, which V8 can only
 * store as two-byte strings, so 2.5 MB of retained UTF-8 cost up to 5 MB of JS
 * heap per terminal — and every one of those strings was a separate heap
 * object the collector had to walk. Bytes cost one byte each and live outside
 * the V8 heap.
 *
 * Small writes are copied into blocks of {@link REPLAY_BLOCK_BYTES} rather than
 * kept one Buffer each. Node slices a small `Buffer.from(string)` out of a
 * shared 8 KB pool, so retaining thousands of 40-byte ConPTY chunks that way
 * would pin thousands of 8 KB slabs; a block of our own is allocated outside
 * the pool and filled to the brim.
 *
 * Offsets are STREAM offsets: `endOffset` counts every byte ever appended, and
 * `startOffset` is where the retained window begins. A reader that remembers
 * how far it got (the renderer's delivered offset, see terminal-output-buffer)
 * can ask for exactly what it missed, and learns it has fallen off the head
 * when {@link TerminalReplayBuffer.readFrom} returns null.
 */
import { randomBytes } from 'node:crypto'

export const REPLAY_BLOCK_BYTES = 64 * 1024

/** The most bytes one UTF-16 code unit can encode to. */
const MAX_UTF8_BYTES_PER_UNIT = 3

// A buffer's generation is this run's tag and a count, so no two buffers in
// one run share one and a tag from an earlier run of the app is not mistaken
// for this run's.
const RUN_TAG = randomBytes(4).toString('hex')
let buffersMade = 0

export class TerminalReplayBuffer {
  private blocks: Buffer[] = []
  // Bytes written into each block; a block's capacity is its `length`.
  private used: number[] = []
  // UTF-16 length of what each block holds, so the snapshot's character count
  // needs no decode.
  private units: number[] = []
  // Bytes (and UTF-16 units) of blocks[0] already cut from the head.
  private headSkip = 0
  private headSkipUnits = 0

  /**
   * Which stream this buffer holds. A session can be given a fresh buffer
   * under the same id (a parked agent resumed, a terminal respawned), whose
   * counts start again from zero, so a position remembered from the old
   * stream says nothing about the new one; a reader that keeps a position
   * keeps the generation beside it and drops the position when they differ.
   * Letters and digits only.
   */
  readonly generation = `${RUN_TAG}${(++buffersMade).toString(36)}`

  retainedBytes = 0
  retainedUnits = 0
  endOffset = 0
  /**
   * UTF-16 units ever appended, never decreased by an eviction: the cursor a
   * reader polling for new text counts in (readTerminalOutputSince).
   */
  appendedUnits = 0
  /**
   * Whether the head has ever been cut — a block evicted past the budget, or an
   * oversized write trimmed. Sticky: it is what licenses the head resync in
   * materializeTerminalReplay, and a buffer cut once stays cut.
   */
  truncated = false

  get startOffset(): number {
    return this.endOffset - this.retainedBytes
  }

  /**
   * Append one pty chunk and evict past `limitBytes`. Returns the chunk's UTF-8
   * byte length, which the caller passes on instead of measuring it again.
   */
  append(data: string, limitBytes: number): number {
    if (!data) return 0
    const tailIndex = this.blocks.length - 1
    const tail = this.blocks[tailIndex]
    const tailFree = tail ? tail.length - (this.used[tailIndex] ?? 0) : 0

    // The common case: the chunk certainly fits in the open block, so write it
    // and let `write` say how many bytes it took — no separate length scan.
    if (tail && tailFree >= data.length * MAX_UTF8_BYTES_PER_UNIT) {
      const bytes = tail.write(data, this.used[tailIndex] ?? 0, 'utf8')
      this.used[tailIndex] = (this.used[tailIndex] ?? 0) + bytes
      this.units[tailIndex] = (this.units[tailIndex] ?? 0) + data.length
      this.noteAppended(bytes, data.length)
      this.evict(limitBytes)
      return bytes
    }

    const bytes = Buffer.byteLength(data, 'utf8')
    if (bytes > limitBytes) {
      this.replaceWithTailOf(data, bytes, limitBytes)
      return bytes
    }
    if (tail && tailFree >= bytes) {
      tail.write(data, this.used[tailIndex] ?? 0, 'utf8')
      this.used[tailIndex] = (this.used[tailIndex] ?? 0) + bytes
      this.units[tailIndex] = (this.units[tailIndex] ?? 0) + data.length
    } else {
      this.sealTail()
      const block = Buffer.allocUnsafeSlow(Math.max(REPLAY_BLOCK_BYTES, bytes))
      block.write(data, 0, 'utf8')
      this.blocks.push(block)
      this.used.push(bytes)
      this.units.push(data.length)
    }
    this.noteAppended(bytes, data.length)
    this.evict(limitBytes)
    return bytes
  }

  /**
   * Cut the head until at most `limitBytes` remain. Whole blocks go first, the
   * way whole chunks used to; only a lone block still over the limit is cut
   * inside, on a code point boundary.
   */
  evict(limitBytes: number): void {
    while (this.retainedBytes > limitBytes && this.blocks.length > 1) {
      const headBytes = (this.used[0] ?? 0) - this.headSkip
      const headUnits = (this.units[0] ?? 0) - this.headSkipUnits
      this.blocks.shift()
      this.used.shift()
      this.units.shift()
      this.headSkip = 0
      this.headSkipUnits = 0
      this.retainedBytes -= headBytes
      this.retainedUnits -= headUnits
      this.truncated = true
    }
    if (this.retainedBytes > limitBytes && this.blocks.length === 1) {
      const block = this.blocks[0] as Buffer
      const end = this.used[0] ?? 0
      let cut = this.headSkip + (this.retainedBytes - limitBytes)
      // Past any continuation byte the cut landed on: a half-eaten code point
      // decodes as U+FFFD, and the head of a replay is the one place that shows.
      while (cut < end && ((block[cut] ?? 0) & 0xc0) === 0x80) cut += 1
      const cutUnits = countUtf16Units(block, this.headSkip, cut)
      this.retainedBytes -= cut - this.headSkip
      this.retainedUnits -= cutUnits
      this.headSkipUnits += cutUnits
      this.headSkip = cut
      this.truncated = true
    }
  }

  /** The whole retained window, decoded. */
  materialize(): string {
    return this.decodeFrom(this.startOffset)
  }

  /**
   * Everything appended since stream offset `offset`, or null when some of it
   * has already been cut from the head (the caller then needs the whole window,
   * resynced). `offset` must be one this buffer handed out — a chunk boundary,
   * or a code point boundary inside one — so the slice never starts inside a
   * code point.
   */
  readFrom(offset: number): string | null {
    if (offset < this.startOffset || offset > this.endOffset) return null
    return this.decodeFrom(offset)
  }

  /**
   * The newest `maxBytes` of the window (all of it when smaller), starting on a
   * code point boundary. Reports whether anything older was left out.
   */
  tail(maxBytes: number): { text: string; cut: boolean } {
    if (this.retainedBytes <= maxBytes) return { text: this.materialize(), cut: false }
    return { text: this.decodeFrom(this.endOffset - maxBytes, true), cut: true }
  }

  /** Drop every retained byte. The stream offset is kept, so a stale reader still falls off the head. */
  clear(): void {
    if (this.retainedBytes > 0) this.truncated = true
    this.blocks = []
    this.used = []
    this.units = []
    this.headSkip = 0
    this.headSkipUnits = 0
    this.retainedBytes = 0
    this.retainedUnits = 0
  }

  private noteAppended(bytes: number, units: number): void {
    this.retainedBytes += bytes
    this.retainedUnits += units
    this.endOffset += bytes
    this.appendedUnits += units
  }

  // A block about to stop receiving writes gives back a large unused tail: a
  // block opened for a small write and followed by a big one would otherwise
  // hold 64 KB for a few bytes of content, for as long as it is retained.
  private sealTail(): void {
    const index = this.blocks.length - 1
    const block = this.blocks[index]
    if (!block) return
    const used = this.used[index] ?? 0
    if (block.length - used <= block.length / 4) return
    const compact = Buffer.allocUnsafeSlow(used)
    block.copy(compact, 0, 0, used)
    this.blocks[index] = compact
  }

  // One write larger than the whole budget: keep its newest `limitBytes` and
  // nothing before it.
  private replaceWithTailOf(data: string, bytes: number, limitBytes: number): void {
    const encoded = Buffer.from(data, 'utf8')
    let start = bytes - limitBytes
    while (start < bytes && ((encoded[start] ?? 0) & 0xc0) === 0x80) start += 1
    const block = Buffer.allocUnsafeSlow(bytes - start)
    encoded.copy(block, 0, start, bytes)
    const units = countUtf16Units(block, 0, block.length)
    this.blocks = [block]
    this.used = [block.length]
    this.units = [units]
    this.headSkip = 0
    this.headSkipUnits = 0
    this.retainedBytes = block.length
    this.retainedUnits = units
    this.endOffset += bytes
    this.appendedUnits += data.length
    this.truncated = true
  }

  private decodeFrom(offset: number, alignToCodePoint = false): string {
    if (this.retainedBytes === 0 || offset >= this.endOffset) return ''
    const parts: Buffer[] = []
    let blockStart = this.startOffset - this.headSkip
    for (let index = 0; index < this.blocks.length; index += 1) {
      const block = this.blocks[index] as Buffer
      const used = this.used[index] ?? 0
      const blockEnd = blockStart + used
      if (blockEnd > offset) {
        let from = Math.max(offset - blockStart, index === 0 ? this.headSkip : 0)
        if (alignToCodePoint && parts.length === 0) {
          while (from < used && ((block[from] ?? 0) & 0xc0) === 0x80) from += 1
        }
        parts.push(block.subarray(from, used))
      }
      blockStart = blockEnd
    }
    if (parts.length === 1) return (parts[0] as Buffer).toString('utf8')
    return Buffer.concat(parts).toString('utf8')
  }
}

/**
 * How many UTF-16 code units the UTF-8 bytes in [start, end) decode to: one per
 * code point, two for one outside the BMP (a four-byte sequence). Only run over
 * bytes being cut from a lone block, never per append.
 */
function countUtf16Units(block: Buffer, start: number, end: number): number {
  let units = 0
  for (let index = start; index < end; index += 1) {
    const byte = block[index] ?? 0
    if ((byte & 0xc0) === 0x80) continue
    units += byte >= 0xf0 ? 2 : 1
  }
  return units
}
