'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { decodeTexture, decodeRawPixels, encodePngRGBA, imageDimensions, crc32 } = require('../textureDecode.cjs');

// Format vectors test observable pixels, row strides and container interoperability, without external codecs.
function int(value) { const result = Buffer.alloc(4); result.writeInt32LE(value); return result; }
function tex({ format = 0, imageFormat = -1, textureWidth = 4, textureHeight = 4, imageWidth = textureWidth, imageHeight = textureHeight, images }) {
  return Buffer.concat([
    Buffer.from('TEXV0005\0TEXI0001\0'),
    ...[format, 0, textureWidth, textureHeight, imageWidth, imageHeight, 0].map(int),
    Buffer.from('TEXB0003\0'), int(images.length), int(imageFormat),
    ...images.flatMap(mips => [int(mips.length), ...mips.flatMap(mip => [int(mip.width), int(mip.height), int(mip.lz4 ? 1 : 0), int(mip.uncompressedLength || 0), int(mip.bytes.length), mip.bytes])]),
  ]);
}
function mip(bytes, width = 4, height = 4) { return { width, height, bytes }; }
function colors(first, second, indices = 0) {
  const block = Buffer.alloc(8);
  block.writeUInt16LE(first, 0); block.writeUInt16LE(second, 2); block.writeUInt32LE(indices >>> 0, 4);
  return block;
}
function alphaIndices(indices) {
  const output = Buffer.alloc(6);
  for (let pixel = 0; pixel < 16; pixel++) {
    const index = indices[pixel] || 0, bit = pixel * 3, byte = bit >>> 3, shift = bit & 7;
    output[byte] |= (index << shift) & 255;
    if (shift > 5) output[byte + 1] |= index >>> (8 - shift);
  }
  return output;
}
function pngPixels(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let width, height;
  const data = [];
  for (let position = 8; position < bytes.length;) {
    const length = bytes.readUInt32BE(position), type = bytes.toString('ascii', position + 4, position + 8);
    const body = bytes.subarray(position + 8, position + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); assert.equal(body[9], 6); }
    if (type === 'IDAT') data.push(body);
    position += 12 + length;
  }
  const scanlines = zlib.inflateSync(Buffer.concat(data));
  assert.equal(scanlines.length, (width * 4 + 1) * height);
  const rgba = [];
  for (let y = 0; y < height; y++) {
    assert.equal(scanlines[y * (width * 4 + 1)], 0);
    rgba.push(...scanlines.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)));
  }
  return { width, height, rgba };
}

test('BC1 565 colors, interpolation and transparent mode decode to specified RGBA pixels', () => {
  const pixels = decodeRawPixels(7, colors(0xf800, 0x001f, 0xe4), 4, 4);
  assert.deepEqual([...pixels.subarray(0, 16)], [255, 0, 0, 255, 0, 0, 255, 255, 170, 0, 85, 255, 85, 0, 170, 255]);
  const alphaMode = decodeRawPixels(7, colors(0, 0xffff, 0xe4), 4, 4);
  assert.deepEqual([...alphaMode.subarray(8, 16)], [127, 127, 127, 255, 0, 0, 0, 0]);
});

test('BC2 uses all 16 explicit alpha nibbles and always uses four RGB colors', () => {
  const alpha = Buffer.from([0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe]);
  const pixels = decodeRawPixels(6, Buffer.concat([alpha, colors(0, 0xffff, 0xffffffff)]), 4, 4);
  assert.deepEqual(Array.from({ length: 16 }, (_, i) => pixels[i * 4 + 3]), Array.from({ length: 16 }, (_, i) => i * 17));
  assert.deepEqual([...pixels.subarray(0, 3)], [170, 170, 170]);
});

test('BC3 decodes both alpha interpolation modes and 3-bit indices crossing byte boundaries', () => {
  const indices = Array.from({ length: 16 }, (_, i) => i % 8);
  const high = Buffer.concat([Buffer.from([255, 0]), alphaIndices(indices), colors(0xf800, 0, 0)]);
  const pixels = decodeRawPixels(4, high, 4, 4);
  assert.deepEqual(Array.from({ length: 16 }, (_, i) => pixels[i * 4 + 3]), [255, 0, 218, 182, 145, 109, 72, 36, 255, 0, 218, 182, 145, 109, 72, 36]);
  const low = Buffer.concat([Buffer.from([0, 255]), alphaIndices(indices), colors(0, 0xffff, 0xffffffff)]);
  const lowPixels = decodeRawPixels(4, low, 4, 4);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => lowPixels[i * 4 + 3]), [0, 255, 51, 102, 153, 204, 0, 255]);
  assert.deepEqual([...lowPixels.subarray(0, 3)], [170, 170, 170]);
});

test('BC rows retain source block pitch when cropping across horizontal and vertical block edges', () => {
  const blocks = Buffer.concat([colors(0xf800, 0), colors(0x07e0, 0), colors(0x001f, 0), colors(0xffff, 0)]);
  const pixels = decodeRawPixels(7, blocks, 8, 8, 5, 5);
  assert.equal(pixels.length, 5 * 5 * 4);
  assert.deepEqual([...pixels.subarray(4 * 4, 5 * 4)], [0, 255, 0, 255]);
  assert.deepEqual([...pixels.subarray(4 * 5 * 4, 4 * 5 * 4 + 4)], [0, 0, 255, 255]);
  assert.deepEqual([...pixels.subarray(-4)], [255, 255, 255, 255]);
});

test('RGBA crop uses padded row stride and preserves source row orientation', async () => {
  const rows = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255, 13, 13, 13, 255, 17, 17, 17, 255,
    0, 0, 255, 255, 255, 255, 255, 255, 31, 31, 31, 255, 37, 37, 37, 255,
  ]);
  const result = await decodeTexture(tex({ textureWidth: 4, textureHeight: 2, imageWidth: 2, imageHeight: 2, images: [[mip(rows, 4, 2)]] }));
  assert.equal(result.extension, '.png');
  assert.equal(result.format, 'RGBA8888');
  assert.equal(result.details.cropped, true);
  assert.deepEqual(pngPixels(result.bytes), { width: 2, height: 2, rgba: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255] });
});

test('R8 is opaque grayscale; RG88 uses verified grayscale G and alpha R', () => {
  assert.deepEqual([...decodeRawPixels(9, Buffer.from([10, 200]), 2, 1)], [10, 10, 10, 255, 200, 200, 200, 255]);
  assert.deepEqual([...decodeRawPixels(8, Buffer.from([0, 80, 240, 120]), 2, 1)], [80, 80, 80, 0, 120, 120, 120, 240]);
});

test('embedded PNG passes through byte-for-byte and uses its own IHDR dimensions, including LZ4 literal payload', async () => {
  const png = await encodePngRGBA(Buffer.from([255, 0, 0, 255, 0, 0, 255, 128]), 2, 1);
  const image = mip(png, 4, 4);
  const result = await decodeTexture(tex({ imageFormat: 13, images: [[image]] }));
  assert.deepEqual(result.bytes, png);
  assert.deepEqual([result.width, result.height, result.format, result.details.direct], [2, 1, 'PNG', true]);
  const extensions = [];
  let remaining = png.length - 15;
  while (remaining >= 255) { extensions.push(255); remaining -= 255; }
  extensions.push(remaining);
  image.bytes = Buffer.concat([Buffer.from([0xf0, ...extensions]), png]);
  image.lz4 = true; image.uncompressedLength = png.length;
  assert.deepEqual((await decodeTexture(tex({ imageFormat: 13, images: [[image]] }))).bytes, png);
});

test('JPEG SOF parser skips Huffman C4 and respects progressive frame dimensions', () => {
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xc4, 0, 2, 0xff, 0xc2, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda]);
  assert.deepEqual(imageDimensions(jpegHeader, 2), { width: 3, height: 2 });
  assert.throws(() => imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda]), 2), error => error.code === 'texture-invalid-jpeg');
});

test('first usable image chooses the largest mip and reports falling back from a damaged larger mip', async () => {
  const small = mip(Buffer.alloc(2 * 2 * 4, 255), 2, 2), large = mip(Buffer.alloc(4 * 4 * 4, 255));
  const result = await decodeTexture(tex({ images: [[small, large]] }));
  assert.equal(result.width, 4);
  assert.equal(result.details.mipIndex, 1);
  large.bytes = Buffer.alloc(4);
  const fallback = await decodeTexture(tex({ images: [[large, small]] }));
  assert.equal(fallback.width, 2);
  assert.equal(fallback.details.priorFailures[0].code, 'texture-raw-length');
});

test('PNG CRC matches IEEE vector and encoded pixel stream round-trips', async () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const pixels = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(pngPixels(await encodePngRGBA(pixels, 1, 2)), { width: 1, height: 2, rgba: [...pixels] });
});

test('unknown raw/DDS formats, truncated payloads and oversized dimensions fail explicitly before allocation', async () => {
  assert.throws(() => decodeRawPixels(0, Buffer.alloc(1), 2, 2), error => error.code === 'texture-raw-length');
  assert.throws(() => decodeRawPixels(0, Buffer.alloc(0), 32768, 32768), error => error.code === 'texture-pixel-limit');
  await assert.rejects(decodeTexture(tex({ format: 98, images: [[mip(Buffer.alloc(16))]] })), error => error.code === 'texture-format-unsupported');
  await assert.rejects(decodeTexture(tex({ imageFormat: 24, images: [[mip(Buffer.alloc(16))]] })), error => error.code === 'texture-encoded-format-unsupported');
  await assert.rejects(decodeTexture(tex({ imageFormat: 13, images: [[mip(Buffer.from('not png'))]] })), error => error.code === 'texture-invalid-png');
});
