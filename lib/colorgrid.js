// ColorGrid — 3-bit RGB color encoding on the same 100×100 grid layout.
// Finder + timing patterns are black/white; data cells use 8-color RGB.
// Capacity: 9704 data cells × 3 bits = 29112 bits = 3639 bytes.
const ColorGrid = (() => {
  const FINDER = 7;
  const BORDER = 1;
  const RESERVED = FINDER + BORDER;  // 8
  const GRID_SIZE = 100;
  const DATA_CELLS = 9704;           // 10000 - 128 - 168
  const DATA_BITS = DATA_CELLS * 3;  // 29112
  const DATA_BYTES = DATA_CELLS * 3 / 8; // 3639

  var _lastDebug = null;

  const FINDER_PAT = [
    1,1,1,1,1,1,1,
    1,0,0,0,0,0,1,
    1,0,1,1,1,0,1,
    1,0,1,1,1,0,1,
    1,0,1,1,1,0,1,
    1,0,0,0,0,0,1,
    1,1,1,1,1,1,1
  ];

  function gridSizeForBytes(_dataLen) { return GRID_SIZE; }
  function dataCells() { return DATA_BYTES; }

  // === RENDER ===

  function render(data, cellPx) {
    cellPx = cellPx || 6;
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var totalPx = GRID_SIZE * cellPx;
    var c = document.createElement('canvas');
    c.width = totalPx; c.height = totalPx;
    var ctx = c.getContext('2d');

    // Fill white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalPx, totalPx);

    // Draw TL finder at (0,0) — black only
    ctx.fillStyle = '#000000';
    for (var i = 0; i < 49; i++) {
      if (FINDER_PAT[i]) {
        var fx = i % 7, fy = Math.floor(i / 7);
        ctx.fillRect(fx * cellPx, fy * cellPx, cellPx, cellPx);
      }
    }

    // Draw BR finder at (93,93) — black only
    var brOx = GRID_SIZE - FINDER;
    var brOy = GRID_SIZE - FINDER;
    for (var i = 0; i < 49; i++) {
      if (FINDER_PAT[i]) {
        var fx = i % 7, fy = Math.floor(i / 7);
        ctx.fillRect((brOx + fx) * cellPx, (brOy + fy) * cellPx, cellPx, cellPx);
      }
    }

    // Timing patterns: alternating B/W — black only
    for (var col = RESERVED; col < GRID_SIZE - RESERVED; col++) {
      if ((col - RESERVED) % 2 === 0) {
        ctx.fillRect(col * cellPx, 0, cellPx, cellPx);
      }
    }
    for (var row = RESERVED; row < GRID_SIZE - RESERVED; row++) {
      if ((row - RESERVED) % 2 === 0) {
        ctx.fillRect(0, row * cellPx, cellPx, cellPx);
      }
    }

    // Data cells: 3 bits per cell → RGB color
    // Channel layout: bytes[0..1212] = R, [1213..2425] = G, [2426..3638] = B
    // Precompute 8 fill styles to avoid per-cell string construction
    var fills = [];
    for (var ci = 0; ci < 8; ci++) {
      fills[ci] = 'rgb(' + ((ci & 4) ? 0 : 255) + ',' + ((ci & 2) ? 0 : 255) + ',' + ((ci & 1) ? 0 : 255) + ')';
    }
    var bi = 0;
    for (var row = 0; row < GRID_SIZE && bi < DATA_CELLS; row++) {
      for (var col = 0; col < GRID_SIZE && bi < DATA_CELLS; col++) {
        if (isReserved(row, col)) continue;

        var rBit = (bytes[bi >> 3] >> (7 - (bi & 7))) & 1;
        var gBit = (bytes[(DATA_BYTES / 3 + (bi >> 3)) | 0] >> (7 - (bi & 7))) & 1;
        var bBit = (bytes[(2 * DATA_BYTES / 3 + (bi >> 3)) | 0] >> (7 - (bi & 7))) & 1;
        var ci = (rBit << 2) | (gBit << 1) | bBit;
        if (ci) { // skip white (background already white)
          ctx.fillStyle = fills[ci];
          ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);
        }
        bi++;
      }
    }

    return c;
  }

  function isReserved(row, col) {
    if (row < RESERVED && col < RESERVED) return true;
    if (row >= GRID_SIZE - RESERVED && col >= GRID_SIZE - RESERVED) return true;
    if (row === 0 && col >= RESERVED && col < GRID_SIZE - RESERVED) return true;
    if (col === 0 && row >= RESERVED && row < GRID_SIZE - RESERVED) return true;
    return false;
  }

  // === DECODE ===

  function getPixel(pixels, width, imgH, x, y) {
    if (x < 0 || x >= width || y < 0 || y >= imgH) return { r: 0, g: 0, b: 0 };
    var pi = (y * width + x) * 4;
    if (pi + 2 >= pixels.length) return { r: 0, g: 0, b: 0 };
    return { r: pixels[pi], g: pixels[pi + 1], b: pixels[pi + 2] };
  }

  function isBlack(lum) { return lum < 128 ? 1 : 0; }

  // Same FSM scanner as RawGrid, for black/white finder detection
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
        if (!color && states[0] > 0) {
          var total = states[0] + states[1] + states[2] + states[3] + states[4];
          var mod = total / 7;
          if (mod >= 3) {
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

  function locateFinders(pixels, width, imgH) {
    _lastDebug = { rowHits: 0, candidates: 0, finderCount: 0, tl: null, br: null,
                    msX: null, msY: null, originX: null, originY: null,
                    threshR: null, threshG: null, threshB: null, error: null };

    // Step 1: Horizontal scan on luma
    var rowHits = [];
    for (var y = 0; y < imgH; y++) {
      var matches = scanLine(
        (function(rowY) { return function(x) { return isBlack(getPixel(pixels, width, imgH, x, rowY).r * 0.299 + getPixel(pixels, width, imgH, x, rowY).g * 0.587 + getPixel(pixels, width, imgH, x, rowY).b * 0.114); }; })(y),
        width
      );
      for (var m = 0; m < matches.length; m++) {
        var mh = matches[m];
        rowHits.push({ y: y, cx: mh.center, sx: mh.start, ex: mh.end, moduleSize: mh.moduleSize });
      }
    }
    _lastDebug.rowHits = rowHits.length;

    // Step 2: Consecutive rows with overlap → candidates
    var candidates = [];
    for (var i = 1; i < rowHits.length; i++) {
      var a = rowHits[i - 1], b = rowHits[i];
      if (b.y - a.y > 2) continue;
      if (a.sx > b.ex || b.sx > a.ex) continue;
      if (Math.abs(a.moduleSize - b.moduleSize) / Math.min(a.moduleSize, b.moduleSize) > 0.3) continue;
      candidates.push({
        cx: (a.cx + b.cx) / 2, cy: (a.y + b.y) / 2,
        moduleSize: (a.moduleSize + b.moduleSize) / 2
      });
      i++;
    }
    _lastDebug.candidates = candidates.length;

    // Step 3: Vertical cross-validation
    var finders = [];
    for (var ci = 0; ci < candidates.length; ci++) {
      var c = candidates[ci];
      var col = Math.round(c.cx);
      if (col < 0 || col >= width) continue;

      var vMatches = scanLine(
        (function(fixCol) { return function(y) { return isBlack(getPixel(pixels, width, imgH, fixCol, y).r * 0.299 + getPixel(pixels, width, imgH, fixCol, y).g * 0.587 + getPixel(pixels, width, imgH, fixCol, y).b * 0.114); }; })(col),
        imgH
      );
      var best = null, bestDist = Infinity;
      for (var vm = 0; vm < vMatches.length; vm++) {
        var dist = Math.abs(vMatches[vm].center - c.cy);
        if (dist < c.moduleSize * 3 && dist < bestDist) { best = vMatches[vm]; bestDist = dist; }
      }
      if (best) {
        finders.push({
          cx: c.cx, cy: best.center,
          moduleSize: (c.moduleSize + best.moduleSize) / 2
        });
      }
    }

    // Step 4: Deduplicate
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
          dup = true; break;
        }
      }
      if (!dup) merged.push({ cx: finders[fi].cx, cy: finders[fi].cy, moduleSize: finders[fi].moduleSize });
    }
    finders = merged;
    _lastDebug.finderCount = finders.length;

    if (finders.length < 2) { _lastDebug.error = 'too few finders: ' + finders.length; return null; }

    finders.sort(function(a, b) { return (a.cx + a.cy) - (b.cx + b.cy); });
    var tl = finders[0], br = finders[finders.length - 1];
    var dx = br.cx - tl.cx, dy = br.cy - tl.cy;
    if (dx <= 15 || dy <= 15) { _lastDebug.error = 'finders too close'; return null; }
    if (Math.abs(dx - dy) > dx * 0.3) { _lastDebug.error = 'not diagonal'; return null; }

    _lastDebug.tl = { cx: tl.cx, cy: tl.cy };
    _lastDebug.br = { cx: br.cx, cy: br.cy };
    return { tl: { cx: tl.cx, cy: tl.cy }, br: { cx: br.cx, cy: br.cy } };
  }

  function decode(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);

    var pair = locateFinders(pixels, width, imgH);
    if (!pair) return null;

    var msX = (pair.br.cx - pair.tl.cx) / 93;
    var msY = (pair.br.cy - pair.tl.cy) / 93;
    _lastDebug.msX = msX; _lastDebug.msY = msY;

    if (msX < 3 || msY < 3) {
      _lastDebug.error = 'cell too small'; return null;
    }

    var ox = pair.tl.cx - 3.5 * msX;
    var oy = pair.tl.cy - 3.5 * msY;
    _lastDebug.originX = ox; _lastDebug.originY = oy;

    // Per-channel thresholds from finder black/white pixels
    var tlCenter = getPixel(pixels, width, imgH, Math.round(pair.tl.cx), Math.round(pair.tl.cy));
    var tlBorder = getPixel(pixels, width, imgH, Math.round(pair.tl.cx - 2 * msX), Math.round(pair.tl.cy));
    var brCenter = getPixel(pixels, width, imgH, Math.round(pair.br.cx), Math.round(pair.br.cy));
    var brBorder = getPixel(pixels, width, imgH, Math.round(pair.br.cx + 2 * msX), Math.round(pair.br.cy));

    var threshR = ((tlCenter.r + tlBorder.r) / 2 + (brCenter.r + brBorder.r) / 2) / 2;
    var threshG = ((tlCenter.g + tlBorder.g) / 2 + (brCenter.g + brBorder.g) / 2) / 2;
    var threshB = ((tlCenter.b + tlBorder.b) / 2 + (brCenter.b + brBorder.b) / 2) / 2;
    _lastDebug.threshR = threshR; _lastDebug.threshG = threshG; _lastDebug.threshB = threshB;

    // Sample cells: center point only, per-channel threshold
    // Inline pixel access to avoid per-cell object allocation
    var result = new Uint8Array(DATA_BYTES);
    var gOff = (DATA_BYTES / 3) | 0;  // 1213
    var bOff = (2 * DATA_BYTES / 3) | 0; // 2426
    var bi = 0;
    for (var row = 0; row < GRID_SIZE && bi < DATA_CELLS; row++) {
      for (var col = 0; col < GRID_SIZE && bi < DATA_CELLS; col++) {
        if (isReserved(row, col)) continue;

        var px = Math.round(ox + (col + 0.5) * msX);
        var py = Math.round(oy + (row + 0.5) * msY);
        var pi = (py * width + px) * 4;

        var byi = bi >> 3;
        var bit = 1 << (7 - (bi & 7));
        if (pixels[pi] < threshR) result[byi] |= bit;
        if (pixels[pi + 1] < threshG) result[gOff + byi] |= bit;
        if (pixels[pi + 2] < threshB) result[bOff + byi] |= bit;

        bi++;
      }
    }
    return result;
  }

  function getLastDebug() { return _lastDebug; }

  return { render, decode, locateFinders, gridSizeForBytes, dataCells, getLastDebug };
})();
