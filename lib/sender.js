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
    var payloadCapacity, maxPayloadPerFrame;
    var headerSize = FrameProtocol.getHeaderSize(); // 20
    var mode = opts.mode || 'colorgrid';

    if (mode === 'camera') {
      payloadCapacity = getQRPayloadCapacity(qrVersion, ecLevel);
      maxPayloadPerFrame = payloadCapacity - headerSize;
    } else {
      payloadCapacity = ColorGrid.dataCells();  // 3639
      // Inner FEC: RS(242,236) blocks reduce usable capacity
      maxPayloadPerFrame = FrameProtocol.innerDataCapacity(payloadCapacity) - headerSize;
    }

    // Compute total frames (metadata frame + file content)
    const totalDataFrames = Math.ceil(file.size / maxPayloadPerFrame);
    var totalWithMeta = 1 + totalDataFrames;
    const totalFECBlocks = Math.ceil(totalWithMeta / fecK);
    // Each block has exactly K+N frames (last block padded to K data frames)
    const totalFrames = totalFECBlocks * (fecK + fecN);

    state = {
      fileBytes: bytes,
      fileSize: file.size,
      sha256,
      sha256hex,
      qrVersion,
      ecLevel,
      gridMode: mode,  // render mode: colorgrid/camera
      _filename: file.name,
      cellPx: opts.cellPx || 6,
      maxPayloadPerFrame,
      headerSize,
      fecK,
      fecN,
      totalDataFrames,
      totalFECBlocks,
      totalFrames,
      intervalMs: opts.frameInterval || 150,
      frames: null,
      mode: 'all',
      selectSet: null
    };

    return {
      fileSize: file.size,
      sha256hex,
      totalDataFrames: totalDataFrames,
      totalWithMeta: totalWithMeta,
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
      18: { L: 718, M: 560, Q: 394, H: 310 },
      20: { L: 858, M: 666, Q: 482, H: 382 },
      23: { L: 1091,M: 857, Q: 611, H: 461 },
      25: { L: 1273,M: 997, Q: 715, H: 535 },
      28: { L: 1528,M: 1190,Q: 868, H: 658 },
    };
    var v = caps[version] || caps[20];
    return v[ecLevel] || v['L'];
  }

  function pickQRVersion() {
    const h = typeof window !== 'undefined' ? window.innerHeight : 1080;
    if (h >= 900) return 10;
    if (h >= 720) return 8;
    return 5;
  }

  function generateFrames() {
    if (!state) throw new Error('No file prepared');
    if (state.frames) return state.frames;

    const { fileBytes, fecK, fecN, maxPayloadPerFrame, sha256 } = state;

    // Build metadata payload for frame #0
    var metadataPayload = FrameProtocol.buildMetadataPayload({
      filename: state._filename || 'file',
      fileSize: state.fileSize,
      sha256: sha256,
      totalDataFrames: state.totalDataFrames,
      fecK: fecK,
      fecN: fecN
    });
    var paddedMeta = new Uint8Array(maxPayloadPerFrame);
    paddedMeta.set(metadataPayload);

    // Build data payloads grouped by FEC block
    const groups = {};
    groups[0] = [paddedMeta];  // first slot in first group is metadata
    let groupIdx = 0;
    let slotInGroup = 1;

    // File content frames
    let byteOffset = 0;
    while (byteOffset < fileBytes.length) {
      const chunkSize = Math.min(maxPayloadPerFrame, fileBytes.length - byteOffset);
      const payload = fileBytes.slice(byteOffset, byteOffset + chunkSize);
      byteOffset += chunkSize;

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

    // totalDataFrames includes metadata frame + file data frames
    var totalWithMeta = 1 + state.totalDataFrames;

    var isColorGrid = state.gridMode === 'colorgrid';
    var gridCapacity = isColorGrid ? ColorGrid.dataCells() : 0;

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
          totalFrames: totalWithMeta,
          fecGroup: gid,
          fecGroupSize: groupSize,
          fecK: fecK,
          fileSize: state.fileSize,
          payload: encoded[i]
        });

        if (gridCapacity > 0) {
          var innerEncoded = FrameProtocol.encodeInnerFEC(frame, gridCapacity);
          if (!innerEncoded) throw new Error('Inner FEC encoding failed: frame too large');
          var gridFrame = new Uint8Array(gridCapacity);
          gridFrame.set(innerEncoded);
          allFrames.push(gridFrame);
        } else {
          allFrames.push(frame);
        }
      }
    }

    state.frames = allFrames;
    state._totalWithMeta = totalWithMeta;
    return allFrames;
  }

  function getCycleFrames() {
    if (!state || !state.frames) throw new Error('No frames generated');

    var gridCapacity = state.gridMode === 'colorgrid' ? ColorGrid.dataCells() : 0;

    function unpackGridFrame(rawFrame) {
      if (gridCapacity > 0) {
        var decoded = FrameProtocol.decodeInnerFEC(rawFrame, gridCapacity);
        if (!decoded) return null;
        return FrameProtocol.unpackFrame(decoded.data);
      }
      return FrameProtocol.unpackFrame(rawFrame);
    }

    if (state.mode === 'select' && state.selectSet && state.selectSet.size > 0) {
      const selected = [];
      for (let i = 0; i < state.frames.length; i++) {
        const unpacked = unpackGridFrame(state.frames[i]);
        if (unpacked && state.selectSet.has(unpacked.frameIdx)) {
          selected.push(state.frames[i]);
        }
      }
      return selected;
    }

    if (state.mode === 'blocks' && state.blockSet && state.blockSet.size > 0) {
      const selected = [];
      for (let i = 0; i < state.frames.length; i++) {
        const unpacked = unpackGridFrame(state.frames[i]);
        if (unpacked && state.blockSet.has(unpacked.fecGroup)) {
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

  function setBlockMode(blockSet) {
    state.mode = 'blocks';
    state.blockSet = blockSet;
  }

  function setAllMode() {
    state.mode = 'all';
    state.selectSet = null;
  }

  function getState() { return state; }

  return { prepareFile, generateFrames, getCycleFrames, setSelectMode, setBlockMode, setAllMode, getState,
           pickQRVersion, getQRPayloadCapacity };
})();
