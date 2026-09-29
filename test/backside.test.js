'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Braille = require('../lib/braille');
const Panel = require('../lib/panel');
const EmbossPath = require('../lib/path');
const Backside = require('../lib/backside');

function layout() {
  return Braille.layout({ text: 'EXIT Door 2', plateWidth: 100, plateHeight: 50 });
}
function panel() {
  return Panel.packLabels({ labels: 'EXIT\nWOMEN\nMEN', plateWidth: 120, plateHeight: 80 });
}

test('单标签排版点集：沿板材竖直中线镜像，y 不变、x_back = W - x_front', () => {
  const lay = layout();
  assert.equal(lay.ok, true);
  const r = Backside.planBackside({ dots: lay.dots, plateWidth: 100, plateHeight: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.side, 'back');
  assert.equal(r.mode, 'layout');
  assert.equal(r.mirrorAxisX, 50);
  assert.equal(r.pointCount, lay.dots.length);
  assert.equal(r.labelCount, 0);
  r.dots.forEach((d, i) => {
    const f = lay.dots[i];
    assert.equal(d.seq, i + 1);                 // 保留原序号（1 基）
    assert.equal(d.label, null);
    assert.equal(d.frontX, f.x);
    assert.equal(d.frontY, f.y);
    assert.equal(d.x, Math.round((100 - f.x) * 1000) / 1000);
    assert.equal(d.backX, d.x);
    assert.equal(d.y, f.y);                      // 沿竖直中线镜像，y 不变
    assert.equal(d.backY, f.y);
    assert.equal(d.line, f.line);
    assert.equal(d.cell, f.cell);
    assert.equal(d.dot, f.dot);
  });
});

test('拼版点集：镜像后保留每点所属标签，mode=panel 且标签清单正确', () => {
  const pan = panel();
  assert.equal(pan.ok, true);
  const r = Backside.planBackside({ dots: pan.dots, plateWidth: 120, plateHeight: 80 });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'panel');
  assert.equal(r.pointCount, pan.dots.length);
  assert.deepEqual(r.stats.labels, [1, 2, 3]);
  assert.equal(r.labelCount, 3);
  r.dots.forEach((d, i) => {
    const f = pan.dots[i];
    assert.equal(d.label, f.label);
    assert.equal(d.seq, i + 1);
    assert.equal(d.x, Math.round((120 - f.x) * 1000) / 1000);
    assert.equal(d.y, f.y);
  });
});

test('镜像为对合（involution）：再次镜像回到正面坐标', () => {
  const lay = layout();
  const r = Backside.planBackside({ dots: lay.dots, plateWidth: 100, plateHeight: 50 });
  const again = Backside.planBackside({
    dots: r.dots.map(d => ({ x: d.x, y: d.y, label: d.label, r: d.r })),
    plateWidth: 100, plateHeight: 50
  });
  assert.equal(again.ok, true);
  again.dots.forEach((d, i) => {
    assert.ok(Math.abs(d.x - lay.dots[i].x) < 1e-9);
    assert.ok(Math.abs(d.y - lay.dots[i].y) < 1e-9);
  });
});

test('CSV：无路径时为 seq,label,front,back 六列；单标签 label 留空', () => {
  const lay = layout();
  const r = Backside.planBackside({ dots: lay.dots, plateWidth: 100, plateHeight: 50 });
  const lines = r.csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], 'seq,label,front_x_mm,front_y_mm,back_x_mm,back_y_mm');
  assert.equal(lines.length, lay.dots.length + 1);
  const f0 = lay.dots[0];
  assert.equal(lines[1], `1,,${f0.x},${f0.y},${Math.round((100 - f0.x) * 1000) / 1000},${f0.y}`);
});

test('CSV：拼版点 label 列为标签索引', () => {
  const pan = panel();
  const r = Backside.planBackside({ dots: pan.dots, plateWidth: 120, plateHeight: 80 });
  const lines = r.csv.replace(/^﻿/, '').split('\r\n');
  assert.match(lines[1], /^1,1,/);
  assert.ok(lines.slice(1).every(l => l.split(',').length === 6));
});

test('SVG：整板文档、镜像轴、每点 data-seq/背面坐标；拼版点带 data-label', () => {
  const lay = layout();
  const r = Backside.planBackside({ dots: lay.dots, plateWidth: 100, plateHeight: 50 });
  assert.match(r.svg, /<svg /);
  assert.match(r.svg, /data-side="back"/);
  assert.match(r.svg, /class="mirror-axis"/);
  assert.match(r.svg, /x1="50"/);
  assert.match(r.svg, /id="back-dots"/);
  assert.match(r.svg, /data-seq="1"/);
  assert.doesNotMatch(r.svg, /data-label="/);

  const pan = panel();
  const rp = Backside.planBackside({ dots: pan.dots, plateWidth: 120, plateHeight: 80 });
  assert.match(rp.svg, /data-mode="panel"/);
  assert.match(rp.svg, /data-label="1"/);
});

test('同时镜像压印路径：起点/落针 x 镜像、y 不变，step 顺序与空移长度保持', () => {
  const lay = layout();
  const p = EmbossPath.planPath({ dots: lay.dots, startX: 2, startY: 3, plateWidth: 100, plateHeight: 50 });
  assert.equal(p.ok, true);
  const r = Backside.planBackside({
    dots: lay.dots, plateWidth: 100, plateHeight: 50,
    path: { startX: 2, startY: 3, steps: p.steps }
  });
  assert.equal(r.ok, true);
  assert.equal(r.stats.withPath, true);
  assert.deepEqual([r.path.startX, r.path.startY], [98, 3]); // 起点镜像
  assert.deepEqual([r.path.frontStartX, r.path.frontStartY], [2, 3]);
  assert.equal(r.steps, r.path.steps);
  assert.equal(r.path.steps.length, p.steps.length);

  // step 顺序不变；原序号与正面坐标一一对应；落针 x 镜像、空移长度逐段相等
  let prevBack = { x: 98, y: 3 };
  r.path.steps.forEach((s, k) => {
    const orig = p.steps[k];
    assert.equal(s.step, orig.step);
    assert.equal(s.seq, orig.seq);
    assert.equal(s.label, orig.label);
    assert.equal(s.frontX, orig.x);
    assert.equal(s.frontY, orig.y);
    assert.ok(Math.abs(s.x - (100 - orig.x)) < 1e-9);
    assert.equal(s.y, orig.y);
    const dBack = Math.hypot(s.x - prevBack.x, s.y - prevBack.y);
    assert.ok(Math.abs(dBack - orig.travel_mm) < 0.002);
    prevBack = { x: s.x, y: s.y };
  });

  // 带路径 CSV 为 8 列且 travel 列保留
  const lines = r.csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], 'step,seq,label,front_x_mm,front_y_mm,back_x_mm,back_y_mm,travel_mm');
  assert.equal(lines.length, p.steps.length + 1);
  // SVG 绘制背面路线、起点与 step 序号
  assert.match(r.svg, /class="back-path"/);
  assert.match(r.svg, /id="back-arrow"/);
  assert.match(r.svg, /背面起点/);
  assert.match(r.svg, /data-step="1"/);
});

test('拼版路径镜像：每步保留标签，背面点数/步数与点集一致', () => {
  const pan = panel();
  const p = EmbossPath.planPath({ dots: pan.dots, startX: 1, startY: 1, plateWidth: 120, plateHeight: 80 });
  const r = Backside.planBackside({
    dots: pan.dots, plateWidth: 120, plateHeight: 80,
    path: { startX: 1, startY: 1, steps: p.steps }
  });
  assert.equal(r.ok, true);
  assert.equal(r.path.steps.length, pan.dots.length);
  r.path.steps.forEach((s, k) => {
    assert.equal(s.label, p.steps[k].label);
    assert.ok(Math.abs(s.x - (120 - p.steps[k].x)) < 1e-9);
  });
});

test('路径步数与点数不一致：整张背面作业无效，无任何部分图/文件', () => {
  const lay = layout();
  const p = EmbossPath.planPath({ dots: lay.dots, startX: 0, startY: 0 });
  const r = Backside.planBackside({
    dots: lay.dots, plateWidth: 100, plateHeight: 50,
    path: { startX: 0, startY: 0, steps: p.steps.slice(1) }
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].type, 'path-mismatch');
  assert.deepEqual(r.dots, []);
  assert.deepEqual(r.steps, []);
  assert.equal(r.path, null);
  assert.equal(r.svg, null);
  assert.equal(r.csv, null);
});

test('路径某步正面坐标与点集不符：path-mismatch 且定位到步/原序号', () => {
  const lay = layout();
  const p = EmbossPath.planPath({ dots: lay.dots, startX: 0, startY: 0 });
  const tampered = p.steps.map(s => Object.assign({}, s));
  tampered[1].x = tampered[1].x + 0.5;
  const r = Backside.planBackside({
    dots: lay.dots, plateWidth: 100, plateHeight: 50,
    path: { startX: 0, startY: 0, steps: tampered }
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].type, 'path-mismatch');
  assert.equal(r.errors[0].step, 2);
  assert.equal(r.errors[0].seq, tampered[1].seq);
  assert.equal(r.svg, null);
  assert.equal(r.csv, null);
});

test('路径原序号重复/越界：path-mismatch', () => {
  const lay = layout();
  const p = EmbossPath.planPath({ dots: lay.dots, startX: 0, startY: 0 });
  const dup = p.steps.map(s => Object.assign({}, s));
  dup[1].seq = dup[0].seq;
  // 同步把坐标改成该 seq 对应点，确保是“重复 seq”本身报错而非坐标先报
  const f0 = lay.dots[dup[0].seq - 1];
  dup[1].x = f0.x; dup[1].y = f0.y;
  const r = Backside.planBackside({
    dots: lay.dots, plateWidth: 100, plateHeight: 50,
    path: { startX: 0, startY: 0, steps: dup }
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].type, 'path-mismatch');
  assert.match(r.errors[0].message, /重复/);
});

test('路径标签归属与点集不一致：path-mismatch（防止串用其它点集的路径）', () => {
  const pan = panel();
  const p = EmbossPath.planPath({ dots: pan.dots, startX: 0, startY: 0 });
  const wrongLabel = p.steps.map(s => Object.assign({}, s));
  if (wrongLabel[0].label != null) wrongLabel[0].label = wrongLabel[0].label + 1;
  const r = Backside.planBackside({
    dots: pan.dots, plateWidth: 120, plateHeight: 80,
    path: { startX: 0, startY: 0, steps: wrongLabel }
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].type, 'path-mismatch');
});

test('路径缺少合法起点：path-mismatch', () => {
  const lay = layout();
  const p = EmbossPath.planPath({ dots: lay.dots, startX: 0, startY: 0 });
  const r = Backside.planBackside({
    dots: lay.dots, plateWidth: 100, plateHeight: 50,
    path: { startY: 0, steps: p.steps }
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].type, 'path-mismatch');
});

test('板材尺寸缺失或非正：明确报错，不输出部分图或文件', () => {
  const lay = layout();
  const noW = Backside.planBackside({ dots: lay.dots, plateHeight: 50 });
  assert.equal(noW.ok, false);
  assert.equal(noW.errors.some(e => e.field === 'plateWidth'), true);
  assert.equal(noW.svg, null);
  assert.equal(noW.csv, null);

  const negH = Backside.planBackside({ dots: lay.dots, plateWidth: 100, plateHeight: 0 });
  assert.equal(negH.ok, false);
  assert.equal(negH.errors.some(e => e.field === 'plateHeight'), true);
});

test('点中心超出板材：point-out-of-plate 且定位到第几个点', () => {
  const lay = layout();
  const dots = lay.dots.concat([{ x: 100.5, y: 5, r: 0.75 }]);
  const r = Backside.planBackside({ dots, plateWidth: 100, plateHeight: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].type, 'point-out-of-plate');
  assert.equal(r.errors[0].index, dots.length);
  assert.equal(r.svg, null);
  assert.deepEqual(r.dots, []);

  // 负坐标同样越界
  const r2 = Backside.planBackside({ dots: [{ x: -0.01, y: 5 }], plateWidth: 100, plateHeight: 50 });
  assert.equal(r2.ok, false);
  assert.equal(r2.errors[0].type, 'point-out-of-plate');
});

test('恰好落在板边（x=0 / x=W）视为界内，正常镜像', () => {
  const r = Backside.planBackside({
    dots: [{ x: 0, y: 5 }, { x: 100, y: 5 }],
    plateWidth: 100, plateHeight: 50
  });
  assert.equal(r.ok, true);
  assert.equal(r.dots[0].x, 100);
  assert.equal(r.dots[1].x, 0);
});

test('dots 缺失/为空/坐标非法：明确报错', () => {
  const none = Backside.planBackside({ plateWidth: 100, plateHeight: 50 });
  assert.equal(none.ok, false);
  const empty = Backside.planBackside({ dots: [], plateWidth: 100, plateHeight: 50 });
  assert.equal(empty.ok, false);
  const bad = Backside.planBackside({ dots: [{ x: 'x', y: 1 }], plateWidth: 100, plateHeight: 50 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /第 1 个凸点坐标非法/);
  [none, empty, bad].forEach(r => {
    assert.equal(r.svg, null);
    assert.equal(r.csv, null);
    assert.deepEqual(r.dots, []);
  });
});

test('超过 2000 点：报错且不输出', () => {
  const dots = Array.from({ length: 2001 }, (_, i) => ({ x: 1 + (i % 90) * 1.0, y: 1 + Math.floor(i / 90) * 2 }));
  const r = Backside.planBackside({ dots, plateWidth: 100, plateHeight: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].type, 'too-many-points');
});

test('同构：直接传入镜像点集作为 dots 与传入 layout.dots 的镜像结果坐标一致', () => {
  const lay = layout();
  const r1 = Backside.planBackside({ dots: lay.dots, plateWidth: 100, plateHeight: 50 });
  // 用 dots 超集字段（拼版风格但无 label）也应判为 layout 模式
  const dots = lay.dots.map(d => ({ x: d.x, y: d.y, r: d.r, line: d.line, cell: d.cell, dot: d.dot }));
  const r2 = Backside.planBackside({ dots, plateWidth: 100, plateHeight: 50 });
  assert.deepEqual(r1.dots.map(d => [d.x, d.y]), r2.dots.map(d => [d.x, d.y]));
});
