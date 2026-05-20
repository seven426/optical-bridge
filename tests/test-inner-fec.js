// Integration test: FrameProtocol inner FEC encode → corrupt → decode
'use strict';
var fs = require('fs');

globalThis.window = globalThis;
globalThis.document = null;
globalThis.Uint8ClampedArray = Uint8Array;

function loadMod(path, name) {
  var s = fs.readFileSync(path, 'utf8');
  s = s.replace('const ' + name + ' =', 'globalThis.' + name + ' =');
  eval(s);
}
loadMod('lib/gf256.js', 'GF256');
loadMod('lib/reed-solomon.js', 'ReedSolomon');
loadMod('lib/frame-protocol.js', 'FrameProtocol');
loadMod('lib/rawgrid.js', 'RawGrid');
loadMod('lib/colorgrid.js', 'ColorGrid');

var fp = FrameProtocol;
var gf = GF256;

var passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else { failed++; console.log('  FAIL: ' + msg); }
}

console.log('=== Inner FEC Integration Tests ===\n');

// --- RawGrid capacity ---
console.log('1. RawGrid capacity');
var rawCap = RawGrid.dataCells();
var rawBlocks = fp.innerBlockCount(rawCap);
var rawDataCap = fp.innerDataCapacity(rawCap);
var rawEncSize = fp.innerEncodedSize(rawCap);
console.log('  grid capacity=' + rawCap + ', blocks=' + rawBlocks + ', data capacity=' + rawDataCap + ', encoded size=' + rawEncSize);
assert(rawBlocks === 5, 'RawGrid: 5 blocks');
assert(rawDataCap === 1180, 'RawGrid: 1180B data capacity');
assert(rawEncSize === 1210, 'RawGrid: 1210B encoded size');
assert(rawDataCap > fp.getHeaderSize(), 'RawGrid: data capacity > header');

// --- ColorGrid capacity ---
console.log('2. ColorGrid capacity');
var colCap = ColorGrid.dataCells();
var colBlocks = fp.innerBlockCount(colCap);
var colDataCap = fp.innerDataCapacity(colCap);
console.log('  grid capacity=' + colCap + ', blocks=' + colBlocks + ', data capacity=' + colDataCap);
assert(colBlocks === 15, 'ColorGrid: 15 blocks');
assert(colDataCap === 3540, 'ColorGrid: 3540B data capacity');

// --- Clean round-trip ---
console.log('3. Clean round-trip (RawGrid)');
var headerSize = fp.getHeaderSize();
var payloadSize = rawDataCap - headerSize;
var testPayload = new Uint8Array(payloadSize);
for (var i = 0; i < payloadSize; i++) testPayload[i] = (i * 73 + 19) & 0xFF;

var frame = fp.packFrame({
  fileId: 0, frameIdx: 1, totalFrames: 3,
  fecGroup: 0, fecGroupSize: 7, fecK: 5,
  fileSize: payloadSize * 3, payload: testPayload
});

var encoded = fp.encodeInnerFEC(frame, rawCap);
assert(encoded !== null, 'inner FEC encode succeeds');
assert(encoded.length === rawEncSize, 'encoded size = ' + rawEncSize);

// Pad to grid capacity (as sender does)
var gridData = new Uint8Array(rawCap);
gridData.set(encoded);

// Decode (as receiver does)
var decoded = fp.decodeInnerFEC(gridData, rawCap);
assert(decoded !== null, 'inner FEC decode succeeds');
assert(decoded.errors === 0, 'zero errors in clean round-trip');
assert(decoded.data.length === rawDataCap, 'decoded data size = ' + rawDataCap);

// Verify frame can be unpacked
var unpacked = fp.unpackFrame(decoded.data);
assert(unpacked !== null, 'unpackFrame succeeds after inner FEC');
assert(unpacked.payload.length === payloadSize, 'payload size preserved');

var payloadMatch = true;
for (var i = 0; i < payloadSize; i++) {
  if (unpacked.payload[i] !== testPayload[i]) { payloadMatch = false; break; }
}
assert(payloadMatch, 'payload intact after clean round-trip');

// --- Single byte error ---
console.log('4. Single byte error correction');
var corrupted = new Uint8Array(gridData);
corrupted[100] ^= 0x55;
var corrDecoded = fp.decodeInnerFEC(corrupted, rawCap);
assert(corrDecoded !== null, 'corrects single byte error');
assert(corrDecoded.errors === 1, 'reports 1 corrected error');

var corrMatch = true;
for (var i = 0; i < decoded.data.length; i++) {
  if (decoded.data[i] !== corrDecoded.data[i]) { corrMatch = false; break; }
}
assert(corrMatch, 'data fully restored after correction');

// --- Multiple errors in different blocks ---
console.log('5. Errors spread across blocks');
var multiErr = new Uint8Array(gridData);
// Each block is 242 bytes; 5 blocks at offsets 0,242,484,726,968
multiErr[50] ^= 0xAA;      // block 0
multiErr[300] ^= 0xBB;     // block 1
multiErr[550] ^= 0xCC;     // block 2
multiErr[800] ^= 0xDD;     // block 3
multiErr[1050] ^= 0xEE;    // block 4
var multiDecoded = fp.decodeInnerFEC(multiErr, rawCap);
assert(multiDecoded !== null, 'corrects errors in all blocks');
assert(multiDecoded.errors === 5, 'reports 5 corrected errors');

var multiMatch = true;
for (var i = 0; i < decoded.data.length; i++) {
  if (decoded.data[i] !== multiDecoded.data[i]) { multiMatch = false; break; }
}
assert(multiMatch, 'data fully restored');

// --- Exceed correction capacity in one block ---
console.log('6. Uncorrectable block → frame lost');
var badBlock = new Uint8Array(gridData);
// Put 4 errors in block 0 (exceeds t=3)
badBlock[10] ^= 0x11;
badBlock[50] ^= 0x22;
badBlock[100] ^= 0x33;
badBlock[150] ^= 0x44;
var badDecoded = fp.decodeInnerFEC(badBlock, rawCap);
assert(badDecoded === null, 'returns null for uncorrectable block');

console.log('\n=== ' + (failed === 0 ? 'ALL ' + passed + ' TESTS PASSED' : passed + ' passed, ' + failed + ' FAILED') + ' ===');
process.exit(failed > 0 ? 1 : 0);
