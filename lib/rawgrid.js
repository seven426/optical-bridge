// RawGrid — minimal 2D barcode for screen-capture transmission
// Black corner squares (6x6 cells) on white bg + sync row/col.

const RawGrid = (() => {
  const CORNER = 6;    // corner marker: black square, cells per side
  const GAP = 1;       // white gap cells around corner
  const SYNC = 1;      // sync row/col width
  const PAD = 2;       // dark padding cells around grid
  const MIN_GRID = 60; // reject false-positive small grids

  function dataCells(gridSize) {
    var ds = gridSize - 2 * (CORNER + GAP) - SYNC;
    return ds > 0 ? ds * ds : 0;
  }

  function gridSizeForBytes(dataLen) {
    var bits = dataLen * 8;
    for (var gs = CORNER * 2 + GAP * 2 + SYNC + 1; ; gs++) {
      if (dataCells(gs) >= bits) return gs;
    }
  }

  function render(data, cellPx) {
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var bits = bytes.length * 8;
    var gridSize = gridSizeForBytes(bytes.length);
    var paddedSize = gridSize + 2 * PAD;
    var totalPx = paddedSize * cellPx;
    var off = PAD;  // grid offset in cells

    var c = document.createElement('canvas');
    c.width = totalPx; c.height = totalPx;
    var ctx = c.getContext('2d');

    // Gray padding frame (must NOT merge with black corner in detection)
    ctx.fillStyle = '#909090';
    ctx.fillRect(0, 0, totalPx, totalPx);

    // White grid area
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(off * cellPx, off * cellPx, gridSize * cellPx, gridSize * cellPx);

    // Black corner squares (CORNER x CORNER)
    ctx.fillStyle = '#000000';
    var corners = [[0,0],[gridSize-CORNER,0],[0,gridSize-CORNER],[gridSize-CORNER,gridSize-CORNER]];
    for (var k = 0; k < corners.length; k++) {
      ctx.fillRect((off + corners[k][0]) * cellPx, (off + corners[k][1]) * cellPx,
                   CORNER * cellPx, CORNER * cellPx);
    }

    var dataStart = CORNER + GAP;
    var dataSide = gridSize - 2 * dataStart - SYNC;

    // Sync row and col (alternating black/white every 4 cells)
    var syncY = (off + dataStart - SYNC) * cellPx;
    var syncX = (off + dataStart - SYNC) * cellPx;
    for (var s = 0; s < gridSize; s++) {
      if (Math.floor(s / 4) % 2) {
        ctx.fillRect((off + s) * cellPx, syncY, cellPx, cellPx);
        ctx.fillRect(syncX, (off + s) * cellPx, cellPx, cellPx);
      }
    }

    // Data cells
    var bi = 0;
    for (var r = 0; r < dataSide && bi < bits; r++)
      for (var col = 0; col < dataSide && bi < bits; col++) {
        if ((bytes[bi >> 3] >> (7 - (bi & 7))) & 1)
          ctx.fillRect((off + dataStart + col) * cellPx, (off + dataStart + r) * cellPx, cellPx, cellPx);
        bi++;
      }

    return c;
  }

  // Locate grid by finding paired black corner squares on the same row
  function locateGrid(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);

    // Find all black runs (looking for CORNER*cellPx sized dark blocks)
    var blacks = [];
    for (var ly = 0; ly < imgH; ly += 3) {
      var rb = ly * width * 4;
      var inBlack = false, bs = 0;
      for (var lx = 0; lx < width; lx++) {
        var lum = pixels[rb + lx*4] * 0.299 + pixels[rb + lx*4 + 1] * 0.587 + pixels[rb + lx*4 + 2] * 0.114;
        var isBlack = lum < 96;
        if (isBlack && !inBlack) { inBlack = true; bs = lx; }
        else if (!isBlack && inBlack) {
          var len = lx - bs;
          if (len >= 18 && len <= 60) blacks.push({ x: bs, y: ly, w: len });
          inBlack = false;
        }
      }
    }

    if (blacks.length < 2) return null;

    // Pair candidates: find two similarly-sized black blocks on nearby rows
    var best = null, bestScore = -1;
    for (var i = 0; i < blacks.length; i++) {
      var a = blacks[i];
      var cpa = Math.round(a.w / CORNER);
      if (cpa < 3 || cpa > 12) continue;

      for (var j = i + 1; j < blacks.length; j++) {
        var b = blacks[j];
        if (Math.abs(b.y - a.y) > 8) continue;
        var cpb = Math.round(b.w / CORNER);
        if (cpb !== cpa) continue;
        if (b.x <= a.x + a.w) continue;  // b must be to the right of a

        // Score: distance between corners should be reasonable
        var dist = b.x - a.x;
        var cells = Math.round(dist / cpa + CORNER);
        if (cells < MIN_GRID || cells > 150) continue;

        // Verify: sample corner interior for darkness
        var sx = a.x + Math.floor(a.w / 2), sy = a.y + Math.floor(a.w / 2);
        var pi2 = (sy * width + sx) * 4;
        if (pi2 + 2 >= pixels.length) continue;
        var dark = pixels[pi2] * 0.299 + pixels[pi2 + 1] * 0.587 + pixels[pi2 + 2] * 0.114;
        if (dark > 80) continue;

        // Verify: region between corners should be mostly white (the grid area)
        var midY = sy;
        var whiteCount = 0, totalCount = 0;
        var step = Math.max(1, Math.floor((b.x - a.x - a.w) / 20));
        for (var mx = a.x + a.w; mx < b.x; mx += step) {
          var mpi = (midY * width + mx) * 4;
          if (mpi + 2 < pixels.length) {
            if (pixels[mpi] * 0.299 + pixels[mpi + 1] * 0.587 + pixels[mpi + 2] * 0.114 > 160) whiteCount++;
            totalCount++;
          }
        }
        if (totalCount < 5 || whiteCount / totalCount < 0.7) continue;

        var score = cells + whiteCount;
        if (score > bestScore) {
          bestScore = score;
          best = { x: a.x, y: a.y, cellPx: cpa, gridSize: cells };
        }
      }
    }

    return best;
  }

  // Check if a decoded byte array starts with "OB" magic
  function isValidFrame(bytes) {
    if (!bytes || bytes.length < 20) return false;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return dv.getUint16(0, false) === 0x4F42;
  }

  function decode(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);

    // Try corner-based location with validation
    var grid = locateGrid(pixels, width, height);
    if (grid && (grid.gridSize || 0) >= MIN_GRID) {
      var r = decodeRegion(pixels, width, Math.min(imgH, height), grid);
      if (isValidFrame(r)) return r;
    }

    // Retry without grid size filter
    if (grid) {
      grid.gridSize = 0;
      var r2 = decodeRegion(pixels, width, Math.min(imgH, height), grid);
      if (isValidFrame(r2)) return r2;
    }

    // Fallback: detect cell size from sync pattern
    var cp = detectCellSize(pixels, width, height);
    if (cp && cp >= 2) {
      var r3 = decodeRegion(pixels, width, imgH, { x: 0, y: 0, cellPx: cp });
      if (isValidFrame(r3)) return r3;
    }

    return null;
  }

  function decodeRegion(pixels, imgW, imgH, grid) {
    var cellPx = grid.cellPx;
    var gridSize = grid.gridSize;
    if (!gridSize) {
      gridSize = Math.floor(Math.min(imgW - grid.x, imgH - grid.y) / cellPx);
    }
    if (gridSize < CORNER * 2 + GAP * 2 + SYNC + 2) return null;

    var dataStart = CORNER + GAP;
    var dataSide = gridSize - 2 * dataStart - SYNC;
    if (dataSide <= 0) return null;

    var totalBits = dataSide * dataSide;
    var byteLen = totalBits >> 3;
    var result = new Uint8Array(byteLen);

    var bi = 0;
    for (var row = 0; row < dataSide && bi < totalBits; row++)
      for (var col = 0; col < dataSide && bi < totalBits; col++) {
        var cx = Math.floor(grid.x + (dataStart + col + 0.5) * cellPx);
        var cy = Math.floor(grid.y + (dataStart + row + 0.5) * cellPx);
        if (cx < imgW && cy < imgH) {
          var pi = (cy * imgW + cx) * 4;
          if (pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114 < 128)
            result[bi >> 3] |= (1 << (7 - (bi & 7)));
        }
        bi++;
      }

    return result;
  }

  function detectCellSize(pixels, width, height) {
    var y = Math.floor(height * 0.1);
    var trans = [], last = null;
    for (var x = 0; x < width; x++) {
      var pi = (y * width + x) * 4;
      var val = pixels[pi] < 128 ? 1 : 0;
      if (last !== null && val !== last) trans.push(x);
      last = val;
    }
    if (trans.length < 4) return null;
    var gaps = [];
    for (var i = 1; i < trans.length; i++) gaps.push(trans[i] - trans[i - 1]);
    gaps.sort(function(a, b) { return a - b; });
    var m = gaps[Math.floor(gaps.length / 2)];
    return (m >= 2 && m <= 20) ? Math.round(m / 4) : null;
  }

  return { render, decode, locateGrid, dataCells, gridSizeForBytes };
})();
