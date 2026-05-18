// RawGrid v2 — QR finder patterns + raw data grid, no QR overhead
// Three 7x7 finder patterns (top-left, top-right, bottom-left) for robust location.
// One 7x7 alignment pattern (bottom-right). No timing, format, version, or QR-ECC.

const RawGrid = (() => {
  const FINDER = 7;    // finder pattern size in cells
  const GAP = 1;       // white gap around finders, and between finder and data
  const PAD = 2;       // gray padding cells around entire grid

  function gridSizeForBytes(dataLen) {
    var bits = dataLen * 8;
    // Two finders per side (FINDER+GAP) × 2, plus gap in middle
    for (var ds = 1; ; ds++) {
      var gs = ds + (FINDER + GAP) * 2;
      if (ds * ds >= bits) return gs;
    }
  }

  function dataCells(gridSize) {
    var ds = gridSize - (FINDER + GAP) * 2;
    return ds > 0 ? ds * ds : 0;
  }

  // Build an actual finder pattern into a pixel array (for rendering & detection reference)
  function finderPattern() {
    // 7x7: outer black, inner white 5x5, inner black 3x3, center white 1x1
    return [
      1,1,1,1,1,1,1,
      1,0,0,0,0,0,1,
      1,0,1,1,1,0,1,
      1,0,1,0,1,0,1,
      1,0,1,1,1,0,1,
      1,0,0,0,0,0,1,
      1,1,1,1,1,1,1
    ];
  }

  // === RENDER ===

  function render(data, cellPx) {
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var bits = bytes.length * 8;
    var gridSize = gridSizeForBytes(bytes.length);
    var paddedSize = gridSize + 2 * PAD;
    var totalPx = paddedSize * cellPx;
    var off = PAD;

    var c = document.createElement('canvas');
    c.width = totalPx; c.height = totalPx;
    var ctx = c.getContext('2d');

    // Gray padding
    ctx.fillStyle = '#909090';
    ctx.fillRect(0, 0, totalPx, totalPx);

    // White grid background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(off * cellPx, off * cellPx, gridSize * cellPx, gridSize * cellPx);

    // Finder patterns at 3 corners + bottom-right alignment
    var fp = finderPattern();
    var finderPositions = [
      [0, 0],                                     // top-left
      [gridSize - FINDER, 0],                     // top-right
      [0, gridSize - FINDER],                     // bottom-left
      [gridSize - FINDER, gridSize - FINDER]      // bottom-right
    ];

    ctx.fillStyle = '#000000';
    for (var fi = 0; fi < finderPositions.length; fi++) {
      var fx = finderPositions[fi][0], fy = finderPositions[fi][1];
      for (var i = 0; i < 49; i++) {
        if (fp[i]) {
          var col = i % 7, row = Math.floor(i / 7);
          ctx.fillRect((off + fx + col) * cellPx, (off + fy + row) * cellPx, cellPx, cellPx);
        }
      }
    }

    // Data area: starts after the top-left finder + gap
    var dataStart = FINDER + GAP;
    var dataSide = gridSize - 2 * dataStart;

    // Fill data cells
    var bi = 0;
    for (var row = 0; row < dataSide && bi < bits; row++) {
      for (var col = 0; col < dataSide && bi < bits; col++) {
        if ((bytes[bi >> 3] >> (7 - (bi & 7))) & 1) {
          ctx.fillRect((off + dataStart + col) * cellPx, (off + dataStart + row) * cellPx, cellPx, cellPx);
        }
        bi++;
      }
    }

    return c;
  }

  // === LOCATE ===

  // Find finder pattern centers by checking for the 7x7 module structure.
  // Screen capture is axis-aligned — no rotation needed.
  function locateGrid(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);

    // Step 1: find candidate black blocks of roughly FINDER * cellPx size.
    // Also verify the cross section has the characteristic 1:1:3:1:1 pattern.
    var candidates = [];

    for (var y = 0; y < imgH; y += 2) {
      for (var x = 0; x < width; x += 2) {
        // Quick reject: center pixel must be white (the finder center dot)
        var pi = (y * width + x) * 4;
        if (pi + 2 >= pixels.length) continue;
        var centerLum = pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
        if (centerLum < 100) continue;  // must be white-ish at center

        // Try different cell sizes
        for (var cp = 2; cp <= 10; cp++) {
          var half = Math.floor(FINDER * cp / 2);
          if (x - half < 0 || x + half >= width || y - half < 0 || y + half >= imgH) continue;

          // Check the finder pattern cross-section horizontally
          var ok = true;
          for (var m = 0; m < 7 && ok; m++) {
            var expected = (m === 0 || m === 6) ? 1 : (m === 1 || m === 5) ? 0 : (m === 2 || m === 4) ? 1 : 0;
            var sx = x - half + Math.floor((m + 0.5) * cp);
            var lum = sampleLum(pixels, width, sx, y);
            var isBlack = lum < 110;
            if (isBlack !== (expected === 1)) ok = false;
          }

          // Also check vertically
          if (ok) {
            for (var m = 0; m < 7 && ok; m++) {
              var expected = (m === 0 || m === 6) ? 1 : (m === 1 || m === 5) ? 0 : (m === 2 || m === 4) ? 1 : 0;
              var sy = y - half + Math.floor((m + 0.5) * cp);
              var lum = sampleLum(pixels, width, x, sy);
              var isBlack = lum < 110;
              if (isBlack !== (expected === 1)) ok = false;
            }
          }

          if (ok) {
            candidates.push({ x: x, y: y, cellPx: cp });
            break; // found a matching cp, no need to try others
          }
        }
      }
    }

    if (candidates.length < 3) return null;

    // Step 2: filter by clustering — finders with same cellPx, forming L-shape
    var best = null;

    // Group by cellPx
    var groups = {};
    for (var ci = 0; ci < candidates.length; ci++) {
      var cp = candidates[ci].cellPx;
      if (!groups[cp]) groups[cp] = [];
      if (groups[cp].length < 50) groups[cp].push(candidates[ci]);
    }

    var cpKeys = Object.keys(groups).sort(function(a,b){return b-a;});
    for (var ki = 0; ki < cpKeys.length && !best; ki++) {
      var cands = groups[cpKeys[ki]];
      if (cands.length < 3) continue;

      var cp = parseInt(cpKeys[ki]);

      // For each triple of candidates, check if they form a valid L-shape
      for (var a = 0; a < cands.length && !best; a++) {
        for (var b = a + 1; b < cands.length && !best; b++) {
          var dx = cands[b].x - cands[a].x;
          var dy = cands[b].y - cands[a].y;
          // Expect roughly horizontal: dx significant, dy near zero
          if (Math.abs(dx) < 40) continue;
          if (Math.abs(dy) > Math.abs(dx) * 0.15) continue;

          for (var c = b + 1; c < cands.length && !best; c++) {
            var dx2 = cands[c].x - cands[a].x;
            var dy2 = cands[c].y - cands[a].y;
            // Expect roughly vertical: dy significant, dx near zero
            if (Math.abs(dy2) < 40) continue;
            if (Math.abs(dx2) > Math.abs(dy2) * 0.15) continue;

            // Compute grid dimensions
            var hCells = Math.round(Math.abs(dx) / cp);
            var vCells = Math.round(Math.abs(dy2) / cp);
            if (hCells < 30 || vCells < 30 || Math.abs(hCells - vCells) > 15) continue;

            // Found a valid triple: a=tl, b=tr, c=bl
            // Grid origin = finder center - half finder size
            // Grid size = distance between finder centers (in cells) + FINDER
            best = {
              x: cands[a].x - (FINDER / 2) * cp,
              y: cands[a].y - (FINDER / 2) * cp,
              cellPx: cp,
              gridSize: Math.round((hCells + vCells) / 2) + FINDER
            };
          }
        }
      }
    }

    return best;
  }

  function sampleLum(pixels, imgW, x, y) {
    var ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || ix >= imgW || iy < 0) return 255;
    var pi = (iy * imgW + ix) * 4;
    if (pi + 2 >= pixels.length) return 255;
    return pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
  }

  // === DECODE ===

  function isValidFrame(bytes) {
    if (!bytes || bytes.length < 20) return false;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return dv.getUint16(0, false) === 0x4F42;
  }

  function decode(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);
    var grid = locateGrid(pixels, width, height);
    if (grid) {
      var r = decodeRegion(pixels, width, imgH, grid);
      if (isValidFrame(r)) return r;
    }
    return null;
  }

  function decodeRegion(pixels, imgW, imgH, grid) {
    var cellPx = grid.cellPx;
    var gridSize = grid.gridSize;
    var dataStart = FINDER + GAP;
    var dataSide = gridSize - 2 * dataStart;
    if (dataSide <= 0) return null;

    var totalBits = dataSide * dataSide;
    var byteLen = totalBits >> 3;
    var result = new Uint8Array(byteLen);

    var bi = 0;
    for (var row = 0; row < dataSide && bi < totalBits; row++) {
      for (var col = 0; col < dataSide && bi < totalBits; col++) {
        var cx = Math.floor(grid.x + (dataStart + col + 0.5) * cellPx);
        var cy = Math.floor(grid.y + (dataStart + row + 0.5) * cellPx);
        if (cx >= 0 && cx < imgW && cy >= 0 && cy < imgH) {
          var pi = (cy * imgW + cx) * 4;
          if (pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114 < 128)
            result[bi >> 3] |= (1 << (7 - (bi & 7)));
        }
        bi++;
      }
    }
    return result;
  }

  return { render, decode, locateGrid, gridSizeForBytes, dataCells, sampleLum };
})();
