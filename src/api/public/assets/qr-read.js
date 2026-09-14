/* ==========================================================================
   QR CODE READER, for the camera scanners.

   Chrome on Android and on a computer reads QR codes itself (BarcodeDetector),
   and the pages use that where it exists. Chrome on an iPhone cannot: every
   browser on iOS is WebKit underneath, and WebKit has no BarcodeDetector. So
   the pages hand this the camera's frames instead.

   Versions 1 to 10, all four error-correction levels, numeric, alphanumeric
   and byte data. That is everything the pages draw (byte mode, level M, up to
   version 10) and the small codes wallets show for an address.

     QRRead.decode({ data, width, height })   the text, or null

   `data` is RGBA, as a canvas's getImageData gives it. Never throws on a frame
   with no code in it; most frames have none.

   The steps are the usual ones: threshold the picture locally, find the three
   finder squares, work out the module size and the version, find the
   alignment square, map the grid through the perspective they describe, then
   read the format, unmask, correct each block with Reed-Solomon and parse.
   ========================================================================== */
(function (root) {
  "use strict";

  /* ---- 1. light and dark ---------------------------------------------------

     A threshold per 8-pixel block, from the blocks around it: a phone held
     over another phone's screen is never evenly lit. */

  var BLOCK = 8;

  function luminance(image) {
    var d = image.data, n = image.width * image.height;
    var out = new Uint8Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      out[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
    return out;
  }

  function binarize(gray, w, h) {
    var bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK);
    var points = new Float64Array(bw * bh);
    var bx, by, x, y, i;

    for (by = 0; by < bh; by++) {
      var y0 = Math.max(0, Math.min(by * BLOCK, h - BLOCK));
      var y1 = Math.min(y0 + BLOCK, h);
      for (bx = 0; bx < bw; bx++) {
        var x0 = Math.max(0, Math.min(bx * BLOCK, w - BLOCK));
        var x1 = Math.min(x0 + BLOCK, w);
        var min = 255, max = 0, sum = 0;
        for (y = y0; y < y1; y++) {
          for (x = x0, i = y * w + x0; x < x1; x++, i++) {
            var v = gray[i];
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
          }
        }
        var point = sum / ((y1 - y0) * (x1 - x0));
        if (max - min <= 24) {
          /* A flat block is light, unless the blocks already done beside it
             say this is the dark side of an edge. */
          point = min / 2;
          if (by > 0 && bx > 0) {
            var near = (points[(by - 1) * bw + bx] + 2 * points[by * bw + bx - 1] +
                        points[(by - 1) * bw + bx - 1]) / 4;
            if (min < near) point = near;
          }
        }
        points[by * bw + bx] = point;
      }
    }

    var bits = new Uint8Array(w * h);
    for (by = 0; by < bh; by++) {
      for (bx = 0; bx < bw; bx++) {
        var total = 0;
        for (var dy = -2; dy <= 2; dy++) {
          var row = Math.max(0, Math.min(bh - 1, by + dy)) * bw;
          for (var dx = -2; dx <= 2; dx++) total += points[row + Math.max(0, Math.min(bw - 1, bx + dx))];
        }
        var threshold = total / 25;
        var ye = Math.min((by + 1) * BLOCK, h), xe = Math.min((bx + 1) * BLOCK, w);
        for (y = by * BLOCK; y < ye; y++) {
          for (x = bx * BLOCK, i = y * w + x; x < xe; x++, i++) bits[i] = gray[i] <= threshold ? 1 : 0;
        }
      }
    }
    return bits;
  }

  function dark(bits, w, h, x, y) {
    return x >= 0 && y >= 0 && x < w && y < h && bits[y * w + x] === 1;
  }


  /* ---- 2. finder squares ---------------------------------------------------

     Dark, light, dark, light, dark in the proportions 1:1:3:1:1, along a row,
     then confirmed down the column and along both again. */

  function ratioOk(c, loose) {
    var total = c[0] + c[1] + c[2] + c[3] + c[4];
    if (total < 7) return false;
    var m = total / 7, v = m * (loose ? 0.75 : 0.5);
    return Math.abs(m - c[0]) < v && Math.abs(m - c[1]) < v && Math.abs(3 * m - c[2]) < 3 * v &&
      Math.abs(m - c[3]) < v && Math.abs(m - c[4]) < v;
  }

  /* Through (x, y) along (dx, dy), both ways. The centre along that line, or NaN. */
  function crossCheck(bits, w, h, x, y, dx, dy, maxCount, originalTotal) {
    var c = [0, 0, 0, 0, 0];
    var px = x, py = y;
    while (dark(bits, w, h, px, py)) { c[2]++; px -= dx; py -= dy; }
    if (px < 0 || py < 0 || px >= w || py >= h) return NaN;
    while (px >= 0 && py >= 0 && px < w && py < h && !dark(bits, w, h, px, py) && c[1] <= maxCount) { c[1]++; px -= dx; py -= dy; }
    if (px < 0 || py < 0 || px >= w || py >= h || c[1] > maxCount) return NaN;
    while (dark(bits, w, h, px, py) && c[0] <= maxCount) { c[0]++; px -= dx; py -= dy; }
    if (c[0] > maxCount) return NaN;

    px = x + dx; py = y + dy;
    while (dark(bits, w, h, px, py)) { c[2]++; px += dx; py += dy; }
    if (px < 0 || py < 0 || px >= w || py >= h) return NaN;
    while (px >= 0 && py >= 0 && px < w && py < h && !dark(bits, w, h, px, py) && c[3] <= maxCount) { c[3]++; px += dx; py += dy; }
    if (px < 0 || py < 0 || px >= w || py >= h || c[3] > maxCount) return NaN;
    while (dark(bits, w, h, px, py) && c[4] <= maxCount) { c[4]++; px += dx; py += dy; }
    if (c[4] > maxCount) return NaN;

    var total = c[0] + c[1] + c[2] + c[3] + c[4];
    if (originalTotal && 5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return NaN;
    if (!ratioOk(c, !originalTotal)) return NaN;
    var end = dy ? py : px;
    return end - c[4] - c[3] - c[2] / 2;
  }

  function confirmFinder(bits, w, h, found, c, row, endX) {
    var total = c[0] + c[1] + c[2] + c[3] + c[4];
    var cx = endX - c[4] - c[3] - c[2] / 2;
    var cy = crossCheck(bits, w, h, Math.floor(cx), row, 0, 1, c[2], total);
    if (isNaN(cy)) return;
    cx = crossCheck(bits, w, h, Math.floor(cx), Math.floor(cy), 1, 0, c[2], total);
    if (isNaN(cx)) return;
    if (isNaN(crossCheck(bits, w, h, Math.floor(cx), Math.floor(cy), 1, 1, 2 * c[2], 0))) return;

    var size = total / 7;
    for (var i = 0; i < found.length; i++) {
      var f = found[i];
      if (Math.abs(cx - f.x) <= size && Math.abs(cy - f.y) <= size &&
          (Math.abs(size - f.size) <= 1 || Math.abs(size - f.size) <= f.size)) {
        var n = f.count + 1;
        f.x = (f.count * f.x + cx) / n;
        f.y = (f.count * f.y + cy) / n;
        f.size = (f.count * f.size + size) / n;
        f.count = n;
        return;
      }
    }
    found.push({ x: cx, y: cy, size: size, count: 1 });
  }

  function findFinders(bits, w, h) {
    var found = [];
    var step = Math.max(1, Math.min(3, Math.round(h / 240)));
    for (var y = 0; y < h; y += step) {
      var c = [0, 0, 0, 0, 0], state = 0, base = y * w;
      for (var x = 0; x < w; x++) {
        if (bits[base + x] === 1) {
          if (state & 1) state++;
          c[state]++;
        } else if (state & 1) {
          c[state]++;
        } else if (state === 4) {
          if (ratioOk(c, false)) confirmFinder(bits, w, h, found, c, y, x);
          c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0;
          state = 3;
        } else {
          c[++state]++;
        }
      }
      if (state === 4 && ratioOk(c, false)) confirmFinder(bits, w, h, found, c, y, w);
    }
    return found;
  }

  function distance(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* The corner opposite the longest side is top left; the sign of the cross
     product says which of the other two is top right. */
  function orient(a, b, c) {
    var ab = distance(a, b), bc = distance(b, c), ac = distance(a, c);
    var tl, p, q;
    if (bc >= ab && bc >= ac) { tl = a; p = b; q = c; }
    else if (ac >= ab && ac >= bc) { tl = b; p = a; q = c; }
    else { tl = c; p = a; q = b; }
    if ((p.x - tl.x) * (q.y - tl.y) - (p.y - tl.y) * (q.x - tl.x) < 0) { var t = p; p = q; q = t; }
    return { tl: tl, tr: p, bl: q };
  }

  /* Threes that look like the corners of one code, most likely first. */
  function arrangements(found) {
    var pool = found.filter(function (f) { return f.count >= 2; });
    if (pool.length < 3) pool = found.slice();
    pool.sort(function (a, b) { return b.count - a.count; });
    pool = pool.slice(0, 12);
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      for (var j = i + 1; j < pool.length; j++) {
        for (var k = j + 1; k < pool.length; k++) {
          var a = pool[i], b = pool[j], c = pool[k];
          var big = Math.max(a.size, b.size, c.size), small = Math.min(a.size, b.size, c.size);
          if (big > small * 1.6) continue;
          var t = orient(a, b, c);
          var top = distance(t.tl, t.tr), left = distance(t.tl, t.bl), diagonal = distance(t.tr, t.bl);
          var sides = Math.abs(top - left) / Math.max(top, left);
          var corner = Math.abs(diagonal - Math.sqrt(top * top + left * left)) / diagonal;
          if (sides > 0.5 || corner > 0.3) continue;
          var modules = (top + left) / 2 / ((a.size + b.size + c.size) / 3);
          if (modules < 10 || modules > 60) continue;
          t.score = sides + corner + (big - small) / big;
          out.push(t);
        }
      }
    }
    out.sort(function (x, y) { return x.score - y.score; });
    return out;
  }


  /* ---- 3. module size, version, alignment ---------------------------------- */

  /* From a finder's centre toward (toX, toY): how far until its dark core,
     light ring and dark ring are all crossed. 3.5 modules. */
  function runLength(bits, w, h, fromX, fromY, toX, toY) {
    fromX = Math.floor(fromX); fromY = Math.floor(fromY);
    toX = Math.floor(toX); toY = Math.floor(toY);
    var steep = Math.abs(toY - fromY) > Math.abs(toX - fromX), t;
    if (steep) {
      t = fromX; fromX = fromY; fromY = t;
      t = toX; toX = toY; toY = t;
    }
    var ddx = Math.abs(toX - fromX), ddy = Math.abs(toY - fromY);
    var error = -ddx / 2;
    var xstep = fromX < toX ? 1 : -1, ystep = fromY < toY ? 1 : -1;
    var state = 0;
    for (var x = fromX, y = fromY; x !== toX + xstep; x += xstep) {
      var rx = steep ? y : x, ry = steep ? x : y;
      if ((state === 1) === dark(bits, w, h, rx, ry)) {
        if (state === 2) return Math.sqrt((x - fromX) * (x - fromX) + (y - fromY) * (y - fromY));
        state++;
      }
      error += ddy;
      if (error > 0) {
        if (y === toY) break;
        y += ystep;
        error -= ddx;
      }
    }
    if (state === 2) return Math.sqrt((toX + xstep - fromX) * (toX + xstep - fromX) + (toY - fromY) * (toY - fromY));
    return NaN;
  }

  function runBothWays(bits, w, h, fromX, fromY, toX, toY) {
    var result = runLength(bits, w, h, fromX, fromY, toX, toY);
    var scale = 1;
    var otherX = fromX - (toX - fromX);
    if (otherX < 0) { scale = fromX / (fromX - otherX); otherX = 0; }
    else if (otherX >= w) { scale = (w - 1 - fromX) / (otherX - fromX); otherX = w - 1; }
    var otherY = fromY - (toY - fromY) * scale;
    scale = 1;
    if (otherY < 0) { scale = fromY / (fromY - otherY); otherY = 0; }
    else if (otherY >= h) { scale = (h - 1 - fromY) / (otherY - fromY); otherY = h - 1; }
    otherX = fromX + (otherX - fromX) * scale;
    result += runLength(bits, w, h, fromX, fromY, otherX, otherY);
    return result - 1;
  }

  function moduleSizeBetween(bits, w, h, a, b) {
    var one = runBothWays(bits, w, h, a.x, a.y, b.x, b.y);
    var two = runBothWays(bits, w, h, b.x, b.y, a.x, a.y);
    if (isNaN(one)) return two / 7;
    if (isNaN(two)) return one / 7;
    return (one + two) / 14;
  }

  function moduleSize(bits, w, h, t) {
    var across = moduleSizeBetween(bits, w, h, t.tl, t.tr);
    var down = moduleSizeBetween(bits, w, h, t.tl, t.bl);
    if (isNaN(across)) return down;
    if (isNaN(down)) return across;
    return (across + down) / 2;
  }

  /* Modules across, from the finders' spacing: always 4v + 17. */
  function dimensionOf(t, size) {
    var across = Math.round(distance(t.tl, t.tr) / size);
    var down = Math.round(distance(t.tl, t.bl) / size);
    var d = Math.floor((across + down) / 2) + 7;
    switch (d & 3) {
      case 0: return d + 1;
      case 2: return d - 1;
      case 3: return d + 2;
      default: return d;
    }
  }

  function alignmentCross(c, size) {
    var v = size / 2;
    return Math.abs(size - c[0]) < v && Math.abs(size - c[1]) < v && Math.abs(size - c[2]) < v;
  }

  /* The small square three modules in from the bottom-right corner: light,
     DARK, light across its centre. */
  function findAlignment(bits, w, h, t, size, dim) {
    var between = dim - 7;
    var cornerX = t.tr.x - t.tl.x + t.bl.x, cornerY = t.tr.y - t.tl.y + t.bl.y;
    var k = 1 - 3 / between;
    var ex = Math.floor(t.tl.x + k * (cornerX - t.tl.x));
    var ey = Math.floor(t.tl.y + k * (cornerY - t.tl.y));
    for (var allowance = 4; allowance <= 16; allowance <<= 1) {
      var found = searchAlignment(bits, w, h, ex, ey, size, Math.floor(allowance * size));
      if (found) return found;
    }
    return null;
  }

  function searchAlignment(bits, w, h, ex, ey, size, reach) {
    var left = Math.max(0, ex - reach), right = Math.min(w - 1, ex + reach);
    var top = Math.max(0, ey - reach), bottom = Math.min(h - 1, ey + reach);
    if (right - left < size * 3 || bottom - top < size * 3) return null;
    var seen = [];
    var middle = top + Math.floor((bottom - top) / 2);
    var rows = bottom - top;
    for (var n = 0; n < rows; n++) {
      var y = middle + ((n & 1) === 0 ? (n + 1) >> 1 : -((n + 1) >> 1));
      if (y < top || y > bottom) continue;
      var c = [0, 0, 0], state = 0, x = left;
      while (x < right && !dark(bits, w, h, x, y)) x++;
      for (; x < right; x++) {
        if (dark(bits, w, h, x, y)) {
          if (state === 1) {
            c[1]++;
          } else if (state === 2) {
            if (alignmentCross(c, size)) {
              var hit = confirmAlignment(bits, w, h, seen, c, y, x, size);
              if (hit) return hit;
            }
            c[0] = c[2]; c[1] = 1; c[2] = 0;
            state = 1;
          } else {
            c[++state]++;
          }
        } else {
          if (state === 1) state++;
          c[state]++;
        }
      }
      if (alignmentCross(c, size)) {
        var last = confirmAlignment(bits, w, h, seen, c, y, right, size);
        if (last) return last;
      }
    }
    return seen.length ? seen[0] : null;
  }

  function confirmAlignment(bits, w, h, seen, c, y, endX, size) {
    var total = c[0] + c[1] + c[2];
    var cx = endX - c[2] - c[1] / 2;
    var col = Math.floor(cx), max = 2 * c[1];
    var v = [0, 0, 0], py = y;
    while (py >= 0 && dark(bits, w, h, col, py) && v[1] <= max) { v[1]++; py--; }
    if (py < 0 || v[1] > max) return null;
    while (py >= 0 && !dark(bits, w, h, col, py) && v[0] <= max) { v[0]++; py--; }
    if (v[0] > max) return null;
    py = y + 1;
    while (py < h && dark(bits, w, h, col, py) && v[1] <= max) { v[1]++; py++; }
    if (py === h || v[1] > max) return null;
    while (py < h && !dark(bits, w, h, col, py) && v[2] <= max) { v[2]++; py++; }
    if (v[2] > max) return null;
    var vt = v[0] + v[1] + v[2];
    if (5 * Math.abs(vt - total) >= 2 * total || !alignmentCross(v, size)) return null;
    var cy = py - v[2] - v[1] / 2;
    var estimate = total / 3;
    for (var i = 0; i < seen.length; i++) {
      var s = seen[i];
      if (Math.abs(cy - s.y) <= estimate && Math.abs(cx - s.x) <= estimate) {
        return { x: (s.x + cx) / 2, y: (s.y + cy) / 2 };
      }
    }
    seen.push({ x: cx, y: cy });
    return null;
  }


  /* ---- 4. the grid ------------------------------------------------------------

     A homography as [a b c; d e f; g h i], taking (x, y, 1) to (X, Y, W). */

  function squareTo(x0, y0, x1, y1, x2, y2, x3, y3) {
    var sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
    if (sx === 0 && sy === 0) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
    var dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    var den = dx1 * dy2 - dx2 * dy1;
    var g = (sx * dy2 - dx2 * sy) / den, hh = (dx1 * sy - sx * dy1) / den;
    return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
  }

  function adjugate(m) {
    return [
      m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
      m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
      m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]
    ];
  }

  function times(p, q) {
    var r = new Array(9);
    for (var row = 0; row < 3; row++) {
      for (var col = 0; col < 3; col++) {
        r[row * 3 + col] = p[row * 3] * q[col] + p[row * 3 + 1] * q[3 + col] + p[row * 3 + 2] * q[6 + col];
      }
    }
    return r;
  }

  /* Module coordinates to picture coordinates, pinned at the three finder
     centres and the alignment square (or where a fourth corner would be). */
  function gridTransform(t, align, dim) {
    var far = dim - 3.5, bx, by, sx;
    if (align) { bx = align.x; by = align.y; sx = far - 3; }
    else { bx = t.tr.x - t.tl.x + t.bl.x; by = t.tr.y - t.tl.y + t.bl.y; sx = far; }
    var toPicture = squareTo(t.tl.x, t.tl.y, t.tr.x, t.tr.y, bx, by, t.bl.x, t.bl.y);
    var fromModules = adjugate(squareTo(3.5, 3.5, far, 3.5, sx, sx, 3.5, far));
    return times(toPicture, fromModules);
  }

  function sampleGrid(bits, w, h, m, dim) {
    var grid = new Uint8Array(dim * dim);
    for (var r = 0; r < dim; r++) {
      for (var c = 0; c < dim; c++) {
        var u = c + 0.5, v = r + 0.5;
        var z = m[6] * u + m[7] * v + m[8];
        var x = Math.floor((m[0] * u + m[1] * v + m[2]) / z);
        var y = Math.floor((m[3] * u + m[4] * v + m[5]) / z);
        if (x < -1 || y < -1 || x > w || y > h || x !== x || y !== y) return null;
        x = Math.max(0, Math.min(w - 1, x));
        y = Math.max(0, Math.min(h - 1, y));
        grid[r * dim + c] = bits[y * w + x];
      }
    }
    return grid;
  }


  /* ---- 5. reading the grid ------------------------------------------------------ */

  /* [check codewords per block, blocks, data codewords each, blocks, data codewords each]
     for levels L, M, Q, H. ISO/IEC 18004 table 9, versions 1-10. */
  var BLOCKS = [
    null,
    [[7, 1, 19, 0, 0], [10, 1, 16, 0, 0], [13, 1, 13, 0, 0], [17, 1, 9, 0, 0]],
    [[10, 1, 34, 0, 0], [16, 1, 28, 0, 0], [22, 1, 22, 0, 0], [28, 1, 16, 0, 0]],
    [[15, 1, 55, 0, 0], [26, 1, 44, 0, 0], [18, 2, 17, 0, 0], [22, 2, 13, 0, 0]],
    [[20, 1, 80, 0, 0], [18, 2, 32, 0, 0], [26, 2, 24, 0, 0], [16, 4, 9, 0, 0]],
    [[26, 1, 108, 0, 0], [24, 2, 43, 0, 0], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
    [[18, 2, 68, 0, 0], [16, 4, 27, 0, 0], [24, 4, 19, 0, 0], [28, 4, 15, 0, 0]],
    [[20, 2, 78, 0, 0], [18, 4, 31, 0, 0], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
    [[24, 2, 97, 0, 0], [22, 2, 38, 2, 39], [22, 4, 18, 2, 19], [26, 4, 14, 2, 15]],
    [[30, 2, 116, 0, 0], [22, 3, 36, 2, 37], [20, 4, 16, 4, 17], [24, 4, 12, 4, 13]],
    [[18, 2, 68, 2, 69], [26, 4, 43, 1, 44], [24, 6, 19, 2, 20], [28, 6, 15, 2, 16]]
  ];
  var ALIGN = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];
  var MAX_VERSION = 10;
  /* The two level bits are L=01 M=00 Q=11 H=10; BLOCKS is in the order L M Q H. */
  var LEVEL = [1, 0, 3, 2];

  var FORMATS = (function () {
    var out = [];
    for (var data = 0; data < 32; data++) {
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
      out.push(((data << 10) | rem) ^ 0x5412);
    }
    return out;
  })();
  var VERSIONS = (function () {
    var out = [];
    for (var v = 7; v <= 40; v++) {
      var rem = v;
      for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
      out.push({ version: v, code: (v << 12) | rem });
    }
    return out;
  })();

  function bitsSet(n) {
    var count = 0;
    while (n) { n &= n - 1; count++; }
    return count;
  }

  /* The format's five bits, read from either copy, or -1. */
  function readFormat(g, dim) {
    var a = 0, b = 0, i;
    for (i = 0; i <= 5; i++) a = (a << 1) | g[8 * dim + i];
    a = (a << 1) | g[8 * dim + 7];
    a = (a << 1) | g[8 * dim + 8];
    a = (a << 1) | g[7 * dim + 8];
    for (i = 5; i >= 0; i--) a = (a << 1) | g[i * dim + 8];
    for (i = dim - 1; i >= dim - 7; i--) b = (b << 1) | g[i * dim + 8];
    for (i = dim - 8; i < dim; i++) b = (b << 1) | g[8 * dim + i];
    var best = -1, bestDistance = 4;
    for (var d = 0; d < 32; d++) {
      var off = Math.min(bitsSet(a ^ FORMATS[d]), bitsSet(b ^ FORMATS[d]));
      if (off < bestDistance) { bestDistance = off; best = d; }
    }
    return best;
  }

  /* The version from either version block (version 7 up), or -1. */
  function readVersion(g, dim) {
    var a = 0, b = 0;
    for (var v = 17; v >= 0; v--) {
      var across = dim - 11 + (v % 3), down = Math.floor(v / 3);
      a = (a << 1) | g[down * dim + across];
      b = (b << 1) | g[across * dim + down];
    }
    var best = -1, bestDistance = 4;
    for (var i = 0; i < VERSIONS.length; i++) {
      var off = Math.min(bitsSet(a ^ VERSIONS[i].code), bitsSet(b ^ VERSIONS[i].code));
      if (off < bestDistance) { bestDistance = off; best = VERSIONS[i].version; }
    }
    return best;
  }

  function functionModules(version, dim) {
    var fn = new Uint8Array(dim * dim);
    function mark(r0, c0, rows, cols) {
      for (var r = r0; r < r0 + rows; r++) for (var c = c0; c < c0 + cols; c++) fn[r * dim + c] = 1;
    }
    mark(0, 0, 9, 9);
    mark(0, dim - 8, 9, 8);
    mark(dim - 8, 0, 8, 9);
    mark(6, 9, 1, dim - 17);
    mark(9, 6, dim - 17, 1);
    var pos = ALIGN[version], n = pos.length;
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        mark(pos[i] - 2, pos[j] - 2, 5, 5);
      }
    }
    if (version >= 7) {
      mark(0, dim - 11, 6, 3);
      mark(dim - 11, 0, 3, 6);
    }
    return fn;
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
  ];

  /* Two columns at a time from the right, up then down, skipping the timing column. */
  function readCodewords(g, fn, dim, mask) {
    var flip = MASKS[mask], out = [], current = 0, count = 0, up = true;
    for (var col = dim - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var k = 0; k < dim; k++) {
        var r = up ? dim - 1 - k : k;
        for (var s = 0; s < 2; s++) {
          var c = col - s;
          if (fn[r * dim + c]) continue;
          current = (current << 1) | (g[r * dim + c] ^ (flip(r, c) ? 1 : 0));
          if (++count === 8) { out.push(current); current = 0; count = 0; }
        }
      }
      up = !up;
    }
    return out;
  }


  /* ---- 6. Reed-Solomon over GF(256), x^8 + x^4 + x^3 + x^2 + 1 --------------- */

  var EXP = new Uint8Array(510), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 510; j++) EXP[j] = EXP[j - 255];
  })();
  function mul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
  function div(a, b) { return a ? EXP[LOG[a] + 255 - LOG[b]] : 0; }

  /* Lowest power first. */
  function evaluate(poly, x) {
    var y = 0;
    for (var i = poly.length - 1; i >= 0; i--) y = mul(y, x) ^ poly[i];
    return y;
  }

  function syndromes(cw, count) {
    var out = [], clean = true;
    for (var i = 0; i < count; i++) {
      var x = EXP[i], s = 0;
      for (var j = 0; j < cw.length; j++) s = mul(s, x) ^ cw[j];
      out.push(s);
      if (s) clean = false;
    }
    return clean ? null : out;
  }

  /* Corrects a block (data codewords, then check codewords) in place. False
     when it holds more errors than its check codewords can fix. */
  function correct(cw, ec) {
    var S = syndromes(cw, ec);
    if (!S) return true;
    var n = cw.length, i, j;

    /* Berlekamp-Massey: the error locator. */
    var C = [1], B = [1], L = 0, m = 1, b = 1;
    for (var r = 0; r < ec; r++) {
      var d = S[r];
      for (i = 1; i <= L; i++) d ^= mul(C[i] || 0, S[r - i]);
      if (d === 0) { m++; continue; }
      var coef = div(d, b), previous = C.slice();
      while (C.length < B.length + m) C.push(0);
      for (i = 0; i < B.length; i++) C[i + m] ^= mul(coef, B[i]);
      if (2 * L <= r) { L = r + 1 - L; B = previous; b = d; m = 1; }
      else m++;
    }
    if (2 * L > ec) return false;
    while (C.length < L + 1) C.push(0);
    C.length = L + 1;

    /* Chien search: where the errors are. */
    var powers = [];
    for (i = 0; i < n; i++) if (evaluate(C, EXP[(255 - i) % 255]) === 0) powers.push(i);
    if (powers.length !== L) return false;

    /* Forney: what they are. */
    var omega = [];
    for (i = 0; i < ec; i++) {
      var o = 0;
      for (j = 0; j <= i && j <= L; j++) o ^= mul(C[j], S[i - j]);
      omega.push(o);
    }
    var slope = [];
    for (i = 1; i <= L; i++) slope.push(i & 1 ? C[i] : 0);
    for (i = 0; i < powers.length; i++) {
      var inverse = EXP[(255 - powers[i]) % 255];
      var den = evaluate(slope, inverse);
      if (!den) return false;
      cw[n - 1 - powers[i]] ^= mul(EXP[powers[i]], div(evaluate(omega, inverse), den));
    }
    return !syndromes(cw, ec);
  }


  /* ---- 7. the data ------------------------------------------------------------ */

  var ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

  function utf8(bytes) {
    if (typeof TextDecoder === "function") {
      try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); } catch (e) { /* not UTF-8 */ }
    }
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function parse(data, version) {
    var total = data.length * 8, at = 0, text = "";
    var size = version < 10 ? 0 : 1;
    function read(n) {
      if (at + n > total) throw new RangeError("past the end");
      var v = 0;
      for (var i = 0; i < n; i++, at++) v = (v << 1) | ((data[at >> 3] >> (7 - (at & 7))) & 1);
      return v;
    }
    try {
      while (total - at >= 4) {
        var mode = read(4), count, v;
        if (mode === 0) break;
        if (mode === 1) {
          count = read([10, 12][size]);
          while (count >= 3) { v = read(10); if (v > 999) return null; text += ("00" + v).slice(-3); count -= 3; }
          if (count === 2) { v = read(7); if (v > 99) return null; text += ("0" + v).slice(-2); }
          else if (count === 1) { v = read(4); if (v > 9) return null; text += v; }
        } else if (mode === 2) {
          count = read([9, 11][size]);
          while (count >= 2) {
            v = read(11);
            if (Math.floor(v / 45) >= 45) return null;
            text += ALPHANUMERIC.charAt(Math.floor(v / 45)) + ALPHANUMERIC.charAt(v % 45);
            count -= 2;
          }
          if (count === 1) { v = read(6); if (v >= 45) return null; text += ALPHANUMERIC.charAt(v); }
        } else if (mode === 4) {
          count = read([8, 16][size]);
          var bytes = [];
          for (var i = 0; i < count; i++) bytes.push(read(8));
          text += utf8(bytes);
        } else if (mode === 7) {
          var first = read(8);
          if ((first & 0x80) === 0x80) read((first & 0xc0) === 0x80 ? 8 : 16);
        } else {
          return null;   /* kanji and structured append: never drawn by these pages */
        }
      }
    } catch (e) {
      return null;
    }
    return text;
  }

  function readGrid(g, dim) {
    var version = (dim - 17) / 4;
    var format = readFormat(g, dim);
    if (format < 0) return null;
    if (version >= 7 && readVersion(g, dim) !== version) return null;
    var spec = BLOCKS[version][LEVEL[format >> 3]];
    var codewords = readCodewords(g, functionModules(version, dim), dim, format & 7);

    var blocks = [], i, j;
    for (i = 0; i < spec[1]; i++) blocks.push({ size: spec[2], cw: [] });
    for (i = 0; i < spec[3]; i++) blocks.push({ size: spec[4], cw: [] });
    var p = 0, longest = Math.max(spec[2], spec[4]);
    for (i = 0; i < longest; i++) {
      for (j = 0; j < blocks.length; j++) if (i < blocks[j].size) blocks[j].cw.push(codewords[p++]);
    }
    for (i = 0; i < spec[0]; i++) {
      for (j = 0; j < blocks.length; j++) blocks[j].cw.push(codewords[p++]);
    }
    if (p > codewords.length) return null;

    var data = [];
    for (j = 0; j < blocks.length; j++) {
      if (!correct(blocks[j].cw, spec[0])) return null;
      for (i = 0; i < blocks[j].size; i++) data.push(blocks[j].cw[i]);
    }
    return parse(data, version);
  }


  /* ---- 8. putting it together ------------------------------------------------ */

  function readArrangement(bits, w, h, t) {
    var size = moduleSize(bits, w, h, t);
    if (!(size >= 1)) size = (t.tl.size + t.tr.size + t.bl.size) / 3;
    if (!(size >= 1)) return null;
    var guess = dimensionOf(t, size);
    var tries = [guess, guess + 4, guess - 4];
    for (var i = 0; i < tries.length; i++) {
      var dim = tries[i];
      if (dim < 21 || dim > 17 + 4 * MAX_VERSION) continue;
      var align = dim > 21 ? findAlignment(bits, w, h, t, size, dim) : null;
      var grid = sampleGrid(bits, w, h, gridTransform(t, align, dim), dim);
      var text = grid && readGrid(grid, dim);
      if (text !== null && text !== undefined && text !== false) return text;
      if (align) {
        grid = sampleGrid(bits, w, h, gridTransform(t, null, dim), dim);
        text = grid && readGrid(grid, dim);
        if (text !== null && text !== undefined && text !== false) return text;
      }
    }
    return null;
  }

  function decode(image) {
    try {
      if (!image || !image.data || !(image.width > 0) || !(image.height > 0)) return null;
      var w = image.width, h = image.height;
      var bits = binarize(luminance(image), w, h);
      var options = arrangements(findFinders(bits, w, h));
      for (var i = 0; i < options.length && i < 4; i++) {
        var text = readArrangement(bits, w, h, options[i]);
        if (text !== null) return text;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  root.QRRead = { decode: decode };
})(typeof window !== "undefined" ? window : globalThis);
