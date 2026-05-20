const ReedSolomon = (() => {
  const gf = GF256;

  // Build Vandermonde matrix: (K+N) x K
  // First K rows are identity (systematic), last N rows are vandermonde
  function buildVandermonde(k, ntotal) {
    const rows = ntotal;  // K + N
    const cols = k;
    const mat = new Array(rows);
    for (let r = 0; r < rows; r++) {
      mat[r] = new Uint8Array(cols);
      if (r < k) {
        mat[r][r] = 1;  // identity
      } else {
        for (let c = 0; c < cols; c++) {
          mat[r][c] = gf.pow(r, c);  // r^c in GF(2^8)
        }
      }
    }
    return mat;
  }

  // Gaussian elimination to invert a square matrix over GF(2^8)
  function matrixInvert(matrix) {
    const n = matrix.length;
    const aug = new Array(n);
    for (let i = 0; i < n; i++) {
      aug[i] = new Uint8Array(2 * n);
      aug[i].set(matrix[i], 0);
      aug[i][n + i] = 1;
    }

    for (let col = 0; col < n; col++) {
      let pivot = -1;
      for (let row = col; row < n; row++) {
        if (aug[row][col] !== 0) { pivot = row; break; }
      }
      if (pivot === -1) throw new Error('Matrix is singular');

      if (pivot !== col) {
        const tmp = aug[col]; aug[col] = aug[pivot]; aug[pivot] = tmp;
      }

      const inv = gf.inverse(aug[col][col]);
      for (let j = 0; j < 2 * n; j++) {
        aug[col][j] = gf.mul(aug[col][j], inv);
      }

      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = aug[row][col];
        if (factor === 0) continue;
        for (let j = 0; j < 2 * n; j++) {
          aug[row][j] = gf.add(aug[row][j], gf.mul(factor, aug[col][j]));
        }
      }
    }

    const inv = new Array(n);
    for (let i = 0; i < n; i++) {
      inv[i] = aug[i].slice(n, 2 * n);
    }
    return inv;
  }

  // Multiply matrix (R x C) by "frames" (C x byteLen) -> result (R x byteLen)
  function matrixMulFrames(mat, frames) {
    const matRows = mat.length;
    const matCols = mat[0].length;
    const byteLen = frames[0].length;
    const result = new Array(matRows);
    for (let r = 0; r < matRows; r++) {
      result[r] = new Uint8Array(byteLen);
      for (let b = 0; b < byteLen; b++) {
        let sum = 0;
        for (let c = 0; c < matCols; c++) {
          sum = gf.add(sum, gf.mul(mat[r][c], frames[c][b]));
        }
        result[r][b] = sum;
      }
    }
    return result;
  }

  function encode(dataFrames, k, n) {
    const vandermonde = buildVandermonde(k, k + n);
    return matrixMulFrames(vandermonde, dataFrames);
  }

  function decode(receivedFrames, frameIndices, k, n) {
    if (receivedFrames.length !== k || frameIndices.length !== k) {
      throw new Error('Need exactly K=' + k + ' frames, got ' + receivedFrames.length);
    }

    const vandermonde = buildVandermonde(k, k + n);

    const subMatrix = new Array(k);
    for (let i = 0; i < k; i++) {
      subMatrix[i] = new Uint8Array(k);
      for (let j = 0; j < k; j++) {
        subMatrix[i][j] = vandermonde[frameIndices[i]][j];
      }
    }

    const invSubMatrix = matrixInvert(subMatrix);
    return matrixMulFrames(invSubMatrix, receivedFrames);
  }

  // --- Inner FEC: byte-level error correction ---
  // RS(2t+k, k) over GF(256) with generator g(x)=Π(x-α^i), i=0..2t-1
  // α=2 is the primitive element

  function computeSyndromes(data, npar) {
    var syn = new Uint8Array(npar);
    var allZero = true;
    for (var i = 0; i < npar; i++) {
      var ai = gf.pow(2, i);  // α^i
      var s = 0;
      // Horner: r(α^i)
      for (var j = data.length - 1; j >= 0; j--) {
        s = gf.add(gf.mul(s, ai), data[j]);
      }
      syn[i] = s;
      if (s !== 0) allZero = false;
    }
    return allZero ? null : syn;
  }

  // Peterson direct solver for error locator Λ(x) = 1 + λ₁x + ... + λ_v x^v
  // For v errors: Σ λ_k · S_{i-k} = 0 for i=v..2v-1, λ₀=1
  function findErrorLocator(syn, t) {
    for (var v = t; v >= 1; v--) {
      var M = new Array(v);
      for (var i = 0; i < v; i++) {
        M[i] = new Uint8Array(v);
        for (var j = 0; j < v; j++) {
          M[i][j] = syn[v - 1 + i - j];
        }
      }

      var det = determinant(M);
      if (det === 0) continue;

      var rhs = new Uint8Array(v);
      for (var i = 0; i < v; i++) rhs[i] = syn[v + i];

      var lambda = solveLinear(M, rhs);
      if (!lambda) continue;

      var result = new Uint8Array(v + 1);
      result[0] = 1;
      for (var i = 0; i < v; i++) result[i + 1] = lambda[i];
      return result;
    }
    return null;
  }

  function determinant(M) {
    var n = M.length;
    if (n === 1) return M[0][0];
    if (n === 2) return gf.add(gf.mul(M[0][0], M[1][1]), gf.mul(M[0][1], M[1][0]));
    // n = 3
    var a = gf.mul(M[0][0], gf.mul(M[1][1], M[2][2]));
    var b = gf.mul(M[0][1], gf.mul(M[1][2], M[2][0]));
    var c = gf.mul(M[0][2], gf.mul(M[1][0], M[2][1]));
    var d = gf.mul(M[0][2], gf.mul(M[1][1], M[2][0]));
    var e = gf.mul(M[0][1], gf.mul(M[1][0], M[2][2]));
    var f = gf.mul(M[0][0], gf.mul(M[1][2], M[2][1]));
    return gf.add(gf.add(gf.add(a, b), c), gf.add(gf.add(d, e), f));
  }

  function solveLinear(M, b) {
    var n = M.length;
    // Gaussian elimination with partial pivoting over GF(256)
    var aug = new Array(n);
    for (var i = 0; i < n; i++) {
      aug[i] = new Uint8Array(n + 1);
      for (var j = 0; j < n; j++) aug[i][j] = M[i][j];
      aug[i][n] = b[i];
    }

    for (var col = 0; col < n; col++) {
      var pivot = -1;
      for (var row = col; row < n; row++) {
        if (aug[row][col] !== 0) { pivot = row; break; }
      }
      if (pivot === -1) return null;

      if (pivot !== col) {
        var tmp = aug[col]; aug[col] = aug[pivot]; aug[pivot] = tmp;
      }

      var inv = gf.inverse(aug[col][col]);
      for (var j = col; j <= n; j++) {
        aug[col][j] = gf.mul(aug[col][j], inv);
      }

      for (var row = 0; row < n; row++) {
        if (row === col) continue;
        var factor = aug[row][col];
        if (factor === 0) continue;
        for (var j = col; j <= n; j++) {
          aug[row][j] = gf.add(aug[row][j], gf.mul(factor, aug[col][j]));
        }
      }
    }

    var x = new Uint8Array(n);
    for (var i = 0; i < n; i++) x[i] = aug[i][n];
    return x;
  }

  function berlekampMassey(syn, npar) {
    return findErrorLocator(syn, npar >> 1);
  }

  // α^(-p) in GF(256): α^255 = 1, so α^(-p) = α^(255 - p%255)
  function alphaNegPow(p) {
    var r = p % 255;
    if (r === 0) return 1;
    return gf.EXP[255 - r];
  }

  function chienSearch(lambda, n, t, syn, npar) {
    var deg = lambda.length - 1;
    if (deg > t) return null;

    var positions = [];
    var alphaInv = new Uint8Array(n);  // precompute α^(-j)
    alphaInv[0] = 1;
    for (var jj = 1; jj < n; jj++) {
      alphaInv[jj] = alphaNegPow(jj);
    }

    for (var j = 0; j < n; j++) {
      var aNegJ = alphaInv[j];
      var val = lambda[0];  // λ_0 is always 1
      var xp = aNegJ;
      for (var i = 1; i <= deg; i++) {
        if (lambda[i]) val = gf.add(val, gf.mul(lambda[i], xp));
        xp = gf.mul(xp, aNegJ);
      }
      if (val === 0) {
        positions.push(j);
        if (positions.length > t) return null;
      }
    }

    if (positions.length !== deg) return null;
    return positions;
  }

  function forneyCorrect(data, syn, lambda, positions, npar) {
    // Ω(x) = (S(x) · Λ(x)) mod x^(npar)
    var omega = new Uint8Array(npar);
    for (var i = 0; i < npar; i++) {
      var sum = 0;
      for (var j = 0; j <= i && j < lambda.length; j++) {
        if (syn[i - j] && lambda[j]) {
          sum = gf.add(sum, gf.mul(syn[i - j], lambda[j]));
        }
      }
      omega[i] = sum;
    }

    // Λ'(x): formal derivative (odd-indexed terms only in GF(2^m))
    var lambdaOddTerms = [];
    var lambdaOddLength = 0;
    for (var i = 1; i < lambda.length; i += 2) {
      if (lambda[i]) lambdaOddLength = i;
      lambdaOddTerms.push(lambda[i] || 0);
    }

    for (var p = 0; p < positions.length; p++) {
      var j = positions[p];
      var aJ = gf.pow(2, j);       // α^j
      var aNegJ = alphaNegPow(j);  // α^(-j)

      // Evaluate Ω(α^(-j))
      var omegaVal = 0;
      var xp = 1;
      for (var i = 0; i < npar; i++) {
        if (omega[i]) omegaVal = gf.add(omegaVal, gf.mul(omega[i], xp));
        xp = gf.mul(xp, aNegJ);
      }

      // Evaluate Λ'_odd(α^(-j))
      var lambdaOddVal = 0;
      xp = 1;
      for (var i = 1; i < lambda.length; i += 2) {
        if (lambda[i]) lambdaOddVal = gf.add(lambdaOddVal, gf.mul(lambda[i], xp));
        xp = gf.mul(xp, gf.mul(aNegJ, aNegJ));  // x^2 each step for odd terms
      }

      // e_j = α^j · Ω(α^(-j)) / Λ'(α^(-j))
      var errVal = gf.mul(aJ, gf.div(omegaVal, lambdaOddVal));
      data[j] = gf.add(data[j], errVal);
    }
  }

  var GEN_CACHE = {};

  function getGeneratorPoly(npar) {
    var key = String(npar);
    if (GEN_CACHE[key]) return GEN_CACHE[key];
    var g = new Uint8Array(npar + 1);
    g[0] = 1;
    var deg = 0;
    for (var i = 0; i < npar; i++) {
      var root = gf.pow(2, i);
      deg++;
      for (var j = deg; j > 0; j--) {
        g[j] = gf.add(g[j - 1], gf.mul(g[j], root));
      }
      g[0] = gf.mul(g[0], root);
    }
    GEN_CACHE[key] = g;
    return g;
  }

  function encodeBlock(data, npar) {
    // Systematic RS: c(x) = d(x)·x^npar + rem(d(x)·x^npar, g(x))
    // Format: [npar parity bytes][k data bytes]
    var k = data.length;
    var n = k + npar;
    var g = getGeneratorPoly(npar);
    var shift = new Uint8Array(n);
    shift.set(data, npar);
    for (var i = n - 1; i >= npar; i--) {
      var factor = shift[i];
      if (factor === 0) continue;
      for (var j = 0; j <= npar; j++) {
        shift[i - npar + j] = gf.add(shift[i - npar + j], gf.mul(factor, g[j]));
      }
    }
    var result = new Uint8Array(n);
    result.set(shift.slice(0, npar), 0);
    result.set(data, npar);
    return result;
  }

  function correctErrors(data, t) {
    if (!t) t = 3;
    var npar = t << 1;  // 2t

    // 1. Syndromes
    var syn = computeSyndromes(data, npar);
    if (!syn) return { corrected: data, errors: 0 };

    // 2. Berlekamp-Massey
    var lambda = berlekampMassey(syn, npar);
    if (!lambda || lambda.length - 1 > t) return null;

    // 3. Chien search
    var positions = chienSearch(lambda, data.length, t, syn, npar);
    if (!positions) return null;

    // 4. Forney correction
    var corrected = new Uint8Array(data);
    forneyCorrect(corrected, syn, lambda, positions, npar);

    return { corrected: corrected, errors: positions.length };
  }

  return { encode, decode, correctErrors, encodeBlock, buildVandermonde, matrixInvert, matrixMulFrames,
           computeSyndromes, berlekampMassey, chienSearch, forneyCorrect };
})();
