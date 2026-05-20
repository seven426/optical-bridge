// Smoke test for ReedSolomon.correctErrors
'use strict';
var fs = require('fs');

// Load GF256 and RS
function loadMod(path, name) {
  var s = fs.readFileSync(path, 'utf8');
  s = s.replace('const ' + name + ' =', 'globalThis.' + name + ' =');
  eval(s);
}
loadMod('lib/gf256.js', 'GF256');
loadMod('lib/reed-solomon.js', 'ReedSolomon');

var gf = GF256;
var rs = ReedSolomon;

var passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else { failed++; console.log('  FAIL: ' + msg); }
}

console.log('=== RS Error Correction Tests ===\n');

// RS(242, 236), t=3 — MUST come first (used by tests below)
var RS_K = 236, RS_NPAR = 6, RS_N = 242;

// Build generator polynomial g(x) = Π(x-α^i) for i=0..5
var gPoly = new Uint8Array(7);
gPoly[0] = 1;
var gDeg = 0;
for (var i = 0; i < 6; i++) {
  var root = gf.pow(2, i);
  gDeg++;
  for (var j = gDeg; j > 0; j--) {
    gPoly[j] = gf.add(gPoly[j - 1], gf.mul(gPoly[j], root));
  }
  gPoly[0] = gf.mul(gPoly[0], root);
}

// --- Test 1: Clean data (no errors) ---
console.log('1. Clean block (no errors)');
var data = new Uint8Array(RS_N);
for (var i = 0; i < RS_N; i++) data[i] = (i * 37 + 11) & 0xFF;

function encodeRS(dataBytes, npar) {
  // Systematic RS: c(x) = d(x)·x^npar + rem(d(x)·x^npar, g(x))
  // Format: [npar parity bytes][k data bytes]
  var k = dataBytes.length;
  var n = k + npar;
  var shift = new Uint8Array(n);
  shift.set(dataBytes, npar);

  for (var i = n - 1; i >= npar; i--) {
    var factor = shift[i];
    if (factor === 0) continue;
    for (var j = 0; j <= npar; j++) {
      shift[i - npar + j] = gf.add(shift[i - npar + j], gf.mul(factor, gPoly[j]));
    }
  }

  var result = new Uint8Array(n);
  result.set(shift.slice(0, npar), 0);
  result.set(dataBytes, npar);
  return result;
}

var cleanEncoded = encodeRS(data.slice(0, RS_K), RS_NPAR);
var result = rs.correctErrors(cleanEncoded, 3);
assert(result !== null, 'returns non-null for clean data');
assert(result.errors === 0, 'reports 0 errors for clean data');

// --- Test 2: Single byte error ---
console.log('2. Single byte error');
var singleErr = new Uint8Array(cleanEncoded);
singleErr[100] ^= 0x55;

result = rs.correctErrors(singleErr, 3);
assert(result !== null, 'corrects single error');
if (result) {
  assert(result.errors === 1, 'reports 1 error');
  var match = true;
  for (var i = 0; i < cleanEncoded.length; i++) {
    if (cleanEncoded[i] !== result.corrected[i]) { match = false; break; }
  }
  assert(match, 'fully corrected back to original');
}

// --- Test 3: Three byte errors (max capacity) ---
console.log('3. Three byte errors (t=3)');
var tripleErr = new Uint8Array(cleanEncoded);
tripleErr[50] ^= 0xAA;
tripleErr[120] ^= 0xBB;
tripleErr[210] ^= 0xCC;
result = rs.correctErrors(tripleErr, 3);
assert(result !== null, 'corrects 3 errors');
assert(result.errors === 3, 'reports 3 errors');
if (result) {
  match = true;
  for (var i = 0; i < cleanEncoded.length; i++) {
    if (cleanEncoded[i] !== result.corrected[i]) { match = false; break; }
  }
  assert(match, 'fully corrected back to original');
}

// --- Test 4: Four byte errors (exceeds capacity) ---
console.log('4. Four byte errors (exceeds t=3)');
var quadErr = new Uint8Array(cleanEncoded);
quadErr[50] ^= 0x11;
quadErr[100] ^= 0x22;
quadErr[150] ^= 0x33;
quadErr[200] ^= 0x44;
result = rs.correctErrors(quadErr, 3);
assert(result === null, 'returns null for uncorrectable errors');

// --- Test 5: Error at start ---
console.log('5. Error at position 0');
var startErr = new Uint8Array(cleanEncoded);
startErr[0] ^= 0xFF;

result = rs.correctErrors(startErr, 3);
assert(result !== null, 'corrects error at position 0');
assert(result.errors === 1, 'reports 1 error');

// --- Test 6: Error at end ---
console.log('6. Error at last position');
var endErr = new Uint8Array(cleanEncoded);
endErr[RS_N - 1] ^= 0x77;
result = rs.correctErrors(endErr, 3);
assert(result !== null, 'corrects error at position ' + (RS_N - 1));
assert(result.errors === 1, 'reports 1 error');

// --- Test 7: Two adjacent errors ---
console.log('7. Two adjacent errors');
var adjErr = new Uint8Array(cleanEncoded);
adjErr[100] ^= 0x13;
adjErr[101] ^= 0x57;
result = rs.correctErrors(adjErr, 3);
assert(result !== null, 'corrects adjacent errors');
assert(result.errors === 2, 'reports 2 errors');
match = true;
for (var i = 0; i < cleanEncoded.length; i++) {
  if (cleanEncoded[i] !== result.corrected[i]) { match = false; break; }
}
assert(match, 'fully corrected back to original');

// --- Test 8: Single-bit flip (common real-world case) ---
console.log('8. Single bit flip');
var bitErr = new Uint8Array(cleanEncoded);
bitErr[77] ^= 0x01;  // flip just LSB
result = rs.correctErrors(bitErr, 3);
assert(result !== null, 'corrects single bit flip');
assert(result.errors === 1, 'reports 1 error');

console.log('\n=== ' + (failed === 0 ? 'ALL ' + passed + ' TESTS PASSED' : passed + ' passed, ' + failed + ' FAILED') + ' ===');
process.exit(failed > 0 ? 1 : 0);
