const Sender = (() => {
  let state = null;

  async function prepareFile(file, opts = {}) {
    const fecK = opts.fecK || 5;
    const fecN = opts.fecN || 1;
    const ecLevel = opts.ecLevel || 'M';
    const qrVersion = opts.qrVersion || pickQRVersion();

    // Read file
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // SHA-256 (with pure JS fallback for file:// protocol)
    const sha256 = await SHA256.hash(bytes);
    const sha256hex = [...sha256].map(b => b.toString(16).padStart(2, '0')).join('');

    // Capacity per frame
    const payloadCapacity = getQRPayloadCapacity(qrVersion, ecLevel);
    const headerSize = FrameProtocol.getHeaderSize(); // 14
    const maxPayloadPerFrame = payloadCapacity - headerSize;

    // Compute total frames (1 metadata frame + ceil(fileSize / maxPayloadPerFrame) data frames)
    const totalDataFrames = 1 + Math.ceil(file.size / maxPayloadPerFrame);
    const totalFECBlocks = Math.ceil(totalDataFrames / fecK);
    const totalFrames = totalDataFrames + totalFECBlocks * fecN;

    const metaPayload = FrameProtocol.buildMetadataPayload({
      filename: file.name,
      fileSize: file.size,
      sha256: sha256,
      totalDataFrames: totalDataFrames,
      fecK, fecN
    });

    state = {
      fileBytes: bytes,
      filename: file.name,
      fileSize: file.size,
      sha256,
      sha256hex,
      metaPayload,
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
      filename: file.name,
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
      10: { L: 271, M: 213, Q: 151, H: 114 },
      15: { L: 638, M: 499, Q: 356, H: 272 },
      20: { L: 1183, M: 930, Q: 666, H: 507 },
      25: { L: 1852, M: 1451, Q: 1043, H: 795 },
      30: { L: 2180, M: 1700, Q: 1200, H: 930 },
    };
    const v = caps[version] || caps[20];
    return v[ecLevel] || v['M'];
  }

  function pickQRVersion() {
    const h = typeof window !== 'undefined' ? window.innerHeight : 1080;
    if (h >= 900) return 20;
    if (h >= 720) return 15;
    return 10;
  }

  function generateFrames() {
    if (!state) throw new Error('No file prepared');
    if (state.frames) return state.frames;

    const { fileBytes, metaPayload, fecK, fecN, maxPayloadPerFrame } = state;

    // Build data payloads grouped by FEC block
    const groups = {};
    let groupIdx = 0;
    let slotInGroup = 0;

    // Frame #0: metadata
    if (!groups[0]) groups[0] = [];
    groups[0].push(metaPayload);
    slotInGroup = 1;

    // File content frames
    let byteOffset = 0;
    while (byteOffset < fileBytes.length) {
      const chunkSize = Math.min(maxPayloadPerFrame, fileBytes.length - byteOffset);
      const payload = fileBytes.slice(byteOffset, byteOffset + chunkSize);
      byteOffset += chunkSize;

      if (slotInGroup >= fecK) {
        groupIdx++;
        slotInGroup = 0;
      }

      if (!groups[groupIdx]) groups[groupIdx] = [];
      groups[groupIdx].push(payload);
      slotInGroup++;
    }

    // Pad last group to K frames (zero-filled)
    const lastGid = groupIdx;
    if (groups[lastGid] && groups[lastGid].length < fecK) {
      const padLen = groups[lastGid][0].length;
      while (groups[lastGid].length < fecK) {
        groups[lastGid].push(new Uint8Array(padLen));
      }
    }

    // FEC encode each group and build frames
    const allFrames = [];
    let frameIdx = 0;

    const gids = Object.keys(groups).map(Number).sort((a, b) => a - b);
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

    // All mode: 3 copies of frame #0 as preamble, then all frames
    return [state.frames[0], state.frames[0], state.frames[0], ...state.frames];
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
