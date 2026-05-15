const Receiver = (() => {
  let state = null;

  function init() {
    state = {
      metadata: null,
      receivedFrames: new Map(),   // "fileId-frameIdx" -> Uint8Array payload
      receivedSet: new Set(),      // for dedup
      pendingFrames: [],           // frames received before Frame #0 initialized blocks
      fecBlocks: {},              // groupId -> { received: Map<frameIdx, payload>, k, n }
      totalExpected: null,
      complete: false,
      processing: false,
      processingPromise: null,
      fileResult: null
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
    var fecK = unpacked.fecK;
    var fileSize = unpacked.fileSize;
    var payload = unpacked.payload;

    // Initialize FEC blocks from ANY frame (no longer dependent on Frame #0)
    if (!state.metadata && fecK > 0 && fecK < fecGroupSize) {
      var fecN = fecGroupSize - fecK;
      state.totalExpected = totalFrames;
      state.fileSizeFromHeader = fileSize;
      var totalBlocks = Math.ceil(totalFrames / fecK);
      for (var g = 0; g < totalBlocks; g++) {
        state.fecBlocks[g] = {
          received: new Map(),
          size: fecGroupSize,
          k: fecK,
          n: fecN
        };
      }
      // Replay pending frames
      for (var p = 0; p < state.pendingFrames.length; p++) {
        var pf = state.pendingFrames[p];
        if (state.fecBlocks[pf.fecGroup]) {
          state.fecBlocks[pf.fecGroup].received.set(pf.frameIdx, pf.payload);
        }
      }
      state.pendingFrames = [];
    }

    // Frame #0: extract filename and SHA-256 for final verification
    if (frameIdx === 0 && !state.metadata) {
      var meta = FrameProtocol.parseMetadataPayload(payload);
      if (meta) {
        state.metadata = meta;
        // metadata from Frame #0 can override header values if more accurate
        if (!state.totalExpected) state.totalExpected = totalFrames;
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
    } else {
      // Blocks not initialized yet (Frame #0 not received), save for later replay
      // Cap pendingFrames to prevent OOM if Frame #0 is never received
      if (state.pendingFrames.length < 500) {
        state.pendingFrames.push({ fecGroup: fecGroup, frameIdx: frameIdx, payload: payload });
      }
    }

    // Check if all blocks have enough frames
    if (checkAllBlocks() && !state.complete) {
      state.complete = true;
      state.processing = true;
      try {
        var promise = reconstructFile().then(function(result) {
          state.processing = false;
          state.fileResult = result;
          return result;
        }).catch(function(err) {
          console.error('reconstructFile failed:', err);
          state.processing = false;
          state.complete = false;
        });
        state.processingPromise = promise;
        return {
          status: 'processing',
          blocksReady: countReadyBlocks(),
          totalBlocks: Object.keys(state.fecBlocks).length
        };
      } catch (e) {
        console.error('reconstructFile threw:', e);
        state.processing = false;
        state.complete = false;
        return {
          status: 'new',
          frameIdx: frameIdx,
          totalReceived: state.receivedSet.size,
          totalExpected: state.totalExpected,
          blocksReady: countReadyBlocks()
        };
      }
    }

    if (state.processing) {
      return {
        status: 'processing',
        totalReceived: state.receivedSet.size,
        totalExpected: state.totalExpected,
        blocksReady: countReadyBlocks()
      };
    }

    if (state.complete && state.fileResult) {
      var fr = state.fileResult;
      fr.status = 'complete';
      return Promise.resolve(fr);
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
    if (!state || state.totalExpected === null) return Promise.resolve(null);
    // Get FEC K and fileSize from metadata (Frame #0) or fall back to first block
    var fecK = (state.metadata ? state.metadata.fecK : 0) || (state.fecBlocks[0] ? state.fecBlocks[0].k : 0);
    if (!fecK) return Promise.resolve(null);
    var fileSize = (state.metadata ? state.metadata.fileSize : 0) || state.fileSizeFromHeader || 0;
    if (!fileSize) return Promise.resolve(null);
    var totalBlocks = Math.ceil(state.totalExpected / fecK);
    var allDataFrames = [];

    for (var gid = 0; gid < totalBlocks; gid++) {
      var block = state.fecBlocks[gid];
      if (!block) continue;

      var received = block.received;
      var k = block.k;
      var n = block.n;
      var groupSize = k + n;

      // Convert global frameIdx to block-local index (0..groupSize-1) for RS matrix
      var receivedIndices = [];
      var receivedPayloads = [];
      received.forEach(function(payload, globalIdx) {
        receivedIndices.push(globalIdx % groupSize);
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

    var finalBytes = fileBytes.slice(0, fileSize);

    return SHA256.hash(finalBytes).then(function(hash) {
      var filename = 'received_file';
      var verified = false;
      if (state.metadata) {
        filename = state.metadata.filename;
        verified = true;
        for (var i = 0; i < 32; i++) {
          if (hash[i] !== state.metadata.sha256[i]) { verified = false; break; }
        }
      }

      return {
        filename: filename,
        fileSize: fileSize,
        bytes: finalBytes,
        sha256Verified: verified,
        totalFramesExpected: state.totalExpected,
        totalFramesReceived: state.receivedSet.size
      };
    });
  }

  function getTotalWithParity() {
    if (!state || state.totalExpected === null) return null;
    var fecK = (state.metadata ? state.metadata.fecK : 0) || (state.fecBlocks[0] ? state.fecBlocks[0].k : 0);
    if (!fecK) return null;
    var fecN = (state.metadata ? state.metadata.fecN : 0) || (state.fecBlocks[0] ? state.fecBlocks[0].n : 0);
    var blocks = Math.ceil(state.totalExpected / fecK);
    return blocks * (fecK + fecN);
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
      complete: state.complete,
      processing: state.processing
    };
  }

  function getProcessingPromise() {
    return state ? state.processingPromise : null;
  }

  function getFileResult() {
    return state ? state.fileResult : null;
  }

  function reset() { state = null; init(); }

  return { init: init, ingestFrame: ingestFrame, ingestFrameBinary: ingestFrameBinary,
           getMissingFrames: getMissingFrames, getStats: getStats, reset: reset,
           getProcessingPromise: getProcessingPromise, getFileResult: getFileResult };
})();
