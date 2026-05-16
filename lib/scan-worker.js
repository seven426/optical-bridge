// Web Worker: receives pixel data, runs jsQR, returns result
// Keeps jsQR's CPU load off the main thread so scanning doesn't block frame capture

importScripts('jsQR.js');

self.onmessage = function(e) {
  var pixels = new Uint8ClampedArray(e.data.pixels);
  var width = e.data.width;
  var height = e.data.height;
  var opts = e.data.opts || {};
  var id = e.data.id;

  try {
    var result = jsQR(pixels, width, height, opts);
    self.postMessage({ id: id, result: result }, e.data.transferBack || undefined);
  } catch (err) {
    self.postMessage({ id: id, error: err.message });
  }
};
