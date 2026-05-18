// RawGrid v3 — QR finder patterns + jsQR-inspired ratio-scan detection
// Three 7x7 finder patterns (top-left, top-right, bottom-left) for location.
// One 7x7 alignment pattern (bottom-right). No timing, format, version, or QR-ECC.

const RawGrid = (() => {
  const FINDER = 7;
  const GAP = 1;
  const PAD = 2;

  function gridSizeForBytes(dataLen) {
    var bits = dataLen * 8;
    for (var ds = 1; ; ds++) {
      var gs = ds + (FINDER + GAP) * 2;
      if (ds * ds >= bits) return gs;
    }
  }

  function dataCells(gridSize) {
    var ds = gridSize - (FINDER + GAP) * 2;
    return ds > 0 ? ds * ds : 0;
  }

  // === RENDER === (unchanged from v2)

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

    ctx.fillStyle = '#909090';
    ctx.fillRect(0, 0, totalPx, totalPx);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(off * cellPx, off * cellPx, gridSize * cellPx, gridSize * cellPx);

    // Finder: solid vertical bars B-W-BBB-W-B (1:1:3:1:1), identical on every row
    var fp = [1,0,1,1,1,0,1];  // one row, repeated for all 7 rows
    var finderPos = [[0,0],[gridSize-FINDER,0],[0,gridSize-FINDER],[gridSize-FINDER,gridSize-FINDER]];

    ctx.fillStyle = '#000000';
    for (var fi = 0; fi < finderPos.length; fi++) {
      var fx = finderPos[fi][0], fy = finderPos[fi][1];
      for (var row = 0; row < FINDER; row++) {
        for (var col = 0; col < FINDER; col++) {
          if (fp[col]) ctx.fillRect((off+fx+col)*cellPx, (off+fy+row)*cellPx, cellPx, cellPx);
        }
      }
    }

    var dataStart = FINDER + GAP;
    var dataSide = gridSize - 2 * dataStart;
    var bi = 0;
    for (var row = 0; row < dataSide && bi < bits; row++)
      for (var col = 0; col < dataSide && bi < bits; col++) {
        if ((bytes[bi>>3]>>(7-(bi&7)))&1)
          ctx.fillRect((off+dataStart+col)*cellPx, (off+dataStart+row)*cellPx, cellPx, cellPx);
        bi++;
      }

    return c;
  }

  // === LOCATE: jsQR-style ratio scanning ===

  // Binarize image: simple global threshold (screen capture has good contrast)
  function binarize(pixels, width, height) {
    // Fixed threshold: screen capture has good contrast.
    // Black cells ~0, padding ~144, white bg ~255. 100 cleanly separates black.
    return 100;
  }

  function locateGrid(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);
    var thresh = binarize(pixels, width, height);

    // Helper: get binarized pixel value (0=white, 1=black)
    function isBlack(x, y) {
      if (x < 0 || x >= width || y < 0 || y >= imgH) return 0;
      var pi = (y * width + x) * 4;
      if (pi + 2 >= pixels.length) return 0;
      return pixels[pi]*0.299 + pixels[pi+1]*0.587 + pixels[pi+2]*0.114 < thresh ? 1 : 0;
    }

    var finderCandidates = [];   // [{top, bottom, centerX, centerY, moduleSize}]

    // Row-by-row scan with state counts
    for (var y = 0; y < imgH; y++) {
      var states = [0, 0, 0, 0, 0];  // alternating B-W-B-W-B run lengths
      var curRun = 0;
      var prevColor = isBlack(0, y);
      var runStart = 0;

      for (var x = 1; x <= width; x++) {
        var color = (x < width) ? isBlack(x, y) : (prevColor ? 0 : 1);
        curRun++;

        if (color !== prevColor || x === width) {
          // Shift states
          states.shift();
          states.push(curRun);
          curRun = 0;

          // Check finder pattern: B(1):W(1):B(3):W(1):B(1)
          if (!color && states[0] > 0) {
            var total = states[0] + states[1] + states[2] + states[3] + states[4];
            var mod = total / 7;  // each of 7 modules
            if (mod >= 1.5) {
              var ok = true;
              var expected = [1, 1, 3, 1, 1];
              // ±100% tolerance like jsQR — center row has a white dot that
              // breaks the 3-module bar, but wide tolerance accepts it.
              for (var si = 0; si < 5 && ok; si++) {
                ok = Math.abs(states[si] - mod * expected[si]) < mod * expected[si];
              }
              if (ok) {
                // Segment: from runStart to x - curRun (end of 5th run)
                var segEnd = x - curRun;
                var segStart = segEnd - states[4] - states[3] - states[2] - states[1] - states[0];
                if (segStart >= 0 && segEnd <= width) {
                  tryMergeFinder(segStart, segEnd, y, mod);
                }
              }
            }
          }

          prevColor = color;
          runStart = x;
        }
      }
    }

    function tryMergeFinder(sx, ex, y, mod) {
      for (var i = 0; i < finderCandidates.length; i++) {
        var fc = finderCandidates[i];
        // Same row: skip
        if (fc.bottom.y === y) continue;

        // Vertical gap must be small (finder is only ~14 modules tall)
        var maxGap = mod * 14;  // finder height in pixels
        if (y - fc.bottom.y > maxGap) continue;

        // Overlap check
        var overlap = sx <= fc.bottom.ex && ex >= fc.bottom.sx;
        if (!overlap && Math.abs(sx - fc.bottom.sx) < mod * 3 && Math.abs(ex - fc.bottom.ex) < mod * 3) {
          overlap = true;
        }
        if (!overlap) continue;

        // Module size tolerance
        if (Math.abs(mod - fc.moduleSize) / fc.moduleSize > 0.5) continue;

        // Extend this candidate downward
        fc.bottom = { sx: sx, ex: ex, y: y };
        return;
      }
      // No match, start new candidate
      finderCandidates.push({
        top: { sx: sx, ex: ex, y: y },
        bottom: { sx: sx, ex: ex, y: y },
        moduleSize: mod
      });
    }

    // Filter: must span 2+ rows, must not be taller than a real finder
    finderCandidates = finderCandidates.filter(function(fc) {
      var h = fc.bottom.y - fc.top.y;
      return h >= 1 && h <= fc.moduleSize * 10;
    });
    if (finderCandidates.length < 3) return null;

    // Compute center for each candidate
    for (var i = 0; i < finderCandidates.length; i++) {
      var fc = finderCandidates[i];
      // Center X: walk inward from estimated position
      var cx = Math.round((fc.top.sx + fc.bottom.ex) / 2);
      var cy = Math.round((fc.top.y + fc.bottom.y) / 2);
      // Refine: walk left until white, right until white, take midpoint
      var left = cx, right = cx;
      while (left > 0 && isBlack(left - 1, cy)) left--;
      while (right < width - 1 && isBlack(right + 1, cy)) right++;
      cx = (left + right) / 2;
      // Refine vertically
      var up = cy, down = cy;
      while (up > 0 && isBlack(cx, up - 1)) up--;
      while (down < imgH - 1 && isBlack(cx, down + 1)) down++;
      cy = (up + down) / 2;
      fc.cx = cx; fc.cy = cy;
    }

    // Score candidates by checking ratio in cross directions (like jsQR)
    function scoreCandidate(fc) {
      var cx = fc.cx, cy = fc.cy, mod = fc.moduleSize;
      var err = 0;
      // Check horizontal cross-section
      for (var m = 0; m < 7; m++) {
        var expected = (m===0||m===6)?1:(m===1||m===5)?0:(m===2||m===4)?1:0;
        var sx = cx - 3.5*mod + (m+0.5)*mod;
        var val = isBlack(Math.round(sx), Math.round(cy));
        err += Math.abs(val - expected);
      }
      // Check vertical cross-section
      for (var m = 0; m < 7; m++) {
        var expected = (m===0||m===6)?1:(m===1||m===5)?0:(m===2||m===4)?1:0;
        var sy = cy - 3.5*mod + (m+0.5)*mod;
        var val = isBlack(Math.round(cx), Math.round(sy));
        err += Math.abs(val - expected);
      }
      return err;  // lower = better
    }

    // Score and sort (lowest error first)
    finderCandidates.forEach(function(fc) { fc._score = scoreCandidate(fc); });
    finderCandidates.sort(function(a, b) { return a._score - b._score; });

    // Take top candidates (at most 30)
    var top = finderCandidates.slice(0, 30);
    if (top.length < 3) return null;

    // Try all triples, find the best L-shape
    var results = [];
    for (var a = 0; a < top.length; a++) {
      for (var b = a + 1; b < top.length; b++) {
        for (var c = b + 1; c < top.length; c++) {
          // Sort by position: tl (smallest x+y), br (largest), then determine tr and bl
          var pts = [top[a], top[b], top[c]];
          pts.sort(function(p, q) { return (p.cx + p.cy) - (q.cx + q.cy); });
          var tl = pts[0], tr, bl;
          if (pts[1].cx > pts[2].cx) { tr = pts[1]; bl = pts[2]; }
          else { tr = pts[2]; bl = pts[1]; }

          // Verify spatial relationship
          var dx = tr.cx - tl.cx, dy = bl.cy - tl.cy;
          if (dx < 10 || dy < 10) continue;
          if (Math.abs(tr.cy - tl.cy) > dx * 0.2) continue;
          if (Math.abs(bl.cx - tl.cx) > dy * 0.2) continue;

          // Compute grid size from average module size
          var modAvg = (tl.moduleSize + tr.moduleSize + bl.moduleSize) / 3;
          var hCells = Math.round(dx / modAvg);
          var vCells = Math.round(dy / modAvg);
          if (hCells < 20 || vCells < 20 || Math.abs(hCells - vCells) > 20) continue;

          var gs = Math.round((hCells + vCells) / 2) + FINDER;
          var ox = tl.cx - (FINDER / 2) * modAvg;
          var oy = tl.cy - (FINDER / 2) * modAvg;

          // Snap origin to nearest cell boundary
          ox = Math.round(ox / modAvg) * modAvg;
          oy = Math.round(oy / modAvg) * modAvg;

          results.push({ x: ox, y: oy, cellPx: Math.round(modAvg), gridSize: gs });
        }
      }
    }

    return results.length > 0 ? results : null;
  }

  // === DECODE ===

  function decode(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);
    var grids = locateGrid(pixels, width, height);
    if (!grids) return null;
    if (!Array.isArray(grids)) grids = [grids];

    for (var gi = 0; gi < Math.min(grids.length, 30); gi++) {
      var g = grids[gi];
      if (!g || !g.gridSize || g.gridSize < 30) continue;
      var r = decodeRegion(pixels, width, imgH, g);
      if (r && r.length >= 20) {
        var dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
        if (dv.getUint16(0, false) === 0x4F42 &&
            dv.getUint16(14, false) > 0 && dv.getUint16(14, false) <= 20) {
          return r;
        }
      }
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
    for (var row = 0; row < dataSide && bi < totalBits; row++)
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
    return result;
  }

  return { render, decode, locateGrid, gridSizeForBytes, dataCells };
})();
