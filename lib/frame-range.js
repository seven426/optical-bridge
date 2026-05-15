const FrameRange = (() => {
  /**
   * Parse a frame range expression into a Set of frame indices.
   * Supports: "42", "87,120", "120-125", "300-310,520,600-605"
   * Invalid tokens are silently skipped.
   */
  function parse(expr, maxFrame) {
    const result = new Set();
    if (!expr || typeof expr !== 'string') return result;

    const tokens = expr.split(',');
    for (const token of tokens) {
      const trimmed = token.trim();
      if (!trimmed) continue;

      if (trimmed.includes('-')) {
        const parts = trimmed.split('-');
        if (parts.length !== 2) continue;
        const start = parseInt(parts[0], 10);
        const end = parseInt(parts[1], 10);
        if (isNaN(start) || isNaN(end) || start > end) continue;

        const actualEnd = (maxFrame !== undefined) ? Math.min(end, maxFrame - 1) : end;
        for (let i = start; i <= actualEnd; i++) {
          result.add(i);
        }
      } else {
        const n = parseInt(trimmed, 10);
        if (!isNaN(n)) {
          if (maxFrame === undefined || n < maxFrame) {
            result.add(n);
          }
        }
      }
    }
    return result;
  }

  /**
   * Format a Set of frame indices back into a compact string.
   * E.g., {42,87,120,121,122,123} -> "42,87,120-123"
   */
  function format(frameSet) {
    const sorted = [...frameSet].sort((a, b) => a - b);
    if (sorted.length === 0) return '';

    const parts = [];
    let start = sorted[0], end = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === end + 1) {
        end = sorted[i];
      } else {
        parts.push(start === end ? `${start}` : `${start}-${end}`);
        start = sorted[i];
        end = sorted[i];
      }
    }
    parts.push(start === end ? `${start}` : `${start}-${end}`);
    return parts.join(',');
  }

  return { parse, format };
})();
