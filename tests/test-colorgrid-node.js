// Node.js smoke test for ColorGrid encode/decode
'use strict';

globalThis.window = globalThis;
globalThis.document = null;
globalThis.Uint8ClampedArray = Uint8Array;

var fs = require('fs');
function loadMod(path, name) {
  var s = fs.readFileSync(path, 'utf8');
  s = s.replace('const ' + name + ' =', 'globalThis.' + name + ' =');
  eval(s);
}
loadMod('lib/colorgrid.js', 'ColorGrid');

function makePixels(w, h) { return new Uint8Array(w * h * 4); }

var passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS: ' + msg); }
  else { failed++; console.log('FAIL: ' + msg); }
}

// Test: render at cellPx, decode from pixels, compare
console.log('=== ColorGrid self-test ===');
var data = new Uint8Array(3639);
for (var i = 0; i < 3639; i++) data[i] = (i * 37 + 11) & 0xFF;

// Render to canvas (needs document.createElement)
var cellPx = 4;
globalThis.document = {
  createElement: function(tag) {
    if (tag === 'canvas') {
      var w = 100 * cellPx;
      var pixels = makePixels(w, w);
      var ctx = {
        fillStyle: '#000000',
        fillRect: function(x, y, pw, ph) {
          var r = 0, g = 0, b = 0;
          if (this.fillStyle === '#ffffff') { r = 255; g = 255; b = 255; }
          else if (this.fillStyle === '#000000') { r = 0; g = 0; b = 0; }
          else {
            var m = this.fillStyle.match(/rgb\((\d+),(\d+),(\d+)\)/);
            if (m) { r = +m[1]===0?0:255; g = +m[2]===0?0:255; b = +m[3]===0?0:255; }
          }
          for (var dy = y; dy < y + ph; dy++)
            for (var dx = x; dx < x + pw; dx++) {
              var pi = (dy * w + dx) * 4;
              pixels[pi]=r; pixels[pi+1]=g; pixels[pi+2]=b; pixels[pi+3]=255;
            }
        },
        getImageData: function(x, y, iw, ih) { return { data: pixels, width: iw, height: ih }; }
      };
      return { width: w, height: w, getContext: function() { return ctx; } };
    }
    return {};
  }
};

var canvas = ColorGrid.render(data, cellPx);
var ctx = canvas.getContext('2d');
var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
var decoded = ColorGrid.decode(imgData.data, imgData.width, imgData.height);
assert(decoded !== null, 'decode returns non-null');
assert(decoded.length === 3639, 'decoded length = 3639');

var match = true, firstDiff = -1;
for (var i = 0; i < 3639; i++) {
  if (data[i] !== decoded[i]) { match = false; firstDiff = i; break; }
}
assert(match, 'full roundtrip match (3639 bytes)');
if (!match) console.log('  first diff at byte[' + firstDiff + ']: ' + data[firstDiff].toString(16) + ' vs ' + decoded[firstDiff].toString(16));

console.log('\n=== ' + (failed === 0 ? 'ALL ' + passed + ' TESTS PASSED' : passed + ' passed, ' + failed + ' FAILED') + ' ===');
process.exit(failed > 0 ? 1 : 0);
