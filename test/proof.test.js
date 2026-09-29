'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Braille = require('../lib/braille');
const Proof = require('../lib/proof');

// 便捷：由原文生成标准盲文字符串（含前缀，空白为普通空格）
function stdBraille(text) {
  return Braille.textToCells(text).cells.map(c => c.braille).join('');
}

/* ---------- 通过与空白折叠 ---------- */

test('完全一致：往返标准盲文 -> verdict pass，编辑距离 0', () => {
  const text = 'EXIT Door 2';
  const r = Proof.proofCompare({ text: text, braille: stdBraille(text) });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.editDistance, 0);
  assert.deepEqual(r.diffs, []);
  assert.equal(r.stats.missingCount, 0);
  assert.equal(r.stats.extraCount, 0);
  assert.equal(r.stats.replaceCount, 0);
  assert.equal(r.stats.equalCount, r.standard.tokens.length);
});

test('两侧连续空白与换行均按一个词间空格比较：多种空白写法判通过', () => {
  const r1 = Proof.proofCompare({ text: 'a  b', braille: '⠁ ⠃' });        // 双空格 vs 单空格
  assert.equal(r1.verdict, 'pass');
  const r2 = Proof.proofCompare({ text: 'a\tb\nc', braille: '⠁\n⠃⠀⠉' }); // tab/换行/盲文空白混排
  assert.equal(r2.verdict, 'pass');
  const r3 = Proof.proofCompare({ text: '  a  ', braille: '\n⠁\n' });
  assert.equal(r3.verdict, 'pass');
  // 纯空白（折叠后各一个词间空格）相等
  assert.equal(Proof.proofCompare({ text: '   ', braille: '\n\t' }).verdict, 'pass');
  // 空白缺失/多余仍能检出
  assert.equal(Proof.proofCompare({ text: 'a b', braille: '⠁⠃' }).verdict, 'mismatch');
  assert.equal(Proof.proofCompare({ text: 'ab', braille: '⠁ ⠃' }).verdict, 'mismatch');
  assert.equal(Proof.proofCompare({ text: '  ', braille: '' }).verdict, 'mismatch');
});

test('空原文 + 空校样：通过', () => {
  const r = Proof.proofCompare({ text: '', braille: '' });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.stats.standardCount, 0);
  assert.equal(r.stats.proofCount, 0);
});

/* ---------- 大小写与数字前缀必须参与比较 ---------- */

test('大写前缀是独立比较单元：漏掉 ⠠ 报缺失（位置在对应字母处）', () => {
  const r = Proof.proofCompare({ text: 'Ab', braille: '⠁⠃' }); // 标准应为 ⠠⠁⠃
  assert.equal(r.verdict, 'mismatch');
  assert.equal(r.diffs.length, 1);
  assert.equal(r.diffs[0].type, 'missing');
  assert.equal(r.diffs[0].standard.kind, 'caps-prefix');
  assert.deepEqual(r.diffs[0].standard.dots, [6]);
  assert.equal(r.diffs[0].position, 0);
});

test('数字前缀是独立比较单元：漏掉 ⠼ 报缺失，段内数字点位仍逐个比较', () => {
  const r = Proof.proofCompare({ text: '12', braille: '⠁⠃' }); // 标准 ⠼⠁⠃
  assert.equal(r.verdict, 'mismatch');
  assert.equal(r.diffs.length, 1);
  assert.equal(r.diffs[0].type, 'missing');
  assert.equal(r.diffs[0].standard.kind, 'number-prefix');
  const ok = Proof.proofCompare({ text: '3.14', braille: stdBraille('3.14') });
  assert.equal(ok.verdict, 'pass');
});

test('多余的大写前缀报多余并给出校样位置', () => {
  const r = Proof.proofCompare({ text: 'ab', braille: '⠠⠁⠠⠃' });
  assert.equal(r.verdict, 'mismatch');
  assert.equal(r.diffs.filter(d => d.type === 'extra').length, 2);
  assert.deepEqual(r.diffs.map(d => d.proof.position), [0, 2]);
});

/* ---------- 缺失 / 多余 / 替换及标准单元 ---------- */

test('替换项同时给出标准单元与校样单元及双方位置', () => {
  const r = Proof.proofCompare({ text: 'abc', braille: '⠁⠭⠉' }); // b(⠃) -> x(⠭)
  assert.equal(r.verdict, 'mismatch');
  assert.equal(r.editDistance, 1);
  assert.equal(r.diffs.length, 1);
  const d = r.diffs[0];
  assert.equal(d.type, 'replace');
  assert.equal(d.position, 1);            // 原文 b 的位置
  assert.equal(d.proofPosition, 1);       // 校样 ⠭ 的位置
  assert.equal(d.standard.braille, '⠃');
  assert.equal(d.standard.char, 'b');
  assert.equal(d.proof.braille, '⠭');
});

test('缺失项依原文位置列出且带标准单元；多余项依校样位置列出', () => {
  const r = Proof.proofCompare({ text: 'ab', braille: '⠁' }); // 缺 b
  assert.equal(r.verdict, 'mismatch');
  assert.equal(r.editDistance, 1);
  const missing = r.diffs.filter(d => d.type === 'missing');
  assert.deepEqual(missing.map(d => d.position), [1]);
  assert.deepEqual(missing.map(d => d.standard.char), ['b']);
  assert.ok(missing.every(d => d.proof === null));

  const e = Proof.proofCompare({ text: 'ad', braille: '⠁⠃⠉⠙' }); // 中间多 b、c
  const extra = e.diffs.filter(d => d.type === 'extra');
  assert.deepEqual(extra.map(d => d.position), [1, 2]); // 校样输入位置
  assert.deepEqual(extra.map(d => d.proof.braille), ['⠃', '⠉']);
  assert.equal(extra[0].standard, null);
});
test('差异按原输入位置升序排列', () => {
  // 标准 a b c；校样 x b（缺 c 且 a 被替换为 x）
  const r = Proof.proofCompare({ text: 'abc', braille: '⠭⠃' });
  assert.equal(r.verdict, 'mismatch');
  const positions = r.diffs.map(d => d.position);
  const sorted = positions.slice().sort((p, q) => p - q);
  assert.deepEqual(positions, sorted);
});

test('空白折叠后标准空格单元记录折叠长度与起始位置', () => {
  const r = Proof.proofCompare({ text: 'a   b', braille: '⠁⠉' });
  const sp = r.standard.tokens.find(t => t.kind === 'space');
  assert.equal(sp.position, 1);
  assert.equal(sp.length, 3);
});

/* ---------- 重复单元的等价最优对齐稳定 ---------- */

test('重复单元：相同输入多次调用对齐完全一致（确定性）', () => {
  const payload = { text: 'aaaa', braille: '⠁⠁⠭' };
  const a = Proof.proofCompare(payload);
  const b = Proof.proofCompare(payload);
  assert.deepEqual(
    a.alignment.map(e => [e.op, e.standard ? e.standard.position : null, e.proof ? e.proof.position : null]),
    b.alignment.map(e => [e.op, e.standard ? e.standard.position : null, e.proof ? e.proof.position : null])
  );
  assert.deepEqual(a.diffs, b.diffs);
});

test('重复单元：对齐为最少编辑且结果稳定（对角优先：多出/缺失的重复单元绑定在最左位置）', () => {
  // 标准 a a a；校样 a x a：中间替换，编辑距离 1
  const r = Proof.proofCompare({ text: 'aaa', braille: '⠁⠭⠁' });
  assert.equal(r.editDistance, 1);
  assert.equal(r.diffs.length, 1);
  assert.equal(r.diffs[0].type, 'replace');
  assert.equal(r.diffs[0].position, 1);
  // 标准 a a；校样 a a a：多出的一个 a 稳定落在最左位置（对角优先回溯）
  const e = Proof.proofCompare({ text: 'aa', braille: '⠁⠁⠁' });
  assert.equal(e.editDistance, 1);
  assert.deepEqual(e.diffs.map(d => [d.type, d.position]), [['extra', 0]]);
  // 标准 a a a；校样 a a：缺失同样稳定落在最左
  const m = Proof.proofCompare({ text: 'aaa', braille: '⠁⠁' });
  assert.deepEqual(m.diffs.map(d => [d.type, d.position]), [['missing', 0]]);
});

test('编辑距离等于经典 Levenshtein 距离', () => {
  const cases = [
    ['kitten-ish', 'abcdef', '⠁⠭⠉⠙⠑⠋'], // 替换 1
    ['long', 'abcdefgh', '⠉⠙⠁⠃']
  ];
  cases.forEach(([name, text, br]) => {
    const r = Proof.proofCompare({ text: text, braille: br });
    assert.equal(r.verdict, 'mismatch', name);
    // 用通用 Levenshtein 在盲文点位字符序列（空白已折叠）上独立核算
    const a = r.standard.tokens.map(t => t.braille);
    const b = r.proof.tokens.map(t => t.braille);
    const dp = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : (j === 0 ? i : 0))));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1, dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    assert.equal(r.editDistance, dp[a.length][b.length], name);
  });
});

/* ---------- 非法输入：逐处报错，不下结论，不输出部分差异 ---------- */

test('原文含未支持字符：verdict invalid，逐处给位置/码点/原因，无 diffs 与通过结论', () => {
  const r = Proof.proofCompare({ text: 'a中b', braille: '⠁⠃' });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'invalid');
  assert.equal(r.diffs, null);
  assert.equal(r.alignment, null);
  assert.equal(r.editDistance, null);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].type, 'text-unsupported-char');
  assert.equal(r.errors[0].side, 'text');
  assert.equal(r.errors[0].position, 1);
  assert.equal(r.errors[0].codePoint, 'U+4E2D');
  assert.match(r.errors[0].message, /原文位置 1/);
  // 标准单元仍尽力返回（忽略未支持字符后的部分），但不参与对齐
  assert.ok(Array.isArray(r.standard.tokens));
});

test('原文中每一处未支持字符都报告（不去重）', () => {
  const r = Proof.proofCompare({ text: 'a©b©', braille: '⠁⠃' });
  const errs = r.errors.filter(e => e.type === 'text-unsupported-char');
  assert.equal(errs.length, 2);
  assert.deepEqual(errs.map(e => e.position), [1, 3]);
});

test('校样含非盲文字符：verdict invalid，逐处报位置/码点，不输出差异', () => {
  const r = Proof.proofCompare({ text: 'ab', braille: '⠁中⠃' });
  assert.equal(r.verdict, 'invalid');
  assert.equal(r.diffs, null);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].type, 'proof-non-braille');
  assert.equal(r.errors[0].side, 'proof');
  assert.equal(r.errors[0].position, 1);
  assert.equal(r.errors[0].codePoint, 'U+4E2D');
  assert.match(r.errors[0].message, /不是六点盲文图案字符/);
});

test('校样含码表未收录点位：verdict invalid，逐处报点位', () => {
  const r = Proof.proofCompare({ text: 'ab', braille: '⠁⠿⠃' });
  assert.equal(r.verdict, 'invalid');
  assert.equal(r.diffs, null);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].type, 'proof-unknown-pattern');
  assert.equal(r.errors[0].position, 1);
  assert.equal(r.errors[0].codePoint, 'U+283F');
  assert.deepEqual(r.errors[0].dots, [1, 2, 3, 4, 5, 6]);
  assert.match(r.errors[0].message, /未收录该点位/);
});

test('两侧都有非法字符时逐处全部报告，仍不给出结论', () => {
  const r = Proof.proofCompare({ text: 'a中', braille: 'b⠿' });
  assert.equal(r.verdict, 'invalid');
  assert.equal(r.diffs, null);
  assert.deepEqual(r.errors.map(e => e.type), ['text-unsupported-char', 'proof-non-braille', 'proof-unknown-pattern']);
});

test('非字符串输入与超长输入：明确报错类型', () => {
  assert.equal(Proof.proofCompare({ text: null, braille: '⠁' }).errors[0].type, 'bad-input');
  assert.equal(Proof.proofCompare({ text: 'a', braille: 123 }).errors[0].type, 'bad-input');
  assert.equal(Proof.proofCompare({ text: 'a'.repeat(Proof.PROOF_MAX_LENGTH + 1), braille: '⠁' }).errors[0].type,
    'text-too-long');
  assert.equal(Proof.proofCompare({ text: 'a', braille: '⠁'.repeat(Proof.PROOF_MAX_LENGTH + 1) }).errors[0].type,
    'proof-too-long');
});

test('字段名 proof 兼容 braille', () => {
  const r = Proof.proofCompare({ text: 'ab', proof: '⠁⠃' });
  assert.equal(r.verdict, 'pass');
});

test('校样逐单元位置即原输入 UTF-16 偏移，可供前端选区定位', () => {
  const r = Proof.proofCompare({ text: 'ab', braille: '⠁ ⠃' });
  assert.equal(r.proof.tokens[0].position, 0);
  assert.equal(r.proof.tokens[1].kind, 'space');
  assert.equal(r.proof.tokens[1].position, 1);
  assert.equal(r.proof.tokens[1].length, 1);
  assert.equal(r.proof.tokens[2].position, 2);
});
