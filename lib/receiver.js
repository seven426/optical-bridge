const Receiver = (() => {
  let state = null;

  function init() {
    state = {
      metadata: null,
      receivedFrames: new Map(),   // "fileId-frameIdx" -> Uint8Array payload
      receivedSet: new Set(),      // for dedup
      fecBlocks: {},              // groupId -> { received: Map<frameIdx, payload>, k, n }
      totalExpected: null,
      complete: false
    };
  }

  function ingestFrame(rawBytes) {
    if (!state) init();

    var unpacked = FrameProtocol.unpackFrame(rawBytes);
    if (!unpacked) return { status: 'bad', reason: 'unpack failed' };

    var fileId = unpacked.fileId;
    var frameIdx = unpacked.frameIdx;
    var totalFrames = unpacked.totalFrames;
    var fecGroup = unpacked.fecGroup;
    var fecGroupSize = unpacked.fecGroupSize;
    var payload = unpacked.payload;

    // Frame #0: extract metadata
    if (frameIdx === 0 && !state.metadata) {
      var meta = FrameProtocol.parseMetadataPayload(payload);
      if (meta) {
        state.metadata = meta;
        state.totalExpected = totalFrames;
        var totalBlocks = Math.ceil(totalFrames / meta.fecK);
        for (var g = 0; g < totalBlocks; g++) {
          state.fecBlocks[g] = {
            received: new Map(),
            size: meta.fecK + meta.fecN,
            k: meta.fecK,
            n: meta.fecN
          };
        }
      }
    }

    var key = fileId + '-' + frameIdx;
    if (state.receivedSet.has(key)) {
      return { status: 'dup', frameIdx: frameIdx };
    }

    state.receivedSet.add(key);
    state.receivedFrames.set(key, payload);

    if (state.fecBlocks[fecGroup]) {
      state.fecBlocks[fecGroup].received.set(frameIdx, payload);
    }

    // Check if all blocks have enough frames
    if (checkAllBlocks()) {
      state.complete = true;
      return reconstructFile().then(function(result) {
        result.status = 'complete';
        return result;
      });
    }

    return {
      status: 'new',
      frameIdx: frameIdx,
      totalReceived: state.receivedSet.size,
      totalExpected: state.totalExpected,
      blocksReady: countReadyBlocks()
    };
  }

  function ingestFrameBinary(frameBytes) {
    return ingestFrame(frameBytes);
  }

  function checkAllBlocks() {
    if (!state || !state.fecBlocks) return false;
    var blockIds = Object.keys(state.fecBlocks);
    if (blockIds.length === 0) return false;
    for (var i = 0; i < blockIds.length; i++) {
      var gid = blockIds[i];
      if (state.fecBlocks[gid].received.size < state.fecBlocks[gid].k) {
        return false;
      }
    }
    return true;
  }

  function countReadyBlocks() {
    if (!state || !state.fecBlocks) return 0;
    var count = 0;
    var blockIds = Object.keys(state.fecBlocks);
    for (var i = 0; i < blockIds.length; i++) {
      if (state.fecBlocks[blockIds[i]].received.size >= state.fecBlocks[blockIds[i]].k) count++;
    }
    return count;
  }

  function reconstructFile() {
    if (!state || !state.metadata) return Promise.resolve(null);
    var meta = state.metadata;
    var totalBlocks = Math.ceil(state.totalExpected / meta.fecK);
    var allDataFrames = [];

    for (var gid = 0; gid < totalBlocks; gid++) {
      var block = state.fecBlocks[gid];
      if (!block) continue;

      var received = block.received;
      var receivedIndices = [];
      var receivedPayloads = [];
      received.forEach(function(payload, idx) {
        receivedIndices.push(idx);
        receivedPayloads.push(payload);
      });

      // Pad to same length
      var maxLen = 0;
      for (var i = 0; i < receivedPayloads.length; i++) {
        if (receivedPayloads[i].length > maxLen) maxLen = receivedPayloads[i].length;
      }
      var padded = receivedPayloads.map(function(p) {
        if (p.length === maxLen) return p;
        var np = new Uint8Array(maxLen);
        np.set(p);
        return np;
      });

      // Take first K frames for decoding
      var k = block.k;
      var n = block.n;
      var decodeIndices = receivedIndices.slice(0, k);
      var decodeFrames = padded.slice(0, k);

      var recovered = ReedSolomon.decode(decodeFrames, decodeIndices, k, n);

      for (var i = 0; i < k; i++) {
        allDataFrames.push({ gid: gid, frameInGroup: i, data: recovered[i] });
      }
    }

    // Sort and concatenate
    allDataFrames.sort(function(a, b) {
      if (a.gid !== b.gid) return a.gid - b.gid;
      return a.frameInGroup - b.frameInGroup;
    });

    var fileChunks = [];
    for (var i = 0; i < allDataFrames.length; i++) {
      var f = allDataFrames[i];
      if (f.gid === 0 && f.frameInGroup === 0) continue; // skip metadata
      fileChunks.push(f.data);
    }

    var totalLen = 0;
    for (var i = 0; i < fileChunks.length; i++) totalLen += fileChunks[i].length;
    var fileBytes = new Uint8Array(totalLen);
    var offset = 0;
    for (var i = 0; i < fileChunks.length; i++) {
      fileBytes.set(fileChunks[i], offset);
      offset += fileChunks[i].length;
    }

    var finalBytes = fileBytes.slice(0, meta.fileSize);

    return SHA256.hash(finalBytes).then(function(hash) {
      var verified = true;
      for (var i = 0; i < 32; i++) {
        if (hash[i] !== meta.sha256[i]) { verified = false; break; }
      }

      return {
        filename: meta.filename,
        fileSize: meta.fileSize,
        bytes: finalBytes,
        sha256Verified: verified,
        totalFramesExpected: state.totalExpected,
        totalFramesReceived: state.receivedSet.size
      };
    });
  }

  function getTotalWithParity() {
    if (!state || !state.metadata) return null;
    var blocks = Math.ceil(state.totalExpected / state.metadata.fecK);
    return state.totalExpected + blocks * state.metadata.fecN;
  }

  function getMissingFrames() {
    if (!state || state.totalExpected === null) return new Set();
    // Include parity frames in missing check
    var totalWithParity = getTotalWithParity();
    var end = totalWithParity !== null ? totalWithParity : state.totalExpected;
    var missing = new Set();
    for (var i = 0; i < end; i++) {
      if (!state.receivedSet.has('0-' + i)) {
        missing.add(i);
      }
    }
    return missing;
  }

  function getStats() {
    if (!state) return { received: 0, expected: null, blocksReady: 0, totalBlocks: 0, complete: false };
    var totalWithParity = getTotalWithParity();
    return {
      received: state.receivedSet.size,
      expected: state.totalExpected,
      expectedWithParity: totalWithParity,
      blocksReady: countReadyBlocks(),
      totalBlocks: Object.keys(state.fecBlocks).length,
      complete: state.complete
    };
  }

  function reset() { state = null; init(); }

  return { init: init, ingestFrame: ingestFrame, ingestFrameBinary: ingestFrameBinary,
           getMissingFrames: getMissingFrames, getStats: getStats, reset: reset };
})();
