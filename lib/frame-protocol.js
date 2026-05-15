const FrameProtocol = (() => {
  const MAGIC = 0x4F42; // "OB" in ASCII
  const HEADER_SIZE = 14;

  /**
   * Pack frame header + payload into a Uint8Array.
   */
  function packFrame({ fileId, frameIdx, totalFrames, fecGroup, fecGroupSize, payload }) {
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

    if (HEADER_SIZE + payloadLen > bytes.length) return null;

    const payload = bytes.slice(HEADER_SIZE, HEADER_SIZE + payloadLen);
    return { fileId, frameIdx, totalFrames, fecGroup, fecGroupSize, payloadLen, payload };
  }

  /**
   * Build metadata payload for frame #0.
   * Layout: [filename_utf8] [fileSize:4B LE] [sha256:32B] [totalDataFrames:2B] [fecK:1B] [fecN:1B]
   */
  function buildMetadataPayload({ filename, fileSize, sha256, totalDataFrames, fecK, fecN }) {
    const enc = new TextEncoder();
    const nameBytes = enc.encode(filename);
    const buf = new Uint8Array(nameBytes.length + 4 + 32 + 2 + 1 + 1);
    const dv = new DataView(buf.buffer);

    buf.set(nameBytes, 0);
    let offset = nameBytes.length;
    dv.setUint32(offset, fileSize, true);      // LE
    offset += 4;
    buf.set(sha256, offset);                     // 32 raw bytes
    offset += 32;
    dv.setUint16(offset, totalDataFrames, false); // BE for consistency
    offset += 2;
    buf[offset++] = fecK;
    buf[offset++] = fecN;

    return buf;
  }

  /**
   * Parse metadata payload from frame #0. Returns null if payload is too short.
   */
  function parseMetadataPayload(payload) {
    if (payload.length < 4 + 32 + 2 + 1 + 1 + 1) return null;

    const fixedSize = 4 + 32 + 2 + 1 + 1;
    const nameLen = payload.length - fixedSize;
    if (nameLen < 1) return null;

    const dec = new TextDecoder();
    const filename = dec.decode(payload.slice(0, nameLen));

    let offset = nameLen;
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
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

  return { packFrame, unpackFrame, buildMetadataPayload, parseMetadataPayload, getHeaderSize };
})();
