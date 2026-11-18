'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTexture, decodeLz4Block, MAX_DECODED_BYTES } = require('../texContainer.cjs');

// Hand-built metadata and block vectors cover container versions, bounds and overlapping LZ4 matches.
const i32 = value => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; };
const nul = value => Buffer.from(value + '\0');
function texture({ version = 3, format = 0, imageFormat = 13, videoFlag = 0, compressed = 0, decodedLength = 0, width = 3840, height = 2160, payload = Buffer.from([137, 80, 78, 71]), mp4Layout = false } = {}) {
  const parts = [nul('TEXV0005'), nul('TEXI0001'), i32(format), i32(2), i32(4096), i32(4096), i32(width), i32(height), i32(0), nul(`TEXB000${version}`), i32(1)];
  if (version >= 3) parts.push(i32(imageFormat));
  if (version >= 4) parts.push(i32(videoFlag));
  parts.push(i32(1));
  if (mp4Layout) parts.push(i32(1), i32(2), nul('{"enabled":true}'), i32(1));
  parts.push(i32(width), i32(height));
  if (version >= 2) parts.push(i32(compressed), i32(decodedLength));
  parts.push(i32(payload.length), payload);
  return Buffer.concat(parts);
}

test('TEX versions 1..4 retain exact mip payload offsets and record unknown raw formats', () => {
  for (const version of [1, 2, 3, 4]) {
    const bytes = texture({ version });
    const parsed = parseTexture(bytes);
    const mip = parsed.images[0].mips[0];
    assert.equal(parsed.version, version);
    assert.deepEqual(parsed.header.imageWidth, 3840);
    assert.equal(mip.length, 4);
    assert.deepEqual(bytes.subarray(mip.start, mip.start + mip.length), Buffer.from([137, 80, 78, 71]));
    assert.equal(parsed.partial, false);
  }
  const unknown = parseTexture(texture({ format: 42, imageFormat: -1 }));
  assert.equal(unknown.header.formatName, 'unknown-42');
  assert.equal(unknown.knownFormat, false);
});

test('TEX metadata-only prefixes do not require a complete large image payload', () => {
  const bytes = texture({ payload: Buffer.alloc(1024 * 1024) });
  const prefix = bytes.subarray(0, 128);
  const parsed = parseTexture(prefix, { metadataOnly: true, totalLength: bytes.length });
  assert.equal(parsed.partial, true);
  assert.equal(parsed.imageFormat, 13);
  assert.equal(parsed.images[0].mips[0].start, 87);
  assert.equal(parsed.images[0].mips[0].length, 1024 * 1024);
  assert.throws(() => parseTexture(prefix), { code: 'tex-payload-bounds' });
});

test('TEXB0004 MP4 metadata and non-video v4 payloads follow distinct measured layouts', () => {
  const video = parseTexture(texture({ version: 4, imageFormat: -1, videoFlag: 1, mp4Layout: true }));
  assert.equal(video.imageFormat, 35);
  assert.equal(video.isMp4, true);
  assert.equal(video.images[0].mips[0].condition, '{"enabled":true}');
  const png = parseTexture(texture({ version: 4, imageFormat: 13 }));
  assert.equal(png.isMp4, false);
  assert.equal(png.images[0].mips[0].condition, null);
});

test('TEX rejects malformed signatures, oversized dimensions, compression and payload bounds', () => {
  const signature = texture(); signature[0] = 0;
  assert.throws(() => parseTexture(signature), { code: 'tex-unknown-magic' });
  assert.throws(() => parseTexture(texture({ width: 0 })), { code: 'tex-dimension-limit' });
  assert.throws(() => parseTexture(texture({ compressed: 2 })), { code: 'tex-unknown-compression' });
  assert.throws(() => parseTexture(texture({ compressed: 1, decodedLength: 0 })), { code: 'tex-invalid-decoded-length' });
  const truncated = texture().subarray(0, 89);
  assert.throws(() => parseTexture(truncated), { code: 'tex-payload-bounds' });
});

test('bounded LZ4 handles literals, extended runs and overlapping match histories', () => {
  assert.deepEqual(decodeLz4Block(Buffer.from([0x30, 65, 66, 67]), 3), Buffer.from('ABC'));
  assert.deepEqual(decodeLz4Block(Buffer.from([0x14, 65, 1, 0]), 9), Buffer.from('AAAAAAAAA'));
  assert.deepEqual(decodeLz4Block(Buffer.from([0x46, 65, 66, 67, 68, 4, 0]), 14), Buffer.from('ABCDABCDABCDAB'));
  assert.deepEqual(decodeLz4Block(Buffer.concat([Buffer.from([0xf0, 5]), Buffer.alloc(20, 7)]), 20), Buffer.alloc(20, 7));
  assert.deepEqual(decodeLz4Block(Buffer.alloc(0), 0), Buffer.alloc(0));
});

test('bounded LZ4 rejects impossible history, incomplete lengths and output overflow', () => {
  assert.throws(() => decodeLz4Block(Buffer.from([0, 0, 0]), 4), { code: 'lz4-invalid-offset' });
  assert.throws(() => decodeLz4Block(Buffer.from([0xf0]), 1), { code: 'lz4-truncated-length' });
  assert.throws(() => decodeLz4Block(Buffer.from([0x14, 65, 1, 0]), 8), { code: 'lz4-match-bounds' });
  assert.throws(() => decodeLz4Block(Buffer.from([0x30, 65, 66]), 3), { code: 'lz4-literal-bounds' });
  assert.throws(() => decodeLz4Block(Buffer.from([0x10, 65]), 2), { code: 'lz4-length-mismatch' });
  assert.throws(() => decodeLz4Block(Buffer.alloc(0), MAX_DECODED_BYTES + 1), { code: 'lz4-size-limit' });
});
