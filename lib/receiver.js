const Receiver = (() => {
  let state = null;

  function init() {
    state = {
      metadata: null,
      receivedSet: new Set(),      // for dedup
      pendingFrames: [],           // frames received before Frame #0 initialized blocks
      fecBlocks: {},              // groupId -> { received: Map<frameIdx, payload>, k, n }
      totalExpected: null,
      totalBlocks: 0,
      readyBlockCount: 0,
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

    // Initialize FEC blocks from first valid frame (only once)
    if (state.totalExpected === null && fecK > 0 && fecK < fecGroupSize) {
      var fecN = fecGroupSize - fecK;
      state.totalExpected = totalFrames;
      state.fileSizeFromHeader = fileSize;
      state.totalBlocks = Math.ceil(totalFrames / fecK);
      state.readyBlockCount = 0;
      for (var g = 0; g < state.totalBlocks; g++) {
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
        var pblock = state.fecBlocks[pf.fecGroup];
        if (pblock) {
          var pPrevSize = pblock.received.size;
          pblock.received.set(pf.frameIdx, pf.payload);
          if (pPrevSize === fecK - 1) state.readyBlockCount++;
        }
      }
      state.pendingFrames = [];
    }


    var key = fileId + '-' + frameIdx;
    if (state.receivedSet.has(key)) {
      return { status: 'dup', frameIdx: frameIdx };
    }

    state.receivedSet.add(key);

    if (state.fecBlocks[fecGroup]) {
      var block = state.fecBlocks[fecGroup];
      var prevSize = block.received.size;
      block.received.set(frameIdx, payload);
      if (prevSize === block.k - 1) state.readyBlockCount++;
    } else {
      // Blocks not initialized yet (Frame #0 not received), save for later replay
      // Cap pendingFrames to prevent OOM if Frame #0 is never received
      if (state.pendingFrames.length < 500) {
        state.pendingFrames.push({ fecGroup: fecGroup, frameIdx: frameIdx, payload: payload });
      }
    }

    // Check if all blocks have enough frames
    if (state.totalBlocks > 0 && state.readyBlockCount === state.totalBlocks && !state.complete) {
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
          blocksReady: state.readyBlockCount,
          totalBlocks: state.totalBlocks
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
          blocksReady: state.readyBlockCount
        };
      }
    }

    if (state.processing) {
      return {
        status: 'processing',
        totalReceived: state.receivedSet.size,
        totalExpected: state.totalExpected,
        blocksReady: state.readyBlockCount
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
      blocksReady: state.readyBlockCount
    };
  }

  function ingestFrameBinary(frameBytes) {
    return ingestFrame(frameBytes);
  }

  function reconstructFile() {
    if (!state || state.totalExpected === null) return Promise.resolve(null);
    var fecK = state.fecBlocks[0] ? state.fecBlocks[0].k : 0;
    if (!fecK) return Promise.resolve(null);
    var fileSize = state.fileSizeFromHeader || 0;
    if (!fileSize) return Promise.resolve(null);
    var allDataFrames = [];

    for (var gid = 0; gid < state.totalBlocks; gid++) {
      var block = state.fecBlocks[gid];
      if (!block) continue;

      var received = block.received;
      var k = block.k;
      var n = block.n;
      var groupSize = k + n;

      var receivedIndices = [];
      var receivedPayloads = [];
      received.forEach(function(payload, globalIdx) {
        receivedIndices.push(globalIdx % groupSize);
        receivedPayloads.push(payload);
      });

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

      var decodeIndices = receivedIndices.slice(0, k);
      var decodeFrames = padded.slice(0, k);

      var recovered = ReedSolomon.decode(decodeFrames, decodeIndices, k, n);

      for (var i = 0; i < k; i++) {
        allDataFrames.push({ gid: gid, frameInGroup: i, data: recovered[i] });
      }
    }

    allDataFrames.sort(function(a, b) {
      if (a.gid !== b.gid) return a.gid - b.gid;
      return a.frameInGroup - b.frameInGroup;
    });

    var fileChunks = [];
    for (var i = 0; i < allDataFrames.length; i++) {
      fileChunks.push(allDataFrames[i].data);
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
      var sha256hex = '';
      for (var i = 0; i < 32; i++) {
        sha256hex += hash[i].toString(16).padStart(2, '0');
      }

      return {
        fileSize: fileSize,
        bytes: finalBytes,
        sha256hex: sha256hex,
        totalFramesExpected: state.totalExpected,
        totalFramesReceived: state.receivedSet.size
      };
    });
  }

  function getTotalWithParity() {
    if (!state || state.totalExpected === null) return null;
    var fecK = state.fecBlocks[0] ? state.fecBlocks[0].k : 0;
    if (!fecK) return null;
    var fecN = state.fecBlocks[0] ? state.fecBlocks[0].n : 0;
    var blocks = Math.ceil(state.totalExpected / fecK);
    return blocks * (fecK + fecN);
  }

  function getMissingFrames() {
    if (!state || state.totalExpected === null) return new Set();
    var totalWithParity = getTotalWithParity();
    if (totalWithParity === null) return new Set();
    var fecK = state.fecBlocks[0] ? state.fecBlocks[0].k : 0;
    if (!fecK) return new Set();
    var groupSize = fecK + (state.fecBlocks[0] ? state.fecBlocks[0].n : 0);

    var missing = new Set();
    for (var i = 0; i < totalWithParity; i++) {
      var blk = Math.floor(i / groupSize);
      var block = state.fecBlocks[blk];
      if (block && block.received.size >= fecK) continue;
      if (!state.receivedSet.has('0-' + i)) {
        missing.add(i);
      }
    }
    return missing;
  }

  function getMissingBlocks() {
    if (!state || state.totalBlocks === 0) return new Set();
    var fecK = state.fecBlocks[0] ? state.fecBlocks[0].k : 0;
    if (!fecK) return new Set();
    var missing = new Set();
    for (var gid = 0; gid < state.totalBlocks; gid++) {
      var block = state.fecBlocks[gid];
      if (block && block.received.size < fecK) {
        missing.add(gid);
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
      blocksReady: state.readyBlockCount,
      totalBlocks: state.totalBlocks,
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
           getMissingFrames: getMissingFrames, getMissingBlocks: getMissingBlocks, getStats: getStats, reset: reset,
           getProcessingPromise: getProcessingPromise, getFileResult: getFileResult };
})();
