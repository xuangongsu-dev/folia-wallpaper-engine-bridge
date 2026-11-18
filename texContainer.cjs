'use strict';

// Original bounded TEX metadata/LZ4 parser. No texture rendering or external tools.
// Field order was verified against copied local files and these format readers:
// https://github.com/notscuffed/repkg/blob/master/RePKG.Application/Texture/TexHeaderReader.cs
// https://github.com/notscuffed/repkg/blob/master/RePKG.Application/Texture/TexImageContainerReader.cs
// https://github.com/notscuffed/repkg/blob/master/RePKG.Application/Texture/TexImageReader.cs
// LZ4 block grammar: https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
const MAX_CONTAINER_BYTES = 128 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_DIMENSION = 32768;
const MAX_PIXELS = 64 * 1024 * 1024;
const FORMAT_NAMES = Object.freeze({ 0: 'RGBA8888', 4: 'DXT5/BC3', 6: 'DXT3/BC2', 7: 'DXT1/BC1', 8: 'RG88', 9: 'R8' });
const IMAGE_FORMAT_NAMES = Object.freeze({ '-1': 'raw', 0: 'BMP', 2: 'JPEG', 13: 'PNG', 24: 'DDS', 25: 'GIF', 35: 'MP4' });

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function asBuffer(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw problem('tex-invalid-buffer', 'Texture input must be bytes.');
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
function checkDimensions(width, height, context) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw problem('tex-dimension-limit', `${context} dimensions exceed the supported limit: ${width}x${height}.`);
}

// metadataOnly + totalLength allows a small entry prefix, ending after the first mip header.
// The normal path validates every mip against the complete container without copying payloads.
function parseTexture(input, options = {}) {
  const bytes = asBuffer(input);
  if (bytes.length > MAX_CONTAINER_BYTES) throw problem('tex-container-limit', `TEX input exceeds ${MAX_CONTAINER_BYTES} bytes.`);
  const metadataOnly = options.metadataOnly === true;
  const totalLength = options.totalLength === undefined ? bytes.length : options.totalLength;
  if (!Number.isSafeInteger(totalLength) || totalLength < bytes.length || totalLength > 0xffffffff) throw problem('tex-invalid-length', 'Invalid declared TEX container length.');
  if (!metadataOnly && totalLength !== bytes.length) throw problem('tex-truncated-container', 'A complete TEX buffer is required for payload parsing.');
  let position = 0;
  const int32 = () => {
    if (position + 4 > bytes.length) throw problem('tex-truncated-header', 'TEX metadata ends before the next field.');
    const value = bytes.readInt32LE(position); position += 4; return value;
  };
  const string = maximum => {
    const end = bytes.indexOf(0, position);
    if (end < position || end - position > maximum) throw problem('tex-invalid-string', 'Invalid TEX NUL-terminated string.');
    const value = bytes.toString('utf8', position, end); position = end + 1; return value;
  };
  const magic = string(16);
  const imageMagic = string(16);
  if (magic !== 'TEXV0005' || imageMagic !== 'TEXI0001') throw problem('tex-unknown-magic', `Unsupported TEX signature: ${magic}/${imageMagic}`);
  const header = { format: int32(), flags: int32(), textureWidth: int32(), textureHeight: int32(), imageWidth: int32(), imageHeight: int32(), unknown: int32() >>> 0 };
  checkDimensions(header.textureWidth, header.textureHeight, 'Texture');
  checkDimensions(header.imageWidth, header.imageHeight, 'Image');
  header.formatName = FORMAT_NAMES[header.format] || `unknown-${header.format}`;
  const container = string(16);
  if (!/^TEXB000[1-4]$/.test(container)) throw problem('tex-unknown-container', `Unsupported TEX image container: ${container}`);
  const version = Number(container.slice(4));
  const imageCount = int32();
  if (imageCount < 1 || imageCount > 4096) throw problem('tex-image-limit', `Unsupported TEX image count: ${imageCount}.`);
  const declaredImageFormat = version >= 3 ? int32() : -1;
  const videoFlag = version >= 4 ? int32() : 0;
  if (videoFlag !== 0 && videoFlag !== 1) throw problem('tex-unknown-video-flag', `Unsupported TEX video flag: ${videoFlag}.`);
  const imageFormat = declaredImageFormat === -1 && videoFlag === 1 ? 35 : declaredImageFormat;
  const isMp4 = imageFormat === 35;
  const images = [];
  const result = () => ({
    magic, imageMagic, header, container, version, imageCount, declaredImageFormat, imageFormat,
    imageFormatName: IMAGE_FORMAT_NAMES[imageFormat] || `unknown-${imageFormat}`,
    isMp4, videoFlag, images, metadataOnly, partial: position > bytes.length,
    trailingBytes: position <= bytes.length ? totalLength - position : null,
    nextOffset: position,
    knownFormat: imageFormat !== -1 ? Object.hasOwn(IMAGE_FORMAT_NAMES, imageFormat) : Object.hasOwn(FORMAT_NAMES, header.format),
  });
  let totalMips = 0;
  for (let image = 0; image < imageCount; image++) {
    const mipCount = int32();
    if (mipCount < 1 || mipCount > 32 || totalMips + mipCount > 65536) throw problem('tex-mip-limit', `Unsupported TEX mip count: ${mipCount}.`);
    totalMips += mipCount;
    const mips = [];
    images.push({ mipCount, mips });
    for (let mip = 0; mip < mipCount; mip++) {
      let condition = null;
      if (version === 4 && isMp4) {
        const a = int32(), b = int32();
        condition = string(64 * 1024);
        const c = int32();
        if (a !== 1 || b !== 2 || c !== 1) throw problem('tex-unknown-mp4-layout', `Unsupported TEX MP4 layout: ${a}/${b}/${c}.`);
      }
      const width = int32(), height = int32();
      checkDimensions(width, height, 'Mipmap');
      const compression = version >= 2 ? int32() : 0;
      if (compression !== 0 && compression !== 1) throw problem('tex-unknown-compression', `Unsupported TEX compression flag: ${compression}.`);
      const uncompressedLength = version >= 2 ? int32() : 0;
      if (uncompressedLength < 0 || (compression === 1 && uncompressedLength === 0)) throw problem('tex-invalid-decoded-length', 'Invalid TEX LZ4 decoded byte count.');
      const length = int32();
      const start = position;
      if (length < 0 || start + length > totalLength) throw problem('tex-payload-bounds', 'TEX mip payload exceeds the copied container.');
      mips.push({ width, height, lz4: compression === 1, uncompressedLength, length, start, offset: start, condition, decodeWithinLimit: uncompressedLength <= MAX_DECODED_BYTES });
      position += length;
      if (position > bytes.length) {
        if (metadataOnly) return result();
        throw problem('tex-truncated-payload', 'TEX mip payload is truncated.');
      }
      if (metadataOnly && position === bytes.length && (mip + 1 < mipCount || image + 1 < imageCount)) return { ...result(), partial: true, trailingBytes: null };
    }
  }
  return result();
}

function decodeLz4Block(input, expectedLength, maxBytes = MAX_DECODED_BYTES) {
  const bytes = asBuffer(input);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_DECODED_BYTES || !Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > maxBytes || bytes.length > MAX_CONTAINER_BYTES) throw problem('lz4-size-limit', 'LZ4 input or decoded size exceeds the allowed limit.');
  const output = Buffer.allocUnsafe(expectedLength);
  let source = 0, target = 0;
  const extended = initial => {
    let length = initial;
    if (initial === 15) {
      let addition;
      do {
        if (source >= bytes.length) throw problem('lz4-truncated-length', 'LZ4 block ends inside a length extension.');
        addition = bytes[source++]; length += addition;
        if (length > maxBytes) throw problem('lz4-size-limit', 'LZ4 length exceeds the allowed output.');
      } while (addition === 255);
    }
    return length;
  };
  while (source < bytes.length) {
    const token = bytes[source++];
    const literalLength = extended(token >>> 4);
    if (source + literalLength > bytes.length || target + literalLength > expectedLength) throw problem('lz4-literal-bounds', 'LZ4 literal run exceeds its input or output.');
    bytes.copy(output, target, source, source + literalLength);
    source += literalLength; target += literalLength;
    if (source === bytes.length) break;
    if (source + 2 > bytes.length) throw problem('lz4-truncated-offset', 'LZ4 block ends inside a match offset.');
    const distance = bytes.readUInt16LE(source); source += 2;
    if (distance === 0 || distance > target) throw problem('lz4-invalid-offset', 'LZ4 match points outside decoded history.');
    const matchLength = extended(token & 15) + 4;
    if (target + matchLength > expectedLength) throw problem('lz4-match-bounds', 'LZ4 match run exceeds its declared output.');
    // Grow the available history exponentially; this also handles offset=1 without byte-at-a-time loops.
    let copied = 0;
    while (copied < matchLength) {
      const count = Math.min(distance + copied, matchLength - copied);
      output.copy(output, target + copied, target - distance, target - distance + count);
      copied += count;
    }
    target += matchLength;
  }
  if (target !== expectedLength) throw problem('lz4-length-mismatch', `LZ4 decoded ${target} bytes; expected ${expectedLength}.`);
  return output;
}

module.exports = { parseTexture, decodeLz4Block, FORMAT_NAMES, IMAGE_FORMAT_NAMES, MAX_CONTAINER_BYTES, MAX_DECODED_BYTES, MAX_DIMENSION, MAX_PIXELS };
