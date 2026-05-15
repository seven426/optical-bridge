// GF(2^8) arithmetic with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1)
const GF256 = (() => {
  const PRIMITIVE = 0x11D;
  const EXP = new Uint8Array(512);  // double-sized for multiplication speed
  const LOG = new Uint8Array(256);

  // Build log/exp tables
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    EXP[i + 255] = x;  // duplicate for faster lookup
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIMITIVE;
  }
  LOG[0] = 0;  // log(0) is undefined; use 0 as sentinel

  function add(a, b) { return a ^ b; }
  function sub(a, b) { return a ^ b; }

  function mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function div(a, b) {
    if (b === 0) throw new Error('Division by zero');
    if (a === 0) return 0;
    return EXP[LOG[a] - LOG[b] + 255];
  }

  function inverse(a) {
    if (a === 0) throw new Error('Inverse of zero');
    return EXP[255 - LOG[a]];
  }

  function pow(a, n) {
    if (n === 0) return 1;
    if (a === 0) return 0;
    return EXP[(LOG[a] * n) % 255];
  }

  return { add, sub, mul, div, inverse, pow, EXP, LOG };
})();
