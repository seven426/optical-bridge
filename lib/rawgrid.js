// RawGrid — minimal 2D barcode for screen-capture transmission
// No QR structures, no frame-level ECC (FEC handles frame loss).
// Corner markers (8x8 white squares with black border) + sync row/col for alignment.

const RawGrid = (() => {
  const CORNER = 8;
  const CORNER_BORDER = 2;
  const SYNC = 1;
  const PAD = 2;  // extra padding cells around the grid so corner borders aren't clipped

  function dataCells(gridSize) {
    var dataSide = gridSize - 2 * (CORNER + CORNER_BORDER) - SYNC;
    return dataSide > 0 ? dataSide * dataSide : 0;
  }

  function gridSizeForBytes(dataLen) {
    var bits = dataLen * 8;
    for (var gs = CORNER * 2 + SYNC + 1; ; gs++) {
      if (dataCells(gs) >= bits) return gs;
    }
  }

  function render(data, cellPx) {
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var bits = bytes.length * 8;
    var gridSize = gridSizeForBytes(bytes.length);
    var paddedSize = gridSize + 2 * PAD;
    var totalPx = paddedSize * cellPx;

    var canvas = document.createElement('canvas');
    canvas.width = totalPx;
    canvas.height = totalPx;
    var ctx = canvas.getContext('2d');

    // Dark background for padding area (makes corner borders visible)
    ctx.fillStyle = '#404040';
    ctx.fillRect(0, 0, totalPx, totalPx);

    // White grid background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(PAD * cellPx, PAD * cellPx, gridSize * cellPx, gridSize * cellPx);

    var off = PAD;  // pixel offset for grid content

    function drawCorner(gx, gy) {
      var cx = (off + gx) * cellPx, cy = (off + gy) * cellPx;
      var sz = CORNER * cellPx;
      var bd = CORNER_BORDER * cellPx;
      ctx.fillStyle = '#000000';
      ctx.fillRect(cx - bd, cy - bd, sz + 2 * bd, sz + 2 * bd);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx, cy, sz, sz);
    }

    drawCorner(0, 0);
    drawCorner(gridSize - CORNER, 0);
    drawCorner(0, gridSize - CORNER);
    drawCorner(gridSize - CORNER, gridSize - CORNER);

    var dataStart = CORNER + CORNER_BORDER;
    var dataSide = gridSize - 2 * dataStart - SYNC;
    var syncRowY = (off + dataStart - SYNC) * cellPx;
    var syncColX = (off + dataStart - SYNC) * cellPx;

    ctx.fillStyle = '#000000';
    for (var s = 0; s < gridSize; s++) {
      if (Math.floor(s / 4) % 2) {
        ctx.fillRect((off + s) * cellPx, syncRowY, cellPx, cellPx);
        ctx.fillRect(syncColX, (off + s) * cellPx, cellPx, cellPx);
      }
    }

    ctx.fillStyle = '#000000';
    var bitIdx = 0;
    for (var row = 0; row < dataSide && bitIdx < bits; row++) {
      for (var col = 0; col < dataSide && bitIdx < bits; col++) {
        if ((bytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) {
          ctx.fillRect((off + dataStart + col) * cellPx, (off + dataStart + row) * cellPx, cellPx, cellPx);
        }
        bitIdx++;
      }
    }

    return canvas;
  }

  // Locate grid by scanning for corner markers (white blocks with dark borders)
  function locateGrid(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);
    var candidates = [];

    // Scan horizontal lines looking for white runs
    for (var ly = 0; ly < imgH; ly += 4) {
      var rowBase = ly * width * 4;
      var inWhite = false, whiteStart = 0;
      for (var lx = 0; lx < width; lx++) {
        var pi = rowBase + lx * 4;
        var lum = pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
        var isWhite = lum > 160;
        if (isWhite && !inWhite) { inWhite = true; whiteStart = lx; }
        else if (!isWhite && inWhite) {
          var runLen = lx - whiteStart;
          if (runLen >= 16 && runLen <= 100) candidates.push({ x: whiteStart, y: ly, w: runLen });
          inWhite = false;
        }
      }
    }

    if (candidates.length === 0) return null;

    // Find best top-left and top-right corner pair on similar Y
    var bestPair = null, bestScore = -1;
    for (var ci = 0; ci < candidates.length; ci++) {
      var ca = candidates[ci];
      var cpa = Math.round(ca.w / CORNER);
      if (cpa < 2 || cpa > 12) continue;

      // Score this as a potential top-left corner
      var scoreA = scoreCandidate(pixels, width, imgH, ca, cpa);
      if (scoreA < 0.6) continue;

      // Look for a matching top-right corner on a similar row
      for (var cj = ci + 1; cj < candidates.length; cj++) {
        var cb = candidates[cj];
        if (Math.abs(cb.y - ca.y) > 6) continue;  // must be on nearby rows
        var cpb = Math.round(cb.w / CORNER);
        if (cpb !== cpa) continue;  // must have same cell size
        if (cb.x <= ca.x + ca.w) continue;  // must be to the right

        var scoreB = scoreCandidate(pixels, width, imgH, cb, cpb);
        if (scoreB < 0.6) continue;

        // Good pair found
        var comboScore = scoreA + scoreB;
        if (comboScore > bestScore) {
          bestScore = comboScore;
          // gridSize = distance between right edge of left corner and left edge of right corner
          var leftInnerEnd = ca.x + ca.w;  // white block ends here
          var rightInnerStart = cb.x;       // white block starts here
          var gridCells = Math.round((rightInnerStart - leftInnerEnd) / cpa + 2 * CORNER);
          bestPair = { x: ca.x, y: ca.y, cellPx: cpa, gridSize: gridCells };
        }
      }
    }

    if (!bestPair) {
      // Fallback: single corner
      var best = null, bs = -1;
      for (var ci = 0; ci < candidates.length; ci++) {
        var c = candidates[ci];
        var cp = Math.round(c.w / CORNER);
        if (cp < 2 || cp > 12) continue;
        var s = scoreCandidate(pixels, width, imgH, c, cp);
        if (s > bs) { bs = s; best = { x: c.x, y: c.y, cellPx: cp }; }
      }
      return best;
    }

    return bestPair;
  }

  function scoreCandidate(pixels, width, imgH, c, cp) {
    var innerX = c.x + CORNER_BORDER * cp;
    var innerY = c.y + CORNER_BORDER * cp;
    var innerW = CORNER * cp;
    if (innerX < 0 || innerY < 0 || innerX + innerW > width || innerY + innerW > imgH) return 0;

    // Check border above is dark (if not at image edge)
    if (c.y > 0) {
      var darkOk = true;
      for (var bx = c.x; bx < c.x + c.w && darkOk; bx += Math.max(1, c.w >> 2)) {
        var bpi = ((c.y - 1) * width + bx) * 4;
        if (bpi >= 0 && bpi + 2 < pixels.length) {
          if (pixels[bpi] * 0.299 + pixels[bpi + 1] * 0.587 + pixels[bpi + 2] * 0.114 > 100) darkOk = false;
        }
      }
      if (!darkOk) return 0;
    }

    // Sample interior for whiteness
    var wc = 0, tc = 0, step = Math.max(1, innerW >> 3);
    for (var sy = innerY; sy < innerY + innerW; sy += step)
      for (var sx = innerX; sx < innerX + innerW; sx += step) {
        var spi = (sy * width + sx) * 4;
        if (spi + 2 < pixels.length) {
          if (pixels[spi] * 0.299 + pixels[spi + 1] * 0.587 + pixels[spi + 2] * 0.114 > 160) wc++;
          tc++;
        }
      }
    return tc > 0 ? wc / tc : 0;
  }

  function decode(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);

    // Try corner-based location
    var grid = locateGrid(pixels, width, height);
    if (grid) {
      return decodeRegion(pixels, width, Math.min(imgH, height), grid);
    }

    // Fallback: assume grid fills image, detect cell size from sync patterns
    var cellPx = detectCellSize(pixels, width, height);
    if (cellPx && cellPx >= 2) {
      return decodeRegion(pixels, width, imgH, { x: 0, y: 0, cellPx: cellPx });
    }

    return null;
  }

  function decodeRegion(pixels, imgW, imgH, grid) {
    var cellPx = grid.cellPx;
    // Use grid.gridSize if available (from two-corner detection), else estimate
    var gridSize = grid.gridSize;
    if (!gridSize) {
      var maxCellsX = Math.floor((imgW - grid.x) / cellPx);
      var maxCellsY = Math.floor((imgH - grid.y) / cellPx);
      gridSize = Math.min(maxCellsX, maxCellsY);
    }
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
        var cx = Math.floor(grid.x + (dataStart + col + 0.5) * cellPx);
        var cy = Math.floor(grid.y + (dataStart + row + 0.5) * cellPx);
        if (cx >= imgW || cy >= imgH) { bitIdx++; continue; }
        var pi = (cy * imgW + cx) * 4;
        var lum = pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
        if (lum < 128) result[bitIdx >> 3] |= (1 << (7 - (bitIdx & 7)));
        bitIdx++;
      }
    }

    return result;
  }

  function detectCellSize(pixels, width, height) {
    var y = Math.floor(height * 0.1);
    var transitions = [], lastVal = null;
    for (var x = 0; x < width; x++) {
      var pi = (y * width + x) * 4;
      var val = pixels[pi] < 128 ? 1 : 0;
      if (lastVal !== null && val !== lastVal) transitions.push(x);
      lastVal = val;
    }
    if (transitions.length < 4) return null;
    var gaps = [];
    for (var i = 1; i < transitions.length; i++) gaps.push(transitions[i] - transitions[i - 1]);
    gaps.sort(function(a, b) { return a - b; });
    var m = gaps[Math.floor(gaps.length / 2)];
    return (m >= 2 && m <= 20) ? Math.round(m / 4) : null;
  }

  return { render, decode, locateGrid, dataCells, gridSizeForBytes };
})();
