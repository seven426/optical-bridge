// Node.js smoke test for RawGrid decoder — constructs RGBA pixel data manually
// Usage: node tests/test-rawgrid-node.js
'use strict';

var fs = require('fs');
var code = fs.readFileSync('lib/rawgrid.js', 'utf8');

// The rawgrid.js code uses browser globals. Provide node-compatible shims.
globalThis.window = globalThis;
globalThis.document = null; // not used by decoder, only by render()
globalThis.Uint8ClampedArray = Uint8Array; // shim

// Evaluate the code; replace `const RawGrid =` with a global assignment
var wrapped = code.replace('const RawGrid =', 'globalThis.RawGrid =');
eval(wrapped);

// Now run tests
var passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS: ' + msg); }
  else { failed++; console.log('FAIL: ' + msg); }
}

function makePixels(w, h) {
  return new Uint8Array(w * h * 4);
}

function fill(p, stride, color) {
  for (var i = 0; i < p.length; i += 4) {
    p[i] = color[0]; p[i+1] = color[1]; p[i+2] = color[2]; p[i+3] = 255;
  }
}

function drawRect(p, stride, x, y, w, h, r, g, b) {
  for (var dy = y; dy < y + h; dy++) {
    for (var dx = x; dx < x + w; dx++) {
      var pi = (dy * stride + dx) * 4;
      p[pi] = r; p[pi+1] = g; p[pi+2] = b; p[pi+3] = 255;
    }
  }
}

var FINDER_PAT = [
  1,1,1,1,1,1,1,
  1,0,0,0,0,0,1,
  1,0,1,1,1,0,1,
  1,0,1,1,1,0,1,
  1,0,1,1,1,0,1,
  1,0,0,0,0,0,1,
  1,1,1,1,1,1,1
];

function drawFinder(p, stride, ox, oy, cellPx) {
  for (var i = 0; i < 49; i++) {
    if (FINDER_PAT[i]) {
      var fx = i % 7, fy = Math.floor(i / 7);
      drawRect(p, stride, (ox + fx) * cellPx, (oy + fy) * cellPx, cellPx, cellPx, 0, 0, 0);
    }
  }
}

// ========================
// Test 1: locateFinders on clean grid
// ========================
console.log('=== Test 1: locateFinders on clean synthetic grid ===');
var cellPx = 4, w = 400, h = 400;
var p = makePixels(w, h);
fill(p, w, [255, 255, 255]); // white bg
drawFinder(p, w, 0, 0, cellPx);
drawFinder(p, w, 93, 93, cellPx);

var pair = RawGrid.locateFinders(p, w, h);
assert(pair !== null, 'locateFinders returns non-null');

if (pair) {
  // TL finder center: cell (3,3) → pixel (3.5*4, 3.5*4) = (14, 14)
  // BR finder center: cell (96,96) → pixel (96.5*4, 96.5*4) = (386, 386)
  var tlExpected = 3.5 * cellPx; // 14
  var brExpected = 96.5 * cellPx; // 386
  assert(Math.abs(pair.tl.cx - tlExpected) < 3, 'TL cx ~ ' + tlExpected);
  assert(Math.abs(pair.tl.cy - tlExpected) < 3, 'TL cy ~ ' + tlExpected);
  assert(Math.abs(pair.br.cx - brExpected) < 3, 'BR cx ~ ' + brExpected);
  assert(Math.abs(pair.br.cy - brExpected) < 3, 'BR cy ~ ' + brExpected);
  console.log('  TL: (' + pair.tl.cx.toFixed(1) + ', ' + pair.tl.cy.toFixed(1) + ')');
  console.log('  BR: (' + pair.br.cx.toFixed(1) + ', ' + pair.br.cy.toFixed(1) + ')');
}

// ========================
// Test 2: Full encode (manual) + decode roundtrip
// ========================
console.log('\n=== Test 2: Manual encode + decode roundtrip ===');
var p2 = makePixels(w, h);
fill(p2, w, [255, 255, 255]);

drawFinder(p2, w, 0, 0, cellPx);
drawFinder(p2, w, 93, 93, cellPx);

// Timing patterns
var RES = 8;
for (var col = RES; col < 100 - RES; col++) {
  if ((col - RES) % 2 === 0) drawRect(p2, w, col * cellPx, 0, cellPx, cellPx, 0, 0, 0);
}
for (var row = RES; row < 100 - RES; row++) {
  if ((row - RES) % 2 === 0) drawRect(p2, w, 0, row * cellPx, cellPx, cellPx, 0, 0, 0);
}

// Build frame data: 20-byte header + payload
var frame = new Uint8Array(1213);
// Magic 0x4F42
frame[0] = 0x4F; frame[1] = 0x42;
frame[2] = 0; frame[3] = 0;      // fileId
frame[4] = 0; frame[5] = 1;      // frameIdx
frame[6] = 0; frame[7] = 10;     // totalFrames
frame[8] = 0; frame[9] = 0;      // fecGroup
frame[10] = 0; frame[11] = 6;    // fecGroupSize
frame[12] = 0; frame[13] = 20;   // payloadLen
frame[14] = 0; frame[15] = 5;    // fecK
frame[16] = 200; frame[17] = 0; frame[18] = 0; frame[19] = 0; // fileSize LE
// Payload: pseudorandom
for (var i = 20; i < 1213; i++) frame[i] = (i * 37 + 11) & 0xFF;

// Draw data cells (same logic as encoder)
var bi = 0;
for (var row = 0; row < 100 && bi < 9704; row++) {
  for (var col = 0; col < 100 && bi < 9704; col++) {
    if (row < RES && col < RES) continue;
    if (row >= 100 - RES && col >= 100 - RES) continue;
    if (row === 0 && col >= RES && col < 100 - RES) continue;
    if (col === 0 && row >= RES && row < 100 - RES) continue;
    if ((frame[bi >> 3] >> (7 - (bi & 7))) & 1) {
      drawRect(p2, w, col * cellPx, row * cellPx, cellPx, cellPx, 0, 0, 0);
    }
    bi++;
  }
}

var decoded = RawGrid.decode(p2, w, h);
var dbg2 = RawGrid.getLastDebug();
console.log('  Debug:', JSON.stringify(dbg2, function(k,v) { return typeof v === 'number' ? Math.round(v*100)/100 : v; }));
assert(decoded !== null, 'decode returns non-null');

if (decoded) {
  // Verify header
  var dv = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  var magic = dv.getUint16(0, false);
  console.log('  Magic: 0x' + magic.toString(16) + ' decoded[0]=' + decoded[0].toString(16) + ' decoded[1]=' + decoded[1].toString(16));
  console.log('  First 20 bytes expected: ' + Array.from(frame.slice(0,20)).map(function(b){return b.toString(16).padStart(2,'0');}).join(' '));
  console.log('  First 20 bytes decoded:  ' + Array.from(decoded.slice(0,20)).map(function(b){return b.toString(16).padStart(2,'0');}).join(' '));
  assert(magic === 0x4F42, 'magic bytes 0x4F42');

  // Verify full match
  var match = true, firstDiff = -1;
  for (var i = 0; i < frame.length; i++) {
    if (frame[i] !== decoded[i]) { match = false; firstDiff = i; break; }
  }
  assert(match, 'full roundtrip match (' + decoded.length + ' bytes)');
  if (!match) {
    console.log('  first diff at byte[' + firstDiff + ']: expected 0x' + frame[firstDiff].toString(16) + ' got 0x' + decoded[firstDiff].toString(16));
  }
}

// ========================
// Test 3: Different cell sizes
// ========================
console.log('\n=== Test 3: Various cell sizes ===');
var sizes = [4, 5, 6, 7];
for (var s = 0; s < sizes.length; s++) {
  var cp = sizes[s];
  var w3 = 100 * cp, h3 = 100 * cp;
  var p3 = makePixels(w3, h3);
  fill(p3, w3, [255, 255, 255]);
  drawFinder(p3, w3, 0, 0, cp);
  drawFinder(p3, w3, 93, 93, cp);

  // Draw data cells
  var bi3 = 0;
  for (var row = 0; row < 100 && bi3 < 9704; row++) {
    for (var col = 0; col < 100 && bi3 < 9704; col++) {
      if (row < RES && col < RES) continue;
      if (row >= 100 - RES && col >= 100 - RES) continue;
      if (row === 0 && col >= RES && col < 100 - RES) continue;
      if (col === 0 && row >= RES && row < 100 - RES) continue;
      if ((frame[bi3 >> 3] >> (7 - (bi3 & 7))) & 1) {
        drawRect(p3, w3, col * cp, row * cp, cp, cp, 0, 0, 0);
      }
      bi3++;
    }
  }

  var d3 = RawGrid.decode(p3, w3, h3);
  var ok3 = d3 !== null && d3.length === frame.length;
  for (var i = 0; i < frame.length && ok3; i++) {
    if (frame[i] !== d3[i]) ok3 = false;
  }
  assert(ok3, 'cellPx=' + cp + ' roundtrip');
}

// ========================
// Summary
// ========================
console.log('\n=== ' + (failed === 0 ? 'ALL ' + passed + ' TESTS PASSED' : passed + ' passed, ' + failed + ' FAILED') + ' ===');
process.exit(failed > 0 ? 1 : 0);
