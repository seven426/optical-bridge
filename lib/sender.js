const Sender = (() => {
  let state = null;

  async function prepareFile(file, opts = {}) {
    const fecK = opts.fecK || 5;
    const fecN = opts.fecN || 1;
    const ecLevel = opts.ecLevel || 'L';
    const qrVersion = opts.qrVersion || pickQRVersion();

    // Read file
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // SHA-256 (with pure JS fallback for file:// protocol)
    const sha256 = await SHA256.hash(bytes);
    const sha256hex = [...sha256].map(b => b.toString(16).padStart(2, '0')).join('');

    // Capacity per frame
    const payloadCapacity = getQRPayloadCapacity(qrVersion, ecLevel);
    const headerSize = FrameProtocol.getHeaderSize(); // 20
    const maxPayloadPerFrame = payloadCapacity - headerSize;

    // Compute total frames (file content only, no metadata frame)
    const totalDataFrames = Math.ceil(file.size / maxPayloadPerFrame);
    const totalFECBlocks = Math.ceil(totalDataFrames / fecK);
    // Each block has exactly K+N frames (last block padded to K data frames)
    const totalFrames = totalFECBlocks * (fecK + fecN);

    state = {
      fileBytes: bytes,
      fileSize: file.size,
      sha256,
      sha256hex,
      qrVersion,
      ecLevel,
      maxPayloadPerFrame,
      headerSize,
      fecK,
      fecN,
      totalDataFrames,
      totalFECBlocks,
      totalFrames,
      intervalMs: opts.frameInterval || 200,
      frames: null,
      mode: 'all',
      selectSet: null
    };

    return {
      fileSize: file.size,
      sha256hex,
      totalDataFrames,
      totalFrames,
      fecK, fecN,
      estimatedSeconds: Math.ceil(totalFrames * (opts.frameInterval || 200) / 1000),
      qrVersion,
      ecLevel
    };
  }

  function getQRPayloadCapacity(version, ecLevel) {
    const caps = {
      5:  { L: 76,  M: 60,  Q: 43,  H: 33 },
      6:  { L: 106, M: 83,  Q: 59,  H: 45 },
      7:  { L: 136, M: 107, Q: 76,  H: 58 },
      8:  { L: 170, M: 134, Q: 95,  H: 72 },
      10: { L: 271, M: 213, Q: 151, H: 114 },
      12: { L: 398, M: 312, Q: 222, H: 169 },
      15: { L: 638, M: 499, Q: 356, H: 272 },
      16: { L: 764, M: 604, Q: 442, H: 344 },
      18: { L: 1076,M: 846, Q: 596, H: 468 },
      20: { L: 1468,M: 1158,Q: 816, H: 642 },
      23: { L: 1941,M: 1529,Q: 1079,H: 849 },
      25: { L: 2378,M: 1879,Q: 1333,H: 1051 },
      28: { L: 2953,M: 2309,Q: 1650,H: 1308 },
      30: { L: 3392,M: 2658,Q: 1899,H: 1507 },
    };
    var v = caps[version] || caps[20];
    return v[ecLevel] || v['L'];
  }

  function pickQRVersion(mode) {
    if (mode === 'screen') return 20;
    const h = typeof window !== 'undefined' ? window.innerHeight : 1080;
    if (h >= 900) return 10;
    if (h >= 720) return 8;
    return 5;
  }

  function generateFrames() {
    if (!state) throw new Error('No file prepared');
    if (state.frames) return state.frames;

    const { fileBytes, fecK, fecN, maxPayloadPerFrame } = state;

    // Build data payloads grouped by FEC block
    const groups = {};
    let groupIdx = 0;
    let slotInGroup = 0;

    // File content frames (all padded to maxPayloadPerFrame for uniform length)
    let byteOffset = 0;
    while (byteOffset < fileBytes.length) {
      const chunkSize = Math.min(maxPayloadPerFrame, fileBytes.length - byteOffset);
      const payload = fileBytes.slice(byteOffset, byteOffset + chunkSize);
      byteOffset += chunkSize;

      // Pad to maxPayloadPerFrame so all frames have same length
      var uniformPayload = payload;
      if (payload.length < maxPayloadPerFrame) {
        uniformPayload = new Uint8Array(maxPayloadPerFrame);
        uniformPayload.set(payload);
      }

      if (slotInGroup >= fecK) {
        groupIdx++;
        slotInGroup = 0;
      }

      if (!groups[groupIdx]) groups[groupIdx] = [];
      groups[groupIdx].push(uniformPayload);
      slotInGroup++;
    }

    // Pad last group to K frames
    const gids = Object.keys(groups).map(Number).sort((a, b) => a - b);
    for (const gid of gids) {
      const groupData = groups[gid];
      while (groupData.length < fecK) {
        groupData.push(new Uint8Array(maxPayloadPerFrame));
      }
    }

    // FEC encode each group and build frames
    const allFrames = [];
    let frameIdx = 0;

    for (const gid of gids) {
      const groupData = groups[gid];
      const groupSize = fecK + fecN;
      const encoded = ReedSolomon.encode(groupData, fecK, fecN);

      for (let i = 0; i < encoded.length; i++) {
        const frame = FrameProtocol.packFrame({
          fileId: 0,
          frameIdx: frameIdx++,
          totalFrames: state.totalDataFrames,
          fecGroup: gid,
          fecGroupSize: groupSize,
          fecK: fecK,
          fileSize: state.fileSize,
          payload: encoded[i]
        });
        allFrames.push(frame);
      }
    }

    state.frames = allFrames;
    return allFrames;
  }

  function getCycleFrames() {
    if (!state || !state.frames) throw new Error('No frames generated');

    if (state.mode === 'select' && state.selectSet && state.selectSet.size > 0) {
      const selected = [];
      for (let i = 0; i < state.frames.length; i++) {
        const unpacked = FrameProtocol.unpackFrame(state.frames[i]);
        if (unpacked && state.selectSet.has(unpacked.frameIdx)) {
          selected.push(state.frames[i]);
        }
      }
      return selected;
    }

    return state.frames;
  }

  function setSelectMode(frameSet) {
    state.mode = 'select';
    state.selectSet = frameSet;
  }

  function setAllMode() {
    state.mode = 'all';
    state.selectSet = null;
  }

  function getState() { return state; }

  return { prepareFile, generateFrames, getCycleFrames, setSelectMode, setAllMode, getState,
           pickQRVersion, getQRPayloadCapacity };
})();
