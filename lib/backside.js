/*
 * 背面压印（Back-Side Embossing）核心模块。
 * 同时供 Node 服务端与浏览器前端使用（UMD）。
 *
 * 板材从背面压印时，正面排版图的点位不能直接交给压印机：把最近一次成功的
 * 单标签排版 / 多标签拼版点集沿板材竖直中线镜像，得到以板材左上角为原点的
 * 背面点位图（背面坐标系与正面一致：原点仍在“板材左上角”，x 向右、y 向下）。
 *
 * 镜像规则（单位均为毫米 mm）：
 *   x_back = plateWidth  - x_front
 *   y_back = plateHeight 方向不变：y_back = y_front
 * 每个背面点保留：所属标签 label（单标签排版为 null）、原序号 seq（输入 dots
 * 的 1 基下标）以及正面坐标，便于逐点核对。
 *
 * 若同时选用“由该点集生成的压印路径”（/api/path 的 steps）：
 *   - 起点与每个落针坐标同样做 x 方向镜像，step 顺序与各步空移长度保持不变
 *    （镜像为刚体反射，等距变换，空移长度恒等，本模块仍逐段复核）；
 *   - 路径的原序号 seq 与正面坐标 (x,y) 必须与所选点集一一对应：
 *     steps 数量 = 点数、seq 为 1..n 的排列、每个 step 的正面坐标与点集中
 *     seq 对应点严格一致；任何错配整张背面作业无效，绝不输出部分图或文件。
 *
 * 板材尺寸缺失/非正、点中心超出板材、路径错配时 ok=false 且
 * dots/steps/svg/csv 全部为空。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Backside = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 常量 ---------------- */

  var MAX_POINTS = 2000; // 与压印路径一致的点数上限，拒绝异常输入
  var EPS = 1e-6;        // 点中心“超出板材”的判定阈值（mm；坐标为 0.001mm 的整数倍）
  var COORD_EPS = 1e-6;  // 路径正面坐标与点集一致性的判定阈值（mm）

  /* ---------------- 工具 ---------------- */

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function fail(base, errors) {
    base.ok = false;
    base.errors = errors;
    base.dots = [];
    base.steps = [];
    base.stats = null;
    base.svg = null;
    base.csv = null;
    if (base.path) base.path = null;
    return base;
  }

  /* ---------------- 输入校验与点集镜像 ---------------- */

  function mirrorDots(input) {
    var errors = [];
    var W = num(input.plateWidth);
    var H = num(input.plateHeight);
    if (!(W > 0)) errors.push({ type: 'param', field: 'plateWidth', message: '缺少板材宽度或板材宽度必须为正数（mm），背面镜像需要沿板材竖直中线定位。' });
    if (!(H > 0)) errors.push({ type: 'param', field: 'plateHeight', message: '缺少板材高度或板材高度必须为正数（mm），背面点位图需要板材幅面。' });

    var raw = input.dots;
    if (!Array.isArray(raw)) {
      errors.push({ type: 'param', field: 'dots', message: '缺少 dots 凸点数据（必须为最近一次成功的单标签排版或拼版结果的凸点数组）。' });
    } else if (raw.length === 0) {
      errors.push({ type: 'param', field: 'dots', message: '所选点集没有任何凸点，无法生成背面点位图；请先完成一次成功的排版或拼版。' });
    } else if (raw.length > MAX_POINTS) {
      errors.push({
        type: 'too-many-points',
        message: '凸点数量为 ' + raw.length + ' 个，超过单次背面作业 ' + MAX_POINTS + ' 个上限。'
      });
    }
    if (errors.length) return { errors: errors };

    var points = new Array(raw.length);
    for (var i = 0; i < raw.length; i++) {
      var d = raw[i] || {};
      var x = num(d.x), y = num(d.y);
      if (!isFinite(x) || !isFinite(y)) {
        errors.push({
          type: 'param',
          field: 'dots',
          index: i + 1,
          message: '第 ' + (i + 1) + ' 个凸点坐标非法（x=' + d.x + '，y=' + d.y +
            '），请重新排版/拼版后再生成背面点位图。'
        });
        return { errors: errors };
      }
      // 点中心超出板材（允许 COORD_EPS 数值容差）：正面点不可能在板外，出现即视为点集/板材错配
      if (x < -EPS || x > W + EPS || y < -EPS || y > H + EPS) {
        errors.push({
          type: 'point-out-of-plate',
          index: i + 1,
          x: round3(x),
          y: round3(y),
          plateWidth: W,
          plateHeight: H,
          message: '第 ' + (i + 1) + ' 个凸点中心（' + round3(x) + ', ' + round3(y) +
            ' mm）超出板材 ' + W + ' × ' + H + ' mm，所选点集与板材尺寸不匹配，不能生成背面点位图。'
        });
        return { errors: errors };
      }
      var label = num(d.label);
      points[i] = {
        seq: i + 1,                       // 原序号（1 基，即输入 dots 下标 + 1）
        label: isFinite(label) ? Math.trunc(label) : null, // 拼版点带标签索引；单标签点为 null
        frontX: round3(x),
        frontY: round3(y),
        backX: round3(W - x),
        backY: round3(y),
        r: isFinite(num(d.r)) && num(d.r) > 0 ? num(d.r) : null,
        line: d.line,
        cell: d.cell,
        dot: d.dot
      };
    }
    return { points: points, errors: errors, plateWidth: W, plateHeight: H };
  }

  /* ---------------- 压印路径校验与镜像 ----------------
   * 严格要求 path.steps 与点集一一对应：
   *   ① steps 数量 = 点数；
   *   ② 每个 step.seq 为 1..n 内整数且互不重复（构成排列）；
   *   ③ 每个 step 的正面坐标 (x,y) 与点集中 seq 对应点严格一致。
   * 任一不满足返回错误，整张背面作业无效。
   */
  function mirrorPath(points, plateWidth, pathInput) {
    var errors = [];
    var n = points.length;

    var startX = num(pathInput.startX);
    var startY = num(pathInput.startY);
    if (!isFinite(startX)) errors.push({ type: 'path-mismatch', field: 'startX', message: '所选压印路径缺少合法起点 X 坐标（startX）。' });
    if (!isFinite(startY)) errors.push({ type: 'path-mismatch', field: 'startY', message: '所选压印路径缺少合法起点 Y 坐标（startY）。' });

    var rawSteps = pathInput.steps;
    if (!Array.isArray(rawSteps)) {
      errors.push({ type: 'path-mismatch', field: 'steps', message: '所选压印路径缺少 steps 作业步骤，无法镜像为背面路径。' });
      return { errors: errors };
    }
    if (rawSteps.length !== n) {
      errors.push({
        type: 'path-mismatch',
        message: '压印路径步数（' + rawSteps.length + '）与所选点集凸点数（' + n +
          '）不一致：该路径不是由当前所选点集生成，整张背面作业无效。'
      });
      return { errors: errors };
    }

    var bySeq = new Array(n + 1); // seq(1..n) -> 点
    points.forEach(function (p) { bySeq[p.seq] = p; });
    var seen = new Uint8Array(n + 1);
    var backSteps = new Array(n);

    for (var k = 0; k < n; k++) {
      var st = rawSteps[k] || {};
      var seq = num(st.seq);
      if (!isFinite(seq) || Math.floor(seq) !== seq || seq < 1 || seq > n) {
        errors.push({
          type: 'path-mismatch',
          step: k + 1,
          message: '路径第 ' + (k + 1) + ' 步的原序号 seq=' + st.seq +
            ' 超出 1..' + n + ' 范围，路径与所选点集错配，整张背面作业无效。'
        });
        return { errors: errors };
      }
      if (seen[seq]) {
        errors.push({
          type: 'path-mismatch',
          step: k + 1,
          message: '原序号 ' + seq + ' 在路径中重复出现（第 ' + (k + 1) +
            ' 步），路径不是凸点的合法排列，整张背面作业无效。'
        });
        return { errors: errors };
      }
      seen[seq] = 1;

      var p = bySeq[seq];
      var sx = num(st.x), sy = num(st.y);
      if (!isFinite(sx) || !isFinite(sy) ||
        Math.abs(sx - p.frontX) > COORD_EPS || Math.abs(sy - p.frontY) > COORD_EPS) {
        errors.push({
          type: 'path-mismatch',
          step: k + 1,
          seq: seq,
          message: '路径第 ' + (k + 1) + ' 步（原序号 ' + seq + '）的正面坐标（' +
            st.x + ', ' + st.y + '）与点集中该点正面坐标（' + p.frontX + ', ' + p.frontY +
            '）不一致：路径不是由当前所选点集生成，整张背面作业无效。'
        });
        return { errors: errors };
      }

      // 标签也必须一致（防止同坐标不同归属的拼版点串用路径）
      var stLabel = num(st.label);
      var stepLabel = isFinite(stLabel) ? Math.trunc(stLabel) : null;
      if (stepLabel !== p.label) {
        errors.push({
          type: 'path-mismatch',
          step: k + 1,
          seq: seq,
          message: '路径第 ' + (k + 1) + ' 步（原序号 ' + seq + '）的标签归属 label=' +
            (stepLabel == null ? '空' : stepLabel) + ' 与点集（' +
            (p.label == null ? '空' : p.label) + '）不一致，整张背面作业无效。'
        });
        return { errors: errors };
      }

      var travel = num(st.travel_mm);
      backSteps[k] = {
        step: k + 1,
        label: p.label,
        seq: p.seq,
        frontX: p.frontX,
        frontY: p.frontY,
        x: p.backX,
        y: p.backY,
        travel_mm: isFinite(travel) && travel >= 0 ? round3(travel) : null
      };
    }
    for (var s2 = 1; s2 <= n; s2++) {
      if (!seen[s2]) {
        errors.push({
          type: 'path-mismatch',
          message: '原序号 ' + s2 + ' 未在路径中出现，路径未覆盖所选点集的全部凸点，整张背面作业无效。'
        });
        return { errors: errors };
      }
    }

    // 复核各步空移长度：镜像为等距反射，背面相邻落针距离必须与正面逐段相同
    for (var k2 = 0; k2 < n; k2++) {
      var bs = backSteps[k2];
      var px = k2 === 0 ? startX : backSteps[k2 - 1].frontX;
      var py = k2 === 0 ? startY : backSteps[k2 - 1].frontY;
      var frontDist = Math.hypot(bs.frontX - px, bs.frontY - py);
      var bpx = k2 === 0 ? plateWidth - startX : backSteps[k2 - 1].x;
      var bpy = k2 === 0 ? startY : backSteps[k2 - 1].y;
      var backDist = Math.hypot(bs.x - bpx, bs.y - bpy);
      if (Math.abs(frontDist - backDist) > EPS) {
        errors.push({
          type: 'path-mismatch',
          step: k2 + 1,
          message: '镜像后第 ' + (k2 + 1) + ' 步空移长度（' + round3(backDist) +
            ' mm）与正面（' + round3(frontDist) + ' mm）不一致，背面作业无效。'
        });
        return { errors: errors };
      }
      // 若原路径给了 travel_mm，核对它与正面几何一致
      if (bs.travel_mm != null && Math.abs(bs.travel_mm - round3(frontDist)) > 0.01) {
        errors.push({
          type: 'path-mismatch',
          step: k2 + 1,
          message: '路径第 ' + (k2 + 1) + ' 步声明的空移 travel_mm=' + bs.travel_mm +
            ' 与其正面坐标几何长度 ' + round3(frontDist) + ' mm 不符，整张背面作业无效。'
        });
        return { errors: errors };
      }
    }

    return {
      errors: errors,
      backSteps: backSteps,
      backStartX: round3(plateWidth - startX),
      backStartY: round3(startY),
      frontStartX: round3(startX),
      frontStartY: round3(startY)
    };
  }

  /* ---------------- CSV ---------------- */

  function buildCsv(points, hasPath, backSteps) {
    if (hasPath) {
      var rows = ['step,seq,label,front_x_mm,front_y_mm,back_x_mm,back_y_mm,travel_mm'];
      backSteps.forEach(function (s) {
        rows.push([
          s.step, s.seq, s.label == null ? '' : s.label,
          s.frontX, s.frontY, s.x, s.y, s.travel_mm == null ? '' : s.travel_mm
        ].map(csvCell).join(','));
      });
      return '\uFEFF' + rows.join('\r\n');
    }
    var rows2 = ['seq,label,front_x_mm,front_y_mm,back_x_mm,back_y_mm'];
    points.forEach(function (p) {
      rows2.push([
        p.seq, p.label == null ? '' : p.label,
        p.frontX, p.frontY, p.backX, p.backY
      ].map(csvCell).join(','));
    });
    return '\uFEFF' + rows2.join('\r\n');
  }

  /* ---------------- SVG ---------------- */

  function buildSvg(points, W, H, mode, hasPath, mirror) {
    var out = [];
    var midX = round3(W / 2);
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" ' +
      'viewBox="0 0 ' + W + ' ' + H + '" data-unit="mm" data-side="back" data-mode="' + mode +
      '" data-point-count="' + points.length + '" data-has-path="' + (hasPath ? '1' : '0') + '">');
    out.push('  <!-- 背面压印点位图：沿板材竖直中线 x=' + midX + ' 镜像；背面坐标以板材左上角为原点，' +
      'x_back=' + W + '-x_front，y 不变；每点保留所属标签与原序号 -->');
    out.push('  <rect id="plate" x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff" stroke="#333333" stroke-width="0.3"/>');
    out.push('  <line class="mirror-axis" x1="' + midX + '" y1="0" x2="' + midX + '" y2="' + H +
      '" stroke="#16a34a" stroke-width="0.15" stroke-dasharray="1.5 1"/>');
    out.push('  <text x="' + round3(midX + 1) + '" y="' + round3(H - 1) + '" font-size="2" fill="#166534" ' +
      'pointer-events="none">镜像轴（板材竖直中线）</text>');

    if (hasPath) {
      // 背面作业路线（蓝色实线 + 箭头），顶点顺序即压印 step
      var d = '';
      mirror.backSteps.forEach(function (s, k) {
        d += (k === 0 ? 'M' : 'L') + s.x + ' ' + s.y;
      });
      out.push('  <defs>');
      out.push('    <marker id="back-arrow" viewBox="0 0 4 4" refX="3.2" refY="2" markerWidth="4" markerHeight="4" ' +
        'markerUnits="userSpaceOnUse" orient="auto-start-reverse">');
      out.push('      <path d="M0,0 L4,2 L0,4 z" fill="#2563eb"/>');
      out.push('    </marker>');
      out.push('  </defs>');
      out.push('  <path class="back-path" d="' + d + '" fill="none" stroke="#2563eb" stroke-width="0.3" ' +
        'marker-mid="url(#back-arrow)" marker-end="url(#back-arrow)"/>');
      // 镜像后的背面起点：绿色三角
      var sx = mirror.backStartX, sy = mirror.backStartY;
      out.push('  <g class="back-start">');
      out.push('    <path d="M' + sx + ' ' + round3(sy - 1.1) + ' L' + round3(sx + 1) + ' ' +
        round3(sy + 0.7) + ' L' + round3(sx - 1) + ' ' + round3(sy + 0.7) + ' z" ' +
        'fill="#16a34a" stroke="#14532d" stroke-width="0.15"/>');
      out.push('    <text x="' + round3(sx + 1.3) + '" y="' + round3(sy - 1) + '" font-size="1.8" ' +
        'fill="#166534" pointer-events="none">背面起点</text>');
      out.push('  </g>');
    }

    out.push('  <g id="back-dots" fill="#111111">');
    points.forEach(function (p) {
      var labelAttr = p.label == null ? '' : ' data-label="' + p.label + '"';
      out.push('    <circle cx="' + p.backX + '" cy="' + p.backY + '" r="' + (p.r != null ? round3(p.r) : 0.75) +
        '" data-seq="' + p.seq + '"' + labelAttr + '><title>原序号 ' + p.seq +
        (p.label != null ? '（标签 #' + p.label + '）' : '') + '；正面 (' + p.frontX + ', ' + p.frontY +
        ') → 背面 (' + p.backX + ', ' + p.backY + ')</title></circle>');
    });
    out.push('  </g>');

    if (hasPath) {
      // step 序号叠加（放在凸点右上方），首点绿圈、末点橙圈
      var n = mirror.backSteps.length;
      mirror.backSteps.forEach(function (s, k) {
        var ring = k === 0 ? '#16a34a' : (k === n - 1 ? '#d97706' : null);
        var labelAttr2 = s.label == null ? '' : ' data-label="' + s.label + '"';
        out.push('  <g class="back-stop" data-step="' + s.step + '" data-seq="' + s.seq + '"' + labelAttr2 + '>');
        out.push('    <circle cx="' + s.x + '" cy="' + s.y + '" r="1.05" fill="none"' +
          (ring ? ' stroke="' + ring + '" stroke-width="0.35"' : '') + '/>');
        out.push('    <text x="' + round3(s.x + 1.3) + '" y="' + round3(s.y - 1.1) +
          '" font-size="1.6" text-anchor="start" fill="#1e3a8a" pointer-events="none">' + s.step + '</text>');
        out.push('  </g>');
      });
    }

    out.push('</svg>');
    return out.join('\n');
  }

  /* ---------------- 主入口 ---------------- */

  function planBackside(input) {
    input = input || {};

    var base = {
      ok: false,
      errors: [],
      side: 'back',
      mode: null,          // 'layout'（单标签）| 'panel'（拼版）
      plateWidth: null,
      plateHeight: null,
      mirrorAxisX: null,   // 镜像轴 x = 板宽之半
      pointCount: 0,
      labelCount: 0,
      dots: [],
      path: null,          // 提供且校验通过时：{ startX, startY, frontStartX, frontStartY, steps }
      steps: [],           // = path.steps（无路径时为空）
      stats: null,
      svg: null,
      csv: null
    };

    var mirrored = mirrorDots(input);
    if (mirrored.errors.length) return fail(base, mirrored.errors);
    var points = mirrored.points;
    var W = mirrored.plateWidth, H = mirrored.plateHeight;

    // 模式：点带 label 元数据即视为拼版结果，否则为单标签排版
    var mode = 'layout';
    var labelSet = Object.create(null);
    var labelCount = 0;
    points.forEach(function (p) {
      if (p.label != null && !labelSet[p.label]) { labelSet[p.label] = true; labelCount++; }
    });
    if (labelCount > 0) mode = 'panel';

    // 可选：同时镜像由该点集生成的压印路径（错配即整张作业无效）
    var hasPath = false;
    var mirror = null;
    if (input.path != null) {
      var mr = mirrorPath(points, W, input.path);
      if (mr.errors.length) return fail(base, mr.errors);
      mirror = mr;
      hasPath = true;
    }

    var labelList = Object.keys(labelSet).map(Number).sort(function (a, b) { return a - b; });
    base.ok = true;
    base.errors = [];
    base.mode = mode;
    base.plateWidth = W;
    base.plateHeight = H;
    base.mirrorAxisX = round3(W / 2);
    base.pointCount = points.length;
    base.labelCount = labelCount;
    base.dots = points.map(function (p) {
      return {
        seq: p.seq,
        label: p.label,
        frontX: p.frontX,
        frontY: p.frontY,
        x: p.backX,
        y: p.backY,
        backX: p.backX,
        backY: p.backY,
        r: p.r,
        line: p.line,
        cell: p.cell,
        dot: p.dot
      };
    });
    if (hasPath) {
      base.path = {
        frontStartX: mirror.frontStartX,
        frontStartY: mirror.frontStartY,
        startX: mirror.backStartX,
        startY: mirror.backStartY,
        steps: mirror.backSteps
      };
      base.steps = mirror.backSteps;
    }
    base.stats = {
      pointCount: points.length,
      labelCount: labelCount,
      labels: labelList,
      plateWidth: W,
      plateHeight: H,
      mirrorAxisX: round3(W / 2),
      withPath: hasPath
    };
    base.svg = buildSvg(points, W, H, mode, hasPath, mirror);
    base.csv = buildCsv(points, hasPath, hasPath ? mirror.backSteps : null);
    return base;
  }

  return {
    MAX_POINTS: MAX_POINTS,
    planBackside: planBackside
  };
});
