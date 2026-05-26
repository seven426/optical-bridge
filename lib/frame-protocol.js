var POPCOUNT_TABLE = new Uint8Array(256);
for (var pci = 0; pci < 256; pci++) {
  POPCOUNT_TABLE[pci] = (pci & 1) + POPCOUNT_TABLE[pci >> 1];
}

const FrameProtocol = (() => {
  const MAGIC = 0x4F42; // "OB" in ASCII
  const HEADER_SIZE = 20;
  // Layout: magic:2 fileId:2 frameIdx:2 totalFrames:2 fecGroup:2 fecGroupSize:2 payloadLen:2 fecK:2 fileSize:4

  /**
   * Pack frame header + payload into a Uint8Array.
   */
  function packFrame({ fileId, frameIdx, totalFrames, fecGroup, fecGroupSize, fecK, fileSize, payload }) {
    const payloadLen = payload.length;
    const buf = new Uint8Array(HEADER_SIZE + payloadLen);
    const dv = new DataView(buf.buffer);

    dv.setUint16(0, MAGIC, false);       // big-endian magic
    dv.setUint16(2, fileId, false);
    dv.setUint16(4, frameIdx, false);
    dv.setUint16(6, totalFrames, false);
    dv.setUint16(8, fecGroup, false);
    dv.setUint16(10, fecGroupSize, false);
    dv.setUint16(12, payloadLen, false);
    dv.setUint16(14, fecK, false);
    dv.setUint32(16, fileSize, true);     // LE

    buf.set(payload, HEADER_SIZE);
    return buf;
  }

  /**
   * Unpack a received frame. Returns null if magic doesn't match.
   */
  function unpackFrame(bytes) {
    if (bytes.length < HEADER_SIZE) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = dv.getUint16(0, false);
    if (magic !== MAGIC) return null;

    const fileId = dv.getUint16(2, false);
    const frameIdx = dv.getUint16(4, false);
    const totalFrames = dv.getUint16(6, false);
    const fecGroup = dv.getUint16(8, false);
    const fecGroupSize = dv.getUint16(10, false);
    const payloadLen = dv.getUint16(12, false);
    const fecK = dv.getUint16(14, false);
    const fileSize = dv.getUint32(16, true);  // LE

    if (HEADER_SIZE + payloadLen > bytes.length) return null;

    const payload = bytes.slice(HEADER_SIZE, HEADER_SIZE + payloadLen);
    return { fileId, frameIdx, totalFrames, fecGroup, fecGroupSize, payloadLen, fecK, fileSize, payload };
  }

  /**
   * Build metadata payload for frame #0.
   * Layout: [filename_len:2B BE] [filename_utf8] [fileSize:4B LE] [sha256:32B] [totalDataFrames:2B BE] [fecK:1B] [fecN:1B]
   */
  function buildMetadataPayload({ filename, fileSize, sha256, totalDataFrames, fecK, fecN }) {
    const enc = new TextEncoder();
    const nameBytes = enc.encode(filename);
    // 2B nameLen + nameBytes + 4B fileSize + 32B sha256 + 2B totalDataFrames + 1B fecK + 1B fecN
    const buf = new Uint8Array(2 + nameBytes.length + 4 + 32 + 2 + 1 + 1);
    const dv = new DataView(buf.buffer);

    dv.setUint16(0, nameBytes.length, false); // BE
    buf.set(nameBytes, 2);
    let offset = 2 + nameBytes.length;
    dv.setUint32(offset, fileSize, true);      // LE
    offset += 4;
    buf.set(sha256, offset);                     // 32 raw bytes
    offset += 32;
    dv.setUint16(offset, totalDataFrames, false); // BE
    offset += 2;
    buf[offset++] = fecK;
    buf[offset++] = fecN;

    return buf;
  }

  /**
   * Parse metadata payload from frame #0. Returns null if payload is too short.
   */
  function parseMetadataPayload(payload) {
    // Minimum: 2B nameLen + 1B name + 4B fileSize + 32B sha256 + 2B total + 1B fecK + 1B fecN
    if (payload.length < 2 + 1 + 4 + 32 + 2 + 1 + 1) return null;

    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const nameLen = dv.getUint16(0, false); // BE

    const fixedSize = 2 + 4 + 32 + 2 + 1 + 1;
    if (nameLen < 1 || payload.length < fixedSize + nameLen) return null;

    const dec = new TextDecoder();
    const filename = dec.decode(payload.slice(2, 2 + nameLen));

    let offset = 2 + nameLen;
    const fileSize = dv.getUint32(offset, true); // LE
    offset += 4;
    const sha256 = payload.slice(offset, offset + 32);
    offset += 32;
    const totalDataFrames = dv.getUint16(offset, false);
    offset += 2;
    const fecK = payload[offset++];
    const fecN = payload[offset++];

    return { filename, fileSize, sha256, totalDataFrames, fecK, fecN };
  }

  function getHeaderSize() { return HEADER_SIZE; }

  // --- Inner FEC: block-level RS error correction ---
  // Block size is always 242: fits within GF(256) α-period of 255.
  // innerK and innerT vary by mode (ColorGrid: 236/3, C4Grid: 212/15).
  var DEFAULT_INNER_K = 236;
  var DEFAULT_INNER_T = 3;
  var BLOCK_SIZE = 242;

  function innerBlockCount(capacity) {
    return Math.floor(capacity / BLOCK_SIZE);
  }

  function innerDataCapacity(capacity, innerK) {
    innerK = innerK || DEFAULT_INNER_K;
    return innerBlockCount(capacity) * innerK;
  }

  function innerEncodedSize(capacity) {
    return innerBlockCount(capacity) * BLOCK_SIZE;
  }

  function encodeInnerFEC(frameData, totalCapacity, innerK) {
    innerK = innerK || DEFAULT_INNER_K;
    var npar = BLOCK_SIZE - innerK;
    var numBlocks = innerBlockCount(totalCapacity);
    var dataSize = numBlocks * innerK;
    if (frameData.length > dataSize) return null;

    var padded = new Uint8Array(dataSize);
    padded.set(frameData);

    var result = new Uint8Array(numBlocks * BLOCK_SIZE);
    for (var b = 0; b < numBlocks; b++) {
      var block = padded.slice(b * innerK, (b + 1) * innerK);
      var encoded = ReedSolomon.encodeBlock(block, npar);
      result.set(encoded, b * BLOCK_SIZE);
    }
    return result;
  }

  function decodeInnerFEC(encodedData, totalCapacity, innerK) {
    innerK = innerK || DEFAULT_INNER_K;
    var npar = BLOCK_SIZE - innerK;
    var innerT = npar >> 1;
    var numBlocks = innerBlockCount(totalCapacity);
    if (encodedData.length < numBlocks * BLOCK_SIZE) return null;

    var dataSize = numBlocks * innerK;
    var result = new Uint8Array(dataSize);
    var totalErrors = 0;
    var totalBitErrors = 0;

    for (var b = 0; b < numBlocks; b++) {
      var start = b * BLOCK_SIZE;
      var block = encodedData.slice(start, start + BLOCK_SIZE);
      var corrected = ReedSolomon.correctErrors(block, innerT);
      if (!corrected) return null;

      totalErrors += corrected.errors;
      var corrData = corrected.corrected;
      result.set(corrData.slice(npar, BLOCK_SIZE), b * innerK);

      for (var bi = 0; bi < innerK; bi++) {
        totalBitErrors += POPCOUNT_TABLE[block[npar + bi] ^ corrData[npar + bi]];
      }
    }

    return { data: result, errors: totalErrors, bitErrors: totalBitErrors };
  }

  return { packFrame, unpackFrame, buildMetadataPayload, parseMetadataPayload, getHeaderSize,
           encodeInnerFEC, decodeInnerFEC, innerBlockCount, innerDataCapacity, innerEncodedSize };
})();
