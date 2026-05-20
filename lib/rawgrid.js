// RawGrid v4 — fixed 100×100 grid with dual QR-style finders + timing patterns
// Two 7×7 finders at TL(0,0) and BR(93,93), each with 1px white border toward interior.
// Row 0 and col 0 carry alternating B/W timing patterns between the finder regions.
// Screen-capture only — no perspective correction needed.
const RawGrid = (() => {
  const FINDER = 7;
  const BORDER = 1;
  const RESERVED = FINDER + BORDER;  // 8
  const GRID_SIZE = 100;
  const DATA_BYTES = 1213;           // 9704/8 = (10000 - 128 - 168) / 8
  const DATA_BITS = DATA_BYTES * 8;  // 9704

  var _lastDebug = null;

  // QR-style finder pattern: 1:1:3:1:1 B:W:BBB:W:B, 3×3 black center, 7×7 total
  const FINDER_PAT = [
    1,1,1,1,1,1,1,
    1,0,0,0,0,0,1,
    1,0,1,1,1,0,1,
    1,0,1,1,1,0,1,
    1,0,1,1,1,0,1,
    1,0,0,0,0,0,1,
    1,1,1,1,1,1,1
  ];

  function dataCells() { return DATA_BYTES; }

  // === RENDER ===

  function render(data, cellPx, existingCanvas) {
    cellPx = cellPx || 6;
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var totalPx = GRID_SIZE * cellPx;
    var c = existingCanvas || document.createElement('canvas');
    c.width = totalPx; c.height = totalPx;
    var ctx = c.getContext('2d');

    // Fill white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalPx, totalPx);

    // Draw TL finder at (0,0)
    ctx.fillStyle = '#000000';
    for (var i = 0; i < 49; i++) {
      if (FINDER_PAT[i]) {
        var fx = i % 7, fy = Math.floor(i / 7);
        ctx.fillRect(fx * cellPx, fy * cellPx, cellPx, cellPx);
      }
    }

    // Draw BR finder at (93,93)
    var brOx = GRID_SIZE - FINDER;  // 93
    var brOy = GRID_SIZE - FINDER;  // 93
    for (var i = 0; i < 49; i++) {
      if (FINDER_PAT[i]) {
        var fx = i % 7, fy = Math.floor(i / 7);
        ctx.fillRect((brOx + fx) * cellPx, (brOy + fy) * cellPx, cellPx, cellPx);
      }
    }

    // Timing patterns: alternating B/W starting with BLACK next to TL finder border
    // H-timing: row 0, cols 8..91
    for (var col = RESERVED; col < GRID_SIZE - RESERVED; col++) {
      if ((col - RESERVED) % 2 === 0) {
        ctx.fillRect(col * cellPx, 0, cellPx, cellPx);
      }
    }
    // V-timing: col 0, rows 8..91
    for (var row = RESERVED; row < GRID_SIZE - RESERVED; row++) {
      if ((row - RESERVED) % 2 === 0) {
        ctx.fillRect(0, row * cellPx, cellPx, cellPx);
      }
    }

    // Data cells: top-to-bottom, left-to-right, skipping reserved + timing
    ctx.fillStyle = '#000000';
    var bi = 0;
    for (var row = 0; row < GRID_SIZE && bi < DATA_BITS; row++) {
      for (var col = 0; col < GRID_SIZE && bi < DATA_BITS; col++) {
        if (isReserved(row, col)) continue;
        if ((bytes[bi >> 3] >> (7 - (bi & 7))) & 1) {
          ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);
        }
        bi++;
      }
    }

    return c;
  }

  function isReserved(row, col) {
    // TL reserved: 8×8
    if (row < RESERVED && col < RESERVED) return true;
    // BR reserved: 8×8 at bottom-right (rows 92-99, cols 92-99)
    if (row >= GRID_SIZE - RESERVED && col >= GRID_SIZE - RESERVED) return true;
    // H-timing: row 0, cols 8..91
    if (row === 0 && col >= RESERVED && col < GRID_SIZE - RESERVED) return true;
    // V-timing: col 0, rows 8..91
    if (col === 0 && row >= RESERVED && row < GRID_SIZE - RESERVED) return true;
    return false;
  }

  // === DECODE ===

  function getPixel(pixels, width, imgH, x, y) {
    if (x < 0 || x >= width || y < 0 || y >= imgH) return 0;
    var pi = (y * width + x) * 4;
    if (pi + 2 >= pixels.length) return 0;
    return pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
  }

  function isBlack(lum) { return lum < 128 ? 1 : 0; }

  // Scan a 1D line for QR finder pattern (1:1:3:1:1) with module uniformity check.
  // getColor(i) returns 0 (light) or 1 (dark) at position i along the line.
  // Returns an array of { center, moduleSize, start, end } (empty if none).
  function scanLine(getColor, length) {
    var matches = [];
    var states = [0, 0, 0, 0, 0];
    var curRun = 1;
    var prevColor = getColor(0);

    for (var i = 1; i <= length; i++) {
      var color = (i < length) ? getColor(i) : (1 - prevColor);
      if (color === prevColor) {
        curRun++;
      } else {
        states.shift();
        states.push(curRun);

        // Check: just transitioned from dark to light, and we have 5 complete runs
        if (!color && states[0] > 0) {
          var total = states[0] + states[1] + states[2] + states[3] + states[4];
          var mod = total / 7;
          if (mod >= 3) {
            // Module uniformity: max - min ≤ 1 pixel
            var s0 = states[0], s1 = states[1], s2 = states[2] / 3, s3 = states[3], s4 = states[4];
            var maxS = Math.max(s0, s1, s2, s3, s4);
            var minS = Math.min(s0, s1, s2, s3, s4);
            if (maxS - minS <= 1) {
              var end = i;
              var start = end - total;
              matches.push({ center: (start + end) / 2, moduleSize: mod, start: start, end: end });
            }
          }
        }

        curRun = 1;
        prevColor = color;
      }
    }
    return matches;
  }

  // Locate the two QR-style finder patterns, return { tl: {cx,cy}, br: {cx,cy} } or null.
  function locateFinders(pixels, width, imgH) {
    _lastDebug = { rowHits: 0, candidates: 0, finderCount: 0, tl: null, br: null,
                    msX: null, msY: null, originX: null, originY: null, threshold: null, error: null };

    // Step 1: Horizontal scan — collect all 1:1:3:1:1 row matches
    var rowHits = [];
    for (var y = 0; y < imgH; y++) {
      var matches = scanLine(
        (function(rowY) { return function(x) { return isBlack(getPixel(pixels, width, imgH, x, rowY)); }; })(y),
        width
      );
      for (var m = 0; m < matches.length; m++) {
        var mh = matches[m];
        rowHits.push({ y: y, cx: mh.center, sx: mh.start, ex: mh.end, moduleSize: mh.moduleSize });
      }
    }
    _lastDebug.rowHits = rowHits.length;

    // Step 2: Consecutive rows (gap ≤ 2px) with x overlap → candidates
    var candidates = [];
    for (var i = 1; i < rowHits.length; i++) {
      var a = rowHits[i - 1], b = rowHits[i];
      if (b.y - a.y > 2) continue;
      if (a.sx > b.ex || b.sx > a.ex) continue;
      if (Math.abs(a.moduleSize - b.moduleSize) / Math.min(a.moduleSize, b.moduleSize) > 0.3) continue;
      candidates.push({
        cx: (a.cx + b.cx) / 2,
        cy: (a.y + b.y) / 2,
        moduleSize: (a.moduleSize + b.moduleSize) / 2
      });
      i++; // skip to next pair
    }
    _lastDebug.candidates = candidates.length;

    // Debug: all candidates before vertical validation
    _lastDebug.candCoords = candidates.map(function(c) { return { cx: c.cx, cy: c.cy }; });

    // Step 3: Vertical cross-validation at candidate center
    var finders = [];
    for (var ci = 0; ci < candidates.length; ci++) {
      var c = candidates[ci];
      var col = Math.round(c.cx);
      if (col < 0 || col >= width) continue;

      var vMatches = scanLine(
        (function(fixCol) { return function(y) { return isBlack(getPixel(pixels, width, imgH, fixCol, y)); }; })(col),
        imgH
      );
      // Find the vertical match closest to the candidate's cy
      var best = null, bestDist = Infinity;
      for (var vm = 0; vm < vMatches.length; vm++) {
        var dist = Math.abs(vMatches[vm].center - c.cy);
        if (dist < c.moduleSize * 3 && dist < bestDist) {
          best = vMatches[vm];
          bestDist = dist;
        }
      }
      if (best) {
        finders.push({
          cx: c.cx,
          cy: best.center,
          moduleSize: (c.moduleSize + best.moduleSize) / 2
        });
      }
    }

    // Debug: all candidates before dedup (step 3 results)
    _lastDebug.preMerge = finders.map(function(f) { return { cx: f.cx, cy: f.cy }; });

    // Step 4: Deduplicate — merge finders within 3×moduleSize distance
    var merged = [];
    for (var fi = 0; fi < finders.length; fi++) {
      var dup = false;
      for (var mj = 0; mj < merged.length; mj++) {
        var dx = finders[fi].cx - merged[mj].cx;
        var dy = finders[fi].cy - merged[mj].cy;
        if (Math.sqrt(dx * dx + dy * dy) < finders[fi].moduleSize * 3) {
          merged[mj].cx = (merged[mj].cx + finders[fi].cx) / 2;
          merged[mj].cy = (merged[mj].cy + finders[fi].cy) / 2;
          merged[mj].moduleSize = (merged[mj].moduleSize + finders[fi].moduleSize) / 2;
          dup = true;
          break;
        }
      }
      if (!dup) merged.push({ cx: finders[fi].cx, cy: finders[fi].cy, moduleSize: finders[fi].moduleSize });
    }
    finders = merged;
    _lastDebug.finderCount = finders.length;

    // Debug: top 10 by smallest/largest cx
    var byCx = finders.slice().sort(function(a, b) { return a.cx - b.cx; });
    _lastDebug.topLeft10 = byCx.slice(0, 10).map(function(f) { return { cx: f.cx, cy: f.cy }; });
    _lastDebug.topRight10 = byCx.slice(-10).reverse().map(function(f) { return { cx: f.cx, cy: f.cy }; });

    // Step 5: Pick TL (smallest cx+cy) and BR (largest cx+cy)
    if (finders.length < 2) {
      _lastDebug.error = 'too few finders: ' + finders.length;
      return null;
    }

    finders.sort(function(a, b) { return (a.cx + a.cy) - (b.cx + b.cy); });
    var tl = finders[0], br = finders[finders.length - 1];

    var dx = br.cx - tl.cx, dy = br.cy - tl.cy;
    if (dx <= 15 || dy <= 15) {
      _lastDebug.error = 'finders too close: dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1);
      return null;
    }
    if (Math.abs(dx - dy) > dx * 0.3) {
      _lastDebug.error = 'not diagonal: dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1);
      return null;
    }

    _lastDebug.tl = { cx: tl.cx, cy: tl.cy };
    _lastDebug.br = { cx: br.cx, cy: br.cy };
    return { tl: { cx: tl.cx, cy: tl.cy }, br: { cx: br.cx, cy: br.cy } };
  }

  // Single-point sampling with precomputed pixel offset table
  // Inner FEC corrects occasional bit errors, so 5-point majority voting is unnecessary
  function sampleCells(pixels, width, imgH, grid, threshold) {
    var ox = grid.originX, oy = grid.originY, msX = grid.msX, msY = grid.msY;
    var result = new Uint8Array(DATA_BYTES);

    // Build piTable: precompute pixel buffer offset for every data cell center
    var piTable = new Uint32Array(DATA_BITS);
    var bi = 0;
    for (var row = 0; row < GRID_SIZE && bi < DATA_BITS; row++) {
      for (var col = 0; col < GRID_SIZE && bi < DATA_BITS; col++) {
        if (isReserved(row, col)) continue;
        var px = Math.round(ox + (col + 0.5) * msX);
        var py = Math.round(oy + (row + 0.5) * msY);
        piTable[bi] = (py * width + px) * 4;
        bi++;
      }
    }

    // Sample: inline luminance comparison at precomputed pixel offset
    for (var i = 0; i < DATA_BITS; i++) {
      var pi = piTable[i];
      var lum = pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
      if (lum < threshold) result[i >> 3] |= (1 << (7 - (i & 7)));
    }
    return result;
  }

  function computeThreshold(pixels, width, imgH, pair, msX, msY) {
    var tlBlack = getPixel(pixels, width, imgH, Math.round(pair.tl.cx), Math.round(pair.tl.cy));
    var tlWhite = getPixel(pixels, width, imgH, Math.round(pair.tl.cx - 2 * msX), Math.round(pair.tl.cy));
    var brBlack = getPixel(pixels, width, imgH, Math.round(pair.br.cx), Math.round(pair.br.cy));
    var brWhite = getPixel(pixels, width, imgH, Math.round(pair.br.cx + 2 * msX), Math.round(pair.br.cy));
    return ((tlBlack + tlWhite) / 2 + (brBlack + brWhite) / 2) / 2;
  }

  function decode(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);

    // Step 1: Locate finders
    var pair = locateFinders(pixels, width, imgH);
    if (!pair) return null;

    // Step 2: Compute grid geometry
    var msX = (pair.br.cx - pair.tl.cx) / 93;
    var msY = (pair.br.cy - pair.tl.cy) / 93;

    _lastDebug.msX = msX;
    _lastDebug.msY = msY;

    // Cell size constraint
    if (msX < 3 || msY < 3) {
      _lastDebug.error = 'cell too small: msX=' + msX.toFixed(1) + ' msY=' + msY.toFixed(1);
      return null;
    }

    var ox = pair.tl.cx - 3.5 * msX;
    var oy = pair.tl.cy - 3.5 * msY;
    _lastDebug.originX = ox;
    _lastDebug.originY = oy;

    // Step 3: Dynamic threshold from finder black/white modules
    var thresh = computeThreshold(pixels, width, imgH, pair, msX, msY);
    _lastDebug.threshold = thresh;

    // Step 4: Sample cells
    var grid = { originX: ox, originY: oy, msX: msX, msY: msY };
    var result = sampleCells(pixels, width, imgH, grid, thresh);

    // Step 5: Return decode result — inner FEC handles error correction and validation
    return result;
  }

  function getLastDebug() { return _lastDebug; }

  return { render, decode, locateFinders, dataCells, getLastDebug };
})();
