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

  function gridSizeForBytes(_dataLen) { return GRID_SIZE; }
  function dataCells() { return DATA_BYTES; }

  // === RENDER ===

  function render(data, cellPx) {
    cellPx = cellPx || 5;
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var totalPx = GRID_SIZE * cellPx;
    var c = document.createElement('canvas');
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

  // === LOCATE: jsQR-style ratio scanning for dual finders ===

  function locateGrid(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);

    _lastDebug = {
      rawCandidates: 0, crossedCandidates: 0, topCount: 0,
      bestPair: null, originX: null, originY: null,
      msX: null, msY: null, binarizeThreshold: null, hTimingRate: null,
      error: null
    };

    var finderCandidates = scanFinders(pixels, width, imgH);
    _lastDebug.rawCandidates = finderCandidates.length;
    _lastDebug.rawCoords = finderCandidates.map(function(fc) {
      var cx = Math.round((fc.top.sx + fc.bottom.ex) / 2);
      var cy = Math.round((fc.top.y + fc.bottom.y) / 2);
      var h = fc.bottom.y - fc.top.y;
      return 'x=' + cx + ' y=' + cy + ' h=' + h + ' ms=' + fc.moduleSize.toFixed(1);
    });
    if (finderCandidates.length < 2) {
      _lastDebug.error = 'too few finder candidates: ' + finderCandidates.length;
      return null;
    }

    // Refine centers and cross-validate
    finderCandidates = finderCandidates.filter(function(fc) {
      refineCenter(fc, pixels, width, imgH);
      return crossCheck(fc, pixels, width, imgH);
    });
    _lastDebug.crossedCandidates = finderCandidates.length;
    _lastDebug.crossedCoords = finderCandidates.map(function(fc) {
      return 'x=' + fc.cx.toFixed(1) + ' y=' + fc.cy.toFixed(1) + ' ms=' + fc.moduleSize.toFixed(1) + ' s=' + fc._score;
    });
    if (finderCandidates.length < 2) {
      _lastDebug.error = 'too few after crossCheck: ' + finderCandidates.length;
      return null;
    }

    // Score and take top candidates
    finderCandidates.forEach(function(fc) { fc._score = scoreCandidate(fc, pixels, width, imgH); });
    finderCandidates.sort(function(a, b) { return a._score - b._score; });
    var top = finderCandidates.slice(0, 30);
    _lastDebug.topCount = top.length;
    if (top.length < 2) {
      _lastDebug.error = 'too few top candidates: ' + top.length;
      return null;
    }

    // Find best TL+BR pair
    var bestPair = null;
    var bestScore = Infinity;
    for (var a = 0; a < top.length; a++) {
      for (var b = a + 1; b < top.length; b++) {
        var tl, br;
        if (top[a].cx + top[a].cy < top[b].cx + top[b].cy) {
          tl = top[a]; br = top[b];
        } else {
          tl = top[b]; br = top[a];
        }
        var dx = br.cx - tl.cx;
        var dy = br.cy - tl.cy;
        if (dx <= 15 || dy <= 15) continue;
        if (Math.abs(dx - dy) > dx * 0.3) continue;  // expect ~45° diagonal

        var msX = dx / 93;
        var msY = dy / 93;
        if (msX < 1.5 || msX > 20 || msY < 1.5 || msY > 20) continue;

        // Module sizes should roughly agree with finder module sizes
        var avgMs = (tl.moduleSize + br.moduleSize + msX + msY) / 4;
        if (Math.abs(tl.moduleSize - avgMs) / avgMs > 0.5) continue;
        if (Math.abs(br.moduleSize - avgMs) / avgMs > 0.5) continue;

        var score = tl._score + br._score + Math.abs(msX - msY) / avgMs;
        if (score < bestScore) {
          bestScore = score;
          bestPair = { tl: tl, br: br, msX: msX, msY: msY };
        }
      }
    }
    if (!bestPair) {
      _lastDebug.error = 'no valid TL+BR pair found among ' + top.length + ' top candidates';
      return null;
    }

    _lastDebug.bestPair = {
      tlCx: bestPair.tl.cx, tlCy: bestPair.tl.cy, tlMs: bestPair.tl.moduleSize,
      brCx: bestPair.br.cx, brCy: bestPair.br.cy, brMs: bestPair.br.moduleSize,
      msX: bestPair.msX, msY: bestPair.msY
    };

    // Refine module sizes from timing patterns
    var refined = refineWithTiming(bestPair, pixels, width, imgH);
    if (!refined) {
      _lastDebug.error = 'timing pattern validation failed';
      return null;
    }

    _lastDebug.originX = refined.originX;
    _lastDebug.originY = refined.originY;
    _lastDebug.msX = refined.msX;
    _lastDebug.msY = refined.msY;
    _lastDebug.binarizeThreshold = refined.binarizeThreshold;
    _lastDebug.cellPx = refined.cellPx;
    _lastDebug.hTimingRate = refined.hTimingRate;

    return [refined];  // return array for API compatibility
  }

  function scanFinders(pixels, width, imgH) {
    var candidates = [];

    function isBlack(x, y) {
      if (x < 0 || x >= width || y < 0 || y >= imgH) return 0;
      var pi = (y * width + x) * 4;
      if (pi + 2 >= pixels.length) return 0;
      return pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114 < 128 ? 1 : 0;
    }

    for (var y = 0; y < imgH; y++) {
      var states = [0, 0, 0, 0, 0];
      var curRun = 0;
      var prevColor = isBlack(0, y);
      var runStart = 0;

      for (var x = 1; x <= width; x++) {
        var color = (x < width) ? isBlack(x, y) : (prevColor ? 0 : 1);
        curRun++;
        if (color !== prevColor || x === width) {
          states.shift();
          states.push(curRun);
          curRun = 0;
          if (!color && states[0] > 0) {
            var total = states[0] + states[1] + states[2] + states[3] + states[4];
            var mod = total / 7;
            if (mod >= 3) {
              var ok = true;
              var expected = [1, 1, 3, 1, 1];
              for (var si = 0; si < 5 && ok; si++) {
                ok = Math.abs(states[si] - mod * expected[si]) < mod * expected[si] * 0.5;
              }
              if (ok) {
                var segEnd = x - curRun;
                var segStart = segEnd - states[4] - states[3] - states[2] - states[1] - states[0];
                if (segStart >= 0 && segEnd <= width) {
                  tryMergeCandidate(candidates, segStart, segEnd, y, mod);
                }
              }
            }
          }
          prevColor = color;
          runStart = x;
        }
      }
    }

    // Filter: must span 2+ rows and not be too tall
    candidates = candidates.filter(function(fc) {
      var h = fc.bottom.y - fc.top.y;
      return h >= 1 && h <= fc.moduleSize * 10;
    });

    return candidates;
  }

  function tryMergeCandidate(candidates, sx, ex, y, mod) {
    for (var i = 0; i < candidates.length; i++) {
      var fc = candidates[i];
      if (fc.bottom.y === y) continue;
      var maxGap = mod * 14;
      if (y - fc.bottom.y > maxGap) continue;
      var overlap = sx <= fc.bottom.ex && ex >= fc.bottom.sx;
      if (!overlap && Math.abs(sx - fc.bottom.sx) < mod * 3 && Math.abs(ex - fc.bottom.ex) < mod * 3) {
        overlap = true;
      }
      if (!overlap) continue;
      if (Math.abs(mod - fc.moduleSize) / fc.moduleSize > 0.5) continue;
      fc.bottom = { sx: sx, ex: ex, y: y };
      return;
    }
    candidates.push({
      top: { sx: sx, ex: ex, y: y },
      bottom: { sx: sx, ex: ex, y: y },
      moduleSize: mod
    });
  }

  function refineCenter(fc, pixels, width, imgH) {
    function isBlack(x, y) {
      if (x < 0 || x >= width || y < 0 || y >= imgH) return 0;
      var pi = (y * width + x) * 4;
      if (pi + 2 >= pixels.length) return 0;
      return pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114 < 128 ? 1 : 0;
    }
    var cx = Math.round((fc.top.sx + fc.bottom.ex) / 2);
    var cy = Math.round((fc.top.y + fc.bottom.y) / 2);
    var left = cx, right = cx;
    while (left > 0 && isBlack(left - 1, cy)) left--;
    while (right < width - 1 && isBlack(right + 1, cy)) right++;
    cx = (left + right) / 2;
    var up = cy, down = cy;
    while (up > 0 && isBlack(cx, up - 1)) up--;
    while (down < imgH - 1 && isBlack(cx, down + 1)) down++;
    cy = (up + down) / 2;
    fc.cx = cx; fc.cy = cy;
  }

  function crossCheck(fc, pixels, width, imgH) {
    function isBlack(x, y) {
      if (x < 0 || x >= width || y < 0 || y >= imgH) return 0;
      var pi = (y * width + x) * 4;
      if (pi + 2 >= pixels.length) return 0;
      return pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114 < 128 ? 1 : 0;
    }
    var cx = fc.cx, cy = fc.cy, mod = fc.moduleSize;
    var mismatches = 0;
    for (var m = 0; m < 7; m++) {
      // QR finder center row: B:W:BBB:W:B = 1:0:1:1:1:0:1
      var expected = (m === 1 || m === 5) ? 0 : 1;
      var sx = cx - 3.5 * mod + (m + 0.5) * mod;
      if (isBlack(Math.round(sx), Math.round(cy)) !== expected) mismatches++;
      var sy = cy - 3.5 * mod + (m + 0.5) * mod;
      if (isBlack(Math.round(cx), Math.round(sy)) !== expected) mismatches++;
    }
    return mismatches <= 2;
  }

  function scoreCandidate(fc, pixels, width, imgH) {
    function isBlack(x, y) {
      if (x < 0 || x >= width || y < 0 || y >= imgH) return 0;
      var pi = (y * width + x) * 4;
      if (pi + 2 >= pixels.length) return 0;
      return pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114 < 128 ? 1 : 0;
    }
    var cx = fc.cx, cy = fc.cy, mod = fc.moduleSize;
    var err = 0;
    for (var m = 0; m < 7; m++) {
      var expected = (m === 1 || m === 5) ? 0 : 1;
      var sx = cx - 3.5 * mod + (m + 0.5) * mod;
      var val = isBlack(Math.round(sx), Math.round(cy));
      err += Math.abs(val - expected);
      var sy = cy - 3.5 * mod + (m + 0.5) * mod;
      val = isBlack(Math.round(cx), Math.round(sy));
      err += Math.abs(val - expected);
    }
    return err;
  }

  // Refine module sizes using timing patterns
  function refineWithTiming(pair, pixels, width, imgH) {
    function sampleLuma(x, y) {
      var ix = Math.round(x), iy = Math.round(y);
      if (ix < 0 || ix >= width || iy < 0 || iy >= imgH) return 0;
      var pi = (iy * width + ix) * 4;
      if (pi + 2 >= pixels.length) return 0;
      return pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
    }

    // Finder center at module 3 → subtract 3 modules to reach cell (0,0) center
    var ox = pair.tl.cx - 3 * pair.msX;
    var oy = pair.tl.cy - 3 * pair.msY;

    // Compute dynamic binarize threshold from finder black/white modules
    // TL finder: center (3,3) is black, (1,3) is inner white ring
    var tlBlack = sampleLuma(pair.tl.cx, pair.tl.cy);
    var tlWhite = sampleLuma(pair.tl.cx - 2 * pair.msX, pair.tl.cy);
    // BR finder: center is black, (5,3) in local coords is inner white ring
    var brBlack = sampleLuma(pair.br.cx, pair.br.cy);
    var brWhite = sampleLuma(pair.br.cx + 2 * pair.msX, pair.br.cy);
    var thresh = ((tlBlack + tlWhite) / 2 + (brBlack + brWhite) / 2) / 2;

    // Verify H-timing: sample row 0, cols 8..91, check alternating pattern
    var timingLen = GRID_SIZE - 2 * RESERVED;  // 84 cells
    var hTimingOk = 0;
    for (var col = RESERVED; col < GRID_SIZE - RESERVED; col++) {
      var px = ox + col * pair.msX;
      var py = oy;  // row 0
      var lum = sampleLuma(px, py);
      var expectedBlack = (col - RESERVED) % 2 === 0;
      var isBlack = lum < thresh ? 1 : 0;
      if (isBlack === (expectedBlack ? 1 : 0)) hTimingOk++;
    }
    // Require at least 70% timing match
    if (hTimingOk / timingLen < 0.7) return null;

    pair.binarizeThreshold = thresh;
    pair.hTimingRate = hTimingOk / timingLen;

    // Compute origin
    pair.originX = ox;
    pair.originY = oy;
    pair.cellPx = Math.round((pair.msX + pair.msY) / 2);
    pair.gridSize = GRID_SIZE;

    return pair;
  }

  // === DECODE ===

  function decode(pixels, width, height) {
    var imgH = Math.floor(pixels.length / 4 / width);
    var grids = locateGrid(pixels, width, height);
    if (!grids) {
      _lastDebug.decodeError = 'locateGrid returned null';
      return null;
    }

    _lastDebug.decodeTries = 0;
    _lastDebug.decodeBestLen = 0;
    _lastDebug.decodeBestValid = false;
    _lastDebug.decodeBestMagic = null;
    _lastDebug.decodeError = null;

    for (var gi = 0; gi < Math.min(grids.length, 5); gi++) {
      var g = grids[gi];
      if (!g) continue;

      // Try gridSize ±1 and origin ±1 cell to correct estimation errors
      for (var dg = -1; dg <= 1; dg++) {
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            var tryG = {
              originX: g.originX + dx * g.msX,
              originY: g.originY + dy * g.msY,
              msX: g.msX,
              msY: g.msY,
              binarizeThreshold: g.binarizeThreshold,
              gridSize: GRID_SIZE + dg
            };
            _lastDebug.decodeTries++;
            var r = decodeRegion(pixels, width, imgH, tryG);
            if (r && r.length >= 20) {
              if (r.length > _lastDebug.decodeBestLen) {
                _lastDebug.decodeBestLen = r.length;
              }
              var dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
              var m = dv.getUint16(0, false);
              var fk = dv.getUint16(14, false);
              var pl = dv.getUint16(12, false);
              var valid = m === 0x4F42 && fk > 0 && fk <= 20 && pl > 0 && 20 + pl <= r.length;
              if (valid) {
                _lastDebug.decodeBestValid = true;
                _lastDebug.decodeBestLen = r.length;
                return r;
              }
              if (!_lastDebug.decodeBestMagic) {
                _lastDebug.decodeBestMagic = 'm=' + m.toString(16) + ' fk=' + fk + ' pl=' + pl;
              }
            }
          }
        }
      }
    }
    _lastDebug.decodeError = _lastDebug.decodeBestLen > 0
      ? ('best result ' + _lastDebug.decodeBestLen + 'B, magic=' + _lastDebug.decodeBestMagic)
      : 'all decode attempts returned empty/short data';
    return null;
  }

  function decodeRegion(pixels, imgW, imgH, grid) {
    var msX = grid.msX;
    var msY = grid.msY;
    var ox = grid.originX;
    var oy = grid.originY;
    var thresh = grid.binarizeThreshold;

    var result = new Uint8Array(DATA_BYTES);
    var bi = 0;

    for (var row = 0; row < GRID_SIZE && bi < DATA_BITS; row++) {
      for (var col = 0; col < GRID_SIZE && bi < DATA_BITS; col++) {
        if (isReserved(row, col)) continue;

        var px = Math.round(ox + col * msX);
        var py = Math.round(oy + row * msY);

        if (px >= 0 && px < imgW && py >= 0 && py < imgH) {
          var pi = (py * imgW + px) * 4;
          var lum = pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
          if (lum < thresh) {
            result[bi >> 3] |= (1 << (7 - (bi & 7)));
          }
        }
        bi++;
      }
    }
    return result;
  }

  return { render, decode, locateGrid, gridSizeForBytes, dataCells, getLastDebug: function() { return _lastDebug; } };
})();
