// C4Grid — 4-value per channel (0, 85, 170, 255) on 100×100 grid.
// Finder + timing patterns are black/white; data cells use 64-color palette.
// Capacity: 9704 data cells × 6 bits = 58224 bits = 7278 bytes.
const C4Grid = (() => {
  const FINDER = 7;
  const BORDER = 1;
  const RESERVED = FINDER + BORDER;  // 8
  const GRID_SIZE = 100;
  const DATA_CELLS = 9704;           // 10000 - 128 - 168
  const DATA_BYTES = 7278;           // DATA_CELLS × 6 / 8

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

  function dataCells() { return DATA_BYTES; }

  // === RENDER ===

  function render(data, cellPx, existingCanvas) {
    cellPx = cellPx || 6;
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var totalPx = GRID_SIZE * cellPx;
    var c = existingCanvas || document.createElement('canvas');
    c.width = totalPx; c.height = totalPx;
    var ctx = c.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalPx, totalPx);

    // TL finder at (0,0)
    ctx.fillStyle = '#000000';
    for (var i = 0; i < 49; i++) {
      if (FINDER_PAT[i]) {
        var fx = i % 7, fy = Math.floor(i / 7);
        ctx.fillRect(fx * cellPx, fy * cellPx, cellPx, cellPx);
      }
    }

    // BR finder at (93,93)
    var brOx = GRID_SIZE - FINDER;
    var brOy = GRID_SIZE - FINDER;
    for (var i = 0; i < 49; i++) {
      if (FINDER_PAT[i]) {
        var fx = i % 7, fy = Math.floor(i / 7);
        ctx.fillRect((brOx + fx) * cellPx, (brOy + fy) * cellPx, cellPx, cellPx);
      }
    }

    // Timing patterns
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

    // Data cells: write raw pixels via ImageData to avoid color management
    // Layout: R_hi[0] R_lo[1213] G_hi[2426] G_lo[3639] B_hi[4852] B_lo[6065]
    var imgData = ctx.getImageData(0, 0, totalPx, totalPx);
    var pxData = imgData.data;
    // Precompute 64 color values: pairs are (rHi,rLo) (gHi,gLo) (bHi,bLo)
    // ci bits: [5:rHi][4:gHi][3:bHi][2:rLo][1:gLo][0:bLo]
    var pal = [];
    for (var ci = 0; ci < 64; ci++) {
      var rv = (((ci >> 5) & 1) * 2 + ((ci >> 2) & 1)) * 85;
      var gv = (((ci >> 4) & 1) * 2 + ((ci >> 1) & 1)) * 85;
      var bv = (((ci >> 3) & 1) * 2 + (ci & 1)) * 85;
      pal[ci] = [rv, gv, bv];
    }
    var bi = 0;
    for (var row = 0; row < GRID_SIZE && bi < DATA_CELLS; row++) {
      for (var col = 0; col < GRID_SIZE && bi < DATA_CELLS; col++) {
        if (isReserved(row, col)) continue;

        var byi = bi >> 3, bit = 7 - (bi & 7);
        var rHi = (bytes[byi] >> bit) & 1;
        var rLo = (bytes[1213 + byi] >> bit) & 1;
        var gHi = (bytes[2426 + byi] >> bit) & 1;
        var gLo = (bytes[3639 + byi] >> bit) & 1;
        var bHi = (bytes[4852 + byi] >> bit) & 1;
        var bLo = (bytes[6065 + byi] >> bit) & 1;
        var ci = (rHi << 5) | (gHi << 4) | (bHi << 3) | (rLo << 2) | (gLo << 1) | bLo;
        var rgb = pal[ci];
        var x0 = col * cellPx, y0 = row * cellPx;
        for (var dy = 0; dy < cellPx; dy++) {
          var rowOff = (y0 + dy) * totalPx * 4;
          for (var dx = 0; dx < cellPx; dx++) {
            var off = rowOff + (x0 + dx) * 4;
            pxData[off]     = rgb[0];
            pxData[off + 1] = rgb[1];
            pxData[off + 2] = rgb[2];
            pxData[off + 3] = 255;
          }
        }
        bi++;
      }
    }
    ctx.putImageData(imgData, 0, 0);

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

    var rowHits = [];
    for (var y = 0; y < imgH; y++) {
      var rowY = y;
      var matches = scanLine(
        function(x) {
          var pi = (rowY * width + x) * 4;
          if (pi + 2 >= pixels.length) return 0;
          var lum = pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
          return lum < 128 ? 1 : 0;
        },
        width
      );
      for (var m = 0; m < matches.length; m++) {
        var mh = matches[m];
        rowHits.push({ y: y, cx: mh.center, sx: mh.start, ex: mh.end, moduleSize: mh.moduleSize });
      }
    }
    _lastDebug.rowHits = rowHits.length;

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

    var finders = [];
    for (var ci = 0; ci < candidates.length; ci++) {
      var c = candidates[ci];
      var col = Math.round(c.cx);
      if (col < 0 || col >= width) continue;

      var fixCol = col;
      var vMatches = scanLine(
        function(y) {
          var pi = (y * width + fixCol) * 4;
          if (pi + 2 >= pixels.length) return 0;
          var lum = pixels[pi] * 0.299 + pixels[pi + 1] * 0.587 + pixels[pi + 2] * 0.114;
          return lum < 128 ? 1 : 0;
        },
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

    // Fixed thresholds between 4 levels: 0, 85, 170, 255
    var th1R = 42, th2R = 128, th3R = 213;
    var th1G = 42, th2G = 128, th3G = 213;
    var th1B = 42, th2B = 128, th3B = 213;

    _lastDebug.threshR = th2R; _lastDebug.threshG = th2G; _lastDebug.threshB = th2B;

    // Build piTable
    var piTable = new Uint32Array(DATA_CELLS);
    var bi = 0;
    for (var row = 0; row < GRID_SIZE && bi < DATA_CELLS; row++) {
      for (var col = 0; col < GRID_SIZE && bi < DATA_CELLS; col++) {
        if (isReserved(row, col)) continue;
        var px = Math.round(ox + (col + 0.5) * msX);
        var py = Math.round(oy + (row + 0.5) * msY);
        piTable[bi] = (py * width + px) * 4;
        bi++;
      }
    }

    // Sample cells: 3-threshold quantization per channel
    var result = new Uint8Array(DATA_BYTES);
    var rDev = new Uint32Array(32), gDev = new Uint32Array(32), bDev = new Uint32Array(32);
    for (var i = 0; i < DATA_CELLS; i++) {
      var pi = piTable[i];
      var byi = i >> 3, bit = 1 << (7 - (i & 7));
      var rVal = pixels[pi], gVal = pixels[pi+1], bVal = pixels[pi+2];

      // Quantize to 4 levels
      var rBin = rVal < th1R ? 0 : rVal < th2R ? 1 : rVal < th3R ? 2 : 3;
      var gBin = gVal < th1G ? 0 : gVal < th2G ? 1 : gVal < th3G ? 2 : 3;
      var bBin = bVal < th1B ? 0 : bVal < th2B ? 1 : bVal < th3B ? 2 : 3;

      var rHi = (rBin >> 1) & 1;
      var gHi = (gBin >> 1) & 1;
      var bHi = (bBin >> 1) & 1;
      var rLo = rBin & 1;
      var gLo = gBin & 1;
      var bLo = bBin & 1;

      if (rHi) result[byi]         |= bit;
      if (rLo) result[1213 + byi]  |= bit;
      if (gHi) result[2426 + byi]  |= bit;
      if (gLo) result[3639 + byi]  |= bit;
      if (bHi) result[4852 + byi]  |= bit;
      if (bLo) result[6065 + byi]  |= bit;

      // Deviation from expected value
      var rIdeal = rBin * 85, gIdeal = gBin * 85, bIdeal = bBin * 85;
      rDev[Math.abs(rVal - rIdeal) >> 3]++;
      gDev[Math.abs(gVal - gIdeal) >> 3]++;
      bDev[Math.abs(bVal - bIdeal) >> 3]++;
    }
    return { data: result, channelDev: { r: rDev, g: gDev, b: bDev } };
  }

  function getLastDebug() { return _lastDebug; }

  return { render, decode, locateFinders, dataCells, getLastDebug };
})();
