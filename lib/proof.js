/*
 * 印前校样核对（prepress proof）核心模块。
 * 同时供 Node 服务端与浏览器前端使用（UMD，依赖同一份 lib/braille.js 码表）。
 *
 * 用途：印前核对外部排版回传的六点盲文 Unicode 校样是否与设计英文标签一致。
 *   - 标准单元：复用 lib/braille.js 的 textToCells，按现有码表由原文生成
 *     （每个大写字母前的大写前缀 ⠠、连续数字段段首的数字前缀 ⠼ 都是独立单元，
 *     必须参与比较）；
 *   - 两侧“连续空白”（普通空白字符合并段、换行、盲文空白单元 ⠀ U+2800）
 *     一律折叠为一个词间空格单元（U+2800）再比较；
 *   - 比较按最少编辑（Levenshtein，缺失/多余/替换各计 1）对齐盲文单元，
 *     回溯按 对角 → 缺失 → 多余 的固定优先级决胜，重复单元的等价最优对齐稳定；
 *   - 差异依原输入位置（UTF-16 偏移，可直接用于前端选区定位）列出
 *     缺失（missing）/ 多余（extra）/ 替换（replace）及对应的标准单元；
 *   - 原文含未支持字符，或校样含非盲文字符 / 码表未收录点位时，逐处报告
 *     位置与原因，verdict 为 invalid：不给出“通过”结论，也不输出部分差异。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./braille'));
  } else {
    root.Proof = factory(root.Braille);
  }
})(typeof self !== 'undefined' ? self : this, function (Braille) {
  'use strict';

  var PROOF_MAX_LENGTH = 5000;

  var BRAILLE_BLANK_CHAR = Braille.dotsToUnicode([]);          // 词间空格 ⠀ U+2800
  var CAPS_UNICODE = Braille.dotsToUnicode(Braille.CAPITAL_SIGN); // 大写前缀 ⠠

  /* ---------------- 工具 ---------------- */

  function isBrailleChar(ch) {
    var cp = ch.charCodeAt(0);
    return cp >= 0x2800 && cp <= 0x28FF;
  }

  function unicodeToDots(ch) {
    var bits = ch.charCodeAt(0) - 0x2800;
    var dots = [];
    for (var n = 1; n <= 6; n++) {
      if (bits & (1 << (n - 1))) dots.push(n);
    }
    return dots;
  }

  function hexCodePoint(cp) {
    var h = cp.toString(16).toUpperCase();
    while (h.length < 4) h = '0' + h;
    return 'U+' + h;
  }

  // 校样侧“可比较”的盲文点位集合：现有码表全部字母/标点点位 + 大写前缀。
  // 数字复用 a–j 点位、数字前缀 ⠼ 与标点 # 同点位，均已包含在内。
  var SUPPORTED_PATTERNS = {};
  Object.keys(Braille.LETTERS).forEach(function (l) {
    SUPPORTED_PATTERNS[Braille.dotsToUnicode(Braille.LETTERS[l])] = { kind: 'letter', char: l };
  });
  Object.keys(Braille.PUNCT).forEach(function (p) {
    var u = Braille.dotsToUnicode(Braille.PUNCT[p]);
    if (!Object.prototype.hasOwnProperty.call(SUPPORTED_PATTERNS, u)) {
      SUPPORTED_PATTERNS[u] = { kind: 'punct', char: p };
    }
  });
  SUPPORTED_PATTERNS[CAPS_UNICODE] = { kind: 'caps-prefix', char: '' };

  function tokenView(index, t) {
    return {
      index: index,
      position: t.position,
      length: t.length,
      kind: t.kind,
      char: t.char,
      braille: t.braille,
      dots: t.dots
    };
  }

  /* ---------------- 原文侧：未支持字符逐处扫描（不做去重） ---------------- */

  function scanUnsupportedText(text) {
    var errors = [];
    var i = 0;
    while (i < text.length) {
      var code = text.charCodeAt(i);
      var ch = text.charAt(i);
      var step = 1;
      var cp = code;
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
        var low = text.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          ch += text.charAt(i + 1);
          cp = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
          step = 2;
        }
      }
      var supported = step === 1 &&
        (/\s/.test(ch) || /^[A-Za-z]$/.test(ch) || /^[0-9]$/.test(ch) ||
          Object.prototype.hasOwnProperty.call(Braille.PUNCT, ch));
      if (!supported) {
        errors.push({
          type: 'text-unsupported-char',
          side: 'text',
          position: i,
          length: step,
          char: ch,
          codePoint: hexCodePoint(cp),
          message: '原文位置 ' + i + ' 的字符 “' + ch + '”（' + hexCodePoint(cp) +
            '）不在支持范围内（仅支持 A–Z、a–z、0–9 及常用标点），无法生成标准盲文单元。'
        });
      }
      i += step;
    }
    return errors;
  }

  /* ---------------- 原文侧：标准单元（连续空白折叠为一个词间空格） ---------------- */

  function buildStandardTokens(text) {
    var conv = Braille.textToCells(text);
    var cells = conv.cells;
    var tokens = [];
    for (var k = 0; k < cells.length; k++) {
      var c = cells[k];
      if (c.kind === 'space') {
        var runStart = k;
        while (k < cells.length && cells[k].kind === 'space') k++;
        var runLen = k - runStart; // 折叠掉的连续空白单元数
        k--; // 外层 for 还会 +1
        tokens.push({
          position: cells[runStart].position,
          length: runLen,
          kind: 'space',
          char: ' ',
          braille: BRAILLE_BLANK_CHAR,
          dots: []
        });
        continue;
      }
      tokens.push({
        position: c.position,
        length: 1,
        kind: c.kind,
        char: (c.kind === 'caps-prefix' || c.kind === 'number-prefix') ? '' : c.char,
        braille: c.braille,
        dots: c.dots
      });
    }
    // 存在未支持字符时标准序列不完整：token 仍尽力返回供页面展示，但不参与对齐
    return tokens.map(function (t, idx) { return tokenView(idx, t); });
  }

  /* ---------------- 校样侧：逐单元切分 + 逐处非法字符/未收录点位 ---------------- */

  function buildProofTokens(input) {
    var tokens = [];
    var errors = [];
    var i = 0;

    function pushToken(t) {
      tokens.push({
        position: t.position,
        length: t.length,
        kind: t.kind,
        char: t.char,
        braille: t.braille,
        dots: t.dots
      });
    }

    while (i < input.length) {
      var code = input.charCodeAt(i);
      var ch = input.charAt(i);
      var step = 1;
      var cp = code;
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < input.length) {
        var low = input.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          ch += input.charAt(i + 1);
          cp = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
          step = 2;
        }
      }
      var position = i;

      // 1) 连续空白：普通空白字符合并段（空格/制表/换行…）与盲文空白单元 ⠀
      //    统一折叠为一个词间空格；混排（如 “ \n⠀ ”）也只算一个
      if ((step === 1 && /\s/.test(ch)) || ch === BRAILLE_BLANK_CHAR) {
        var start = i;
        while (i < input.length) {
          var c2 = input.charAt(i);
          if (/\s/.test(c2) || c2 === BRAILLE_BLANK_CHAR) i++;
          else break;
        }
        pushToken({
          position: start, length: i - start,
          kind: 'space', char: ' ', braille: BRAILLE_BLANK_CHAR, dots: []
        });
        continue;
      }

      // 2) 非盲文图案字符：无法按码表比较，逐处报错
      if (!isBrailleChar(ch)) {
        errors.push({
          type: 'proof-non-braille',
          side: 'proof',
          position: position,
          length: step,
          char: ch,
          codePoint: hexCodePoint(cp),
          message: '校样位置 ' + position + ' 的字符 “' + ch + '”（' + hexCodePoint(cp) +
            '）不是六点盲文图案字符（Unicode 区间 U+2800–U+28FF），无法与标准盲文单元比较。'
        });
        i += step;
        continue;
      }

      var dots = unicodeToDots(ch);
      var known = SUPPORTED_PATTERNS[ch];

      // 3) 盲文图案但码表未收录：逐处报错
      if (!known) {
        errors.push({
          type: 'proof-unknown-pattern',
          side: 'proof',
          position: position,
          length: 1,
          char: ch,
          codePoint: hexCodePoint(cp),
          dots: dots,
          message: '校样位置 ' + position + ' 的盲文单元 “' + ch + '”（' + hexCodePoint(cp) +
            '）点位为点 ' + dots.join('、') + '，现有字符表（A–Z、0–9 及常用标点）未收录该点位，无法与标准盲文单元比较。'
        });
        i += step;
        continue;
      }

      // 4) 已收录单元（a–j 与数字同点位，比较只看点位，标注按字母）
      pushToken({
        position: position, length: 1,
        kind: known.kind, char: known.char, braille: ch, dots: dots
      });
      i += step;
    }

    return {
      tokens: tokens.map(function (t, idx) { return tokenView(idx, t); }),
      errors: errors
    };
  }

  /* ---------------- 最少编辑对齐（Levenshtein，稳定回溯） ----------------
   * 代价：相等 0，替换 1，缺失（标准有/校样无）1，多余（校样有/标准无）1。
   * DP 按标准单元为行、校样单元为列填表；回溯固定优先 对角 → 缺失 → 多余，
   * 故重复单元存在多条等价最优对齐时结果仍唯一确定。
   */

  var OP_DIAG = 0, OP_MISSING = 1, OP_EXTRA = 2;

  function alignTokens(stdTokens, proofTokens) {
    var n = stdTokens.length;
    var m = proofTokens.length;
    var prev = new Array(m + 1);
    var cur = new Array(m + 1);
    var back = new Array(n + 1);
    for (var r = 0; r <= n; r++) back[r] = new Uint8Array(m + 1);

    prev[0] = 0;
    for (var j0 = 1; j0 <= m; j0++) {
      prev[j0] = j0;
      back[0][j0] = OP_EXTRA;
    }

    for (var i = 1; i <= n; i++) {
      cur[0] = i;
      back[i][0] = OP_MISSING;
      var sCell = stdTokens[i - 1];
      for (var j = 1; j <= m; j++) {
        var replaceCost = sCell.braille === proofTokens[j - 1].braille ? 0 : 1;
        var diagCost = prev[j - 1] + replaceCost;
        var missingCost = prev[j] + 1;
        var extraCost = cur[j - 1] + 1;
        var best = diagCost;
        var op = OP_DIAG;
        if (missingCost < best) { best = missingCost; op = OP_MISSING; }
        if (extraCost < best) { best = extraCost; op = OP_EXTRA; }
        cur[j] = best;
        back[i][j] = op;
      }
      var tmp = prev;
      prev = cur;
      cur = tmp;
    }

    // 回溯（从右下到左上后反转，输出顺序即标准单元输入位置顺序）
    var alignment = [];
    var ii = n, jj = m;
    while (ii > 0 || jj > 0) {
      var entry;
      if (ii > 0 && jj > 0 && back[ii][jj] === OP_DIAG) {
        var std = stdTokens[ii - 1];
        var prf = proofTokens[jj - 1];
        entry = std.braille === prf.braille
          ? { op: 'equal', standard: std, proof: prf }
          : { op: 'replace', standard: std, proof: prf };
        ii--; jj--;
      } else if (ii > 0 && (jj === 0 || back[ii][jj] === OP_MISSING)) {
        entry = { op: 'missing', standard: stdTokens[ii - 1], proof: null };
        ii--;
      } else {
        entry = { op: 'extra', standard: null, proof: proofTokens[jj - 1] };
        jj--;
      }
      alignment.push(entry);
    }
    alignment.reverse();

    var diffs = [];
    var counts = { equal: 0, missing: 0, extra: 0, replace: 0 };
    alignment.forEach(function (e) {
      counts[e.op]++;
      if (e.op === 'equal') return;
      if (e.op === 'missing') {
        diffs.push({
          type: 'missing',
          position: e.standard.position,
          length: e.standard.length,
          standard: e.standard,
          proof: null,
          message: '缺失：原文位置 ' + e.standard.position + ' 的标准单元 “' +
            e.standard.braille + '”（' + kindLabel(e.standard.kind) + '）在校样中缺失。'
        });
      } else if (e.op === 'extra') {
        diffs.push({
          type: 'extra',
          position: e.proof.position,
          length: e.proof.length,
          standard: null,
          proof: e.proof,
          message: '多余：校样位置 ' + e.proof.position + ' 的盲文单元 “' +
            e.proof.braille + '”（' + kindLabel(e.proof.kind) + '）在标准序列中没有对应单元。'
        });
      } else {
        diffs.push({
          type: 'replace',
          position: e.standard.position,
          length: e.standard.length,
          proofPosition: e.proof.position,
          proofLength: e.proof.length,
          standard: e.standard,
          proof: e.proof,
          message: '替换：原文位置 ' + e.standard.position + ' 的标准单元 “' +
            e.standard.braille + '”（' + kindLabel(e.standard.kind) +
            '）被校样位置 ' + e.proof.position + ' 的 “' + e.proof.braille + '”（' +
            kindLabel(e.proof.kind) + '）替换。'
        });
      }
    });

    return {
      alignment: alignment,
      diffs: diffs,
      editDistance: prev[m],
      counts: counts
    };
  }

  var KIND_LABELS = {
    'letter': '字母/数字点位',
    'digit': '数字',
    'punct': '标点',
    'caps-prefix': '大写前缀',
    'number-prefix': '数字前缀',
    'space': '词间空格'
  };

  function kindLabel(kind) { return KIND_LABELS[kind] || kind; }

  /* ---------------- 入口 ---------------- */

  function proofCompare(input) {
    input = input || {};
    var text = input.text;
    var proofText = input.braille != null ? input.braille : input.proof;

    var result = {
      ok: false,
      verdict: 'invalid', // pass | mismatch | invalid
      standard: {
        text: typeof text === 'string' ? text : '',
        tokens: null,
        brailleText: ''
      },
      proof: {
        text: typeof proofText === 'string' ? proofText : '',
        tokens: null
      },
      editDistance: null,
      diffs: null,
      alignment: null,
      stats: null,
      errors: []
    };

    if (typeof text !== 'string') {
      result.errors.push({ type: 'bad-input', side: 'text', position: null,
        message: '原文（text）必须是字符串。' });
    }
    if (typeof proofText !== 'string') {
      result.errors.push({ type: 'bad-input', side: 'proof', position: null,
        message: '盲文校样（braille）必须是字符串。' });
    }
    if (result.errors.length) return result;

    if (text.length > PROOF_MAX_LENGTH) {
      result.errors.push({ type: 'text-too-long', side: 'text', position: null,
        message: '原文超过 ' + PROOF_MAX_LENGTH + ' 字符上限。' });
    }
    if (proofText.length > PROOF_MAX_LENGTH) {
      result.errors.push({ type: 'proof-too-long', side: 'proof', position: null,
        message: '盲文校样超过 ' + PROOF_MAX_LENGTH + ' 字符上限。' });
    }
    if (result.errors.length) return result;

    // 原文侧未支持字符逐处报告
    var textErrors = scanUnsupportedText(text);
    result.errors.push.apply(result.errors, textErrors);

    // 标准单元（即便存在未支持字符也尽力返回，供页面展示；但不参与对齐）
    var stdTokens = buildStandardTokens(text);
    result.standard.tokens = stdTokens;
    result.standard.brailleText = stdTokens.map(function (t) { return t.braille; }).join('');

    // 校样侧切分与逐处非法字符/未收录点位
    var built = buildProofTokens(proofText);
    result.proof.tokens = built.tokens;
    result.errors.push.apply(result.errors, built.errors);

    // 任何一侧存在无法比较的字符：只逐处报错，不下结论、不输出部分差异
    if (result.errors.length) {
      result.verdict = 'invalid';
      result.ok = false;
      result.diffs = null;
      result.alignment = null;
      return result;
    }

    var aligned = alignTokens(stdTokens, built.tokens);
    var c = aligned.counts;

    result.alignment = aligned.alignment;
    result.diffs = aligned.diffs;
    result.editDistance = aligned.editDistance;
    result.stats = {
      standardCount: stdTokens.length,
      proofCount: built.tokens.length,
      equalCount: c.equal,
      missingCount: c.missing,
      extraCount: c.extra,
      replaceCount: c.replace,
      diffCount: aligned.diffs.length
    };
    result.verdict = aligned.diffs.length === 0 ? 'pass' : 'mismatch';
    result.ok = true;
    return result;
  }

  return {
    PROOF_MAX_LENGTH: PROOF_MAX_LENGTH,
    proofCompare: proofCompare
  };
});
