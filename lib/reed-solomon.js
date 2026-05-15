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

    // Extract the K rows corresponding to received frames
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

  return { encode, decode, buildVandermonde, matrixInvert, matrixMulFrames };
})();
