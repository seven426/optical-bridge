// RawGrid — minimal 2D barcode for screen-capture transmission
// No QR structures, no frame-level ECC (FEC handles frame loss).
// Corner markers (8x8 white squares) + sync row/col for alignment.

const RawGrid = (() => {
  const CORNER = 8;           // corner marker size in cells
  const CORNER_BORDER = 1;    // black border around corner
  const SYNC = 1;             // sync row/col width

  // Number of data cells available given total grid size
  function dataCells(gridSize) {
    var dataSide = gridSize - 2 * (CORNER + CORNER_BORDER) - SYNC;
    if (dataSide <= 0) return 0;
    return dataSide * dataSide;
  }

  // Total grid size needed for dataLen bytes
  function gridSizeForBytes(dataLen) {
    var bits = dataLen * 8;
    for (var gs = CORNER * 2 + SYNC + 1; ; gs++) {
      if (dataCells(gs) >= bits) return gs;
    }
  }

  // Render data bytes to a canvas, return the canvas
  function render(data, cellPx) {
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var bits = bytes.length * 8;
    var gridSize = gridSizeForBytes(bytes.length);
    var totalPx = gridSize * cellPx;

    var canvas = document.createElement('canvas');
    canvas.width = totalPx;
    canvas.height = totalPx;
    var ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalPx, totalPx);

    // Corner markers: white square with black border
    function drawCorner(gx, gy) {
      var cx = gx * cellPx, cy = gy * cellPx;
      var sz = CORNER * cellPx;
      var bd = CORNER_BORDER * cellPx;
      ctx.fillStyle = '#000000';
      ctx.fillRect(cx - bd, cy - bd, sz + 2*bd, sz + 2*bd);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx, cy, sz, sz);
    }

    drawCorner(0, 0);
    drawCorner(gridSize - CORNER, 0);
    drawCorner(0, gridSize - CORNER);
    drawCorner(gridSize - CORNER, gridSize - CORNER);

    // Sync row and sync col: alternating B/W every 4 cells
    var dataStart = CORNER + CORNER_BORDER;
    var dataSide = gridSize - 2 * dataStart - SYNC;
    var syncRowY = dataStart - SYNC;
    var syncColX = dataStart - SYNC;

    ctx.fillStyle = '#000000';
    for (var s = 0; s < gridSize; s++) {
      var bit = Math.floor(s / 4) % 2;
      if (bit) {
        ctx.fillRect(s * cellPx, syncRowY * cellPx, cellPx, cellPx);
        ctx.fillRect(syncColX * cellPx, s * cellPx, cellPx, cellPx);
      }
    }

    // Data cells
    ctx.fillStyle = '#000000';
    var bitIdx = 0;
    for (var row = 0; row < dataSide && bitIdx < bits; row++) {
      for (var col = 0; col < dataSide && bitIdx < bits; col++) {
        var byteIdx = bitIdx >> 3;
        var bitInByte = 7 - (bitIdx & 7);
        var val = (bytes[byteIdx] >> bitInByte) & 1;
        if (val) {
          var dx = (dataStart + col) * cellPx;
          var dy = (dataStart + row) * cellPx;
          ctx.fillRect(dx, dy, cellPx, cellPx);
        }
        bitIdx++;
      }
    }

    return canvas;
  }

  // Decode pixel data from a crop region, return Uint8Array or null
  function decode(pixels, width, height) {
    // Locate corner markers by scanning for 8x8 white blocks
    // Simplified: sample at expected positions assuming known layout
    // Caller should provide the crop region tightly around the grid

    // Find grid scale: detect black-white transitions on first row
    var cellPx = detectCellSize(pixels, width, height);
    if (!cellPx || cellPx < 2) return null;

    var gridSize = Math.floor(width / cellPx);
    if (gridSize < CORNER * 2 + SYNC + 2) return null;

    var dataStart = CORNER + CORNER_BORDER;
    var dataSide = gridSize - 2 * dataStart - SYNC;
    if (dataSide <= 0) return null;

    var totalBits = dataSide * dataSide;
    var byteLen = totalBits >> 3;
    var result = new Uint8Array(byteLen);

    var bitIdx = 0;
    for (var row = 0; row < dataSide && bitIdx < totalBits; row++) {
      for (var col = 0; col < dataSide && bitIdx < totalBits; col++) {
        var cx = Math.floor((dataStart + col + 0.5) * cellPx);
        var cy = Math.floor((dataStart + row + 0.5) * cellPx);
        var pi = (cy * width + cx) * 4;
        var luminance = pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
        var val = luminance < 128 ? 1 : 0;

        var byteIdx = bitIdx >> 3;
        var bitInByte = 7 - (bitIdx & 7);
        if (val) result[byteIdx] |= (1 << bitInByte);
        bitIdx++;
      }
    }

    return result;
  }

  // Detect cell size in pixels from sync row transitions
  function detectCellSize(pixels, width, height) {
    // Sample a horizontal line through the expected sync row area
    // Count pixels between transitions
    var y = Math.floor(height * 0.1);  // sample near top
    var transitions = [];
    var lastVal = null;
    for (var x = 0; x < width; x++) {
      var pi = (y * width + x) * 4;
      var val = pixels[pi] < 128 ? 1 : 0;
      if (lastVal !== null && val !== lastVal) {
        transitions.push(x);
      }
      lastVal = val;
    }
    if (transitions.length < 4) return null;

    // Median gap between transitions = cell size
    var gaps = [];
    for (var i = 1; i < transitions.length; i++) {
      gaps.push(transitions[i] - transitions[i - 1]);
    }
    gaps.sort(function(a, b) { return a - b; });
    var medianGap = gaps[Math.floor(gaps.length / 2)];

    // Sync alternates every 4 cells, so cellPx = median gap between sync edges
    if (medianGap < 2 || medianGap > 20) return null;
    return Math.round(medianGap / 4);
  }

  return { render, decode, dataCells, gridSizeForBytes, detectCellSize };
})();
