// 数据与树脂的单测（Node/Electron-as-node 运行，无需游戏）
//   1) data/*.json 的映射完整性（防止改了输入忘了重跑 build-maps）
//   2) lib/resin.js 的树脂参数构造
//   3) lib/inventory.js 的数量解释（-1 / -2 / 缺失）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Resin from '../lib/resin.js';
import { toCounts, COUNT_MISSING, COUNT_FAILED } from '../lib/inventory.js';
import { pickupDecision } from '../lib/env.js';

const D = fileURLToPath(new URL('../data/', import.meta.url)).replace(/[\\/]+$/, '');
const readJson = (name) => JSON.parse(fs.readFileSync(`${D}/${name}`, 'utf8'));
const readLines = (name) => fs.readFileSync(`${D}/${name}`, 'utf8')
  .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✔', name); }
  catch (e) { fail++; console.log('  ✘', name, '\n     ', e.message); }
};

console.log('== 数据映射');
const monsterMap = readJson('monster-map.json');
const bossMap = readJson('boss-map.json');
const materials = readJson('materials.json').materials;
const enemyDirs = new Set(readLines('_bgi-enemies.txt'));
const bossNames = new Set(readLines('_bgi-bosses.txt'));
const monsterMaterials = readLines('_monster-materials.txt');

t('每个怪物材料都有映射', () => {
  const missing = monsterMaterials.filter((n) => !monsterMap.map[n]?.enemy);
  assert.deepEqual(missing, [], '缺映射：' + missing.join('、'));
});
t('怪物材料清单与映射条目一一对应', () => {
  assert.equal(monsterMap.total, monsterMaterials.length);
  assert.equal(Object.keys(monsterMap.map).length, monsterMaterials.length);
  assert.equal(monsterMap.unresolved, 0);
});
t('所有怪物映射都指向 BGI 真实存在的敌人目录', () => {
  const bad = Object.entries(monsterMap.map)
    .filter(([, v]) => !enemyDirs.has(v.enemy))
    .map(([k, v]) => `${k}→${v.enemy}`);
  assert.deepEqual(bad, [], '不存在的敌人目录：' + bad.join('、'));
  const notExists = Object.entries(monsterMap.map).filter(([, v]) => v.exists !== true).map(([k]) => k);
  assert.deepEqual(notExists, [], 'exists 不为 true：' + notExists.join('、'));
});
t('没有 none 置信度的怪物映射', () => {
  const none = Object.entries(monsterMap.map).filter(([, v]) => v.confidence === 'none').map(([k]) => k);
  assert.deepEqual(none, []);
});

t('首领映射条目覆盖 materials.json 里的全部首领素材', () => {
  const bossKind = Object.entries(materials).filter(([, v]) => v.kind === 'boss').map(([k]) => k);
  assert.equal(bossMap.total, bossKind.length);
  for (const name of bossKind) assert.ok(bossMap.map[name], `缺少条目：${name}`);
});
t('已映射的首领都在 BGI 支持列表里', () => {
  const bad = Object.entries(bossMap.map)
    .filter(([, v]) => v.boss && !bossNames.has(v.boss))
    .map(([k, v]) => `${k}→${v.boss}`);
  assert.deepEqual(bad, [], 'BGI 不支持的首领：' + bad.join('、'));
});
t('未映射的首领素材都写明了原因', () => {
  const noReason = Object.entries(bossMap.map)
    .filter(([, v]) => !v.boss && !v.reason)
    .map(([k]) => k);
  assert.deepEqual(noReason, [], '缺原因：' + noReason.join('、'));
});
t('生成结果与输入同步（tools/build-maps.mjs 的输出格式）', () => {
  // 生成器会重写这两个文件；这里只校验它写入的结构字段没有丢失
  assert.equal(typeof monsterMap.enemyDirsAvailable, 'number');
  assert.equal(typeof bossMap.bossSupported, 'number');
  assert.equal(monsterMap.enemyDirsAvailable, enemyDirs.size);
  assert.equal(bossMap.bossSupported, bossNames.size);
});

console.log('== 树脂参数');
t('默认走「自动」：不指定树脂，交给 BGI 按现有树脂刷', () => {
  assert.deepEqual(Resin.domainResinFields(5, {}), { specifyResinUse: false });
});
t('允许脆弱树脂 → 指定优先级，浓缩→原粹→脆弱', () => {
  const f = Resin.domainResinFields(3, { allowFragileResin: true });
  assert.equal(f.specifyResinUse, true);
  assert.deepEqual(f.resinPriorityList, ['浓缩树脂', '原粹树脂', '脆弱树脂']);
  assert.equal(f.originalResinUseCount, 3);
  assert.equal(f.condensedResinUseCount, 3);
  assert.equal(f.fragileResinUseCount, 3);
  assert.equal(f.transientResinUseCount, undefined);
});
t('须臾树脂排在脆弱之前', () => {
  const f = Resin.domainResinFields(2, { allowFragileResin: true, useTransientResin: true });
  assert.deepEqual(f.resinPriorityList, ['浓缩树脂', '原粹树脂', '须臾树脂', '脆弱树脂']);
  assert.equal(f.transientResinUseCount, 2);
  assert.equal(f.fragileResinUseCount, 2);
});
t('只用须臾也要切到指定模式', () => {
  const f = Resin.domainResinFields(2, { useTransientResin: true });
  assert.equal(f.specifyResinUse, true);
  assert.deepEqual(f.resinPriorityList, ['浓缩树脂', '原粹树脂', '须臾树脂']);
});
t('轮数异常值归零', () => {
  for (const bad of [0, -3, NaN, undefined, null, 'x']) {
    const f = Resin.domainResinFields(bad, { allowFragileResin: true });
    assert.equal(f.originalResinUseCount, 0, `runs=${bad}`);
    assert.equal(f.condensedResinUseCount, 0, `runs=${bad}`);
  }
});
t('地脉花参数：次数 + 两个树脂开关', () => {
  const f = Resin.leylineResinFields(4, { allowFragileResin: true });
  assert.equal(f.count, 4);
  assert.equal(f.useFragileResin, true);
  assert.equal(f.useTransientResin, false);
  assert.equal(f.isResinExhaustionMode, false);
});
t('树脂策略说明可读', () => {
  assert.match(Resin.describeResinPolicy({}), /自动/);
  assert.match(Resin.describeResinPolicy({ allowFragileResin: true }), /脆弱/);
  assert.match(Resin.describeResinPolicy({ useTransientResin: true }), /须臾/);
});

console.log('== 背包数量解释');
t('缺失 = 背包里没有 = 0（不是识别失败）', () => {
  const r = toCounts(['A', 'B'], { A: 7 });
  assert.equal(r.counts.A, 7);
  assert.equal(r.counts.B, 0);
  assert.deepEqual(r.unknown, []);
});
t(`COUNT_MISSING(${COUNT_MISSING}) 视为 0`, () => {
  const r = toCounts(['A'], { A: COUNT_MISSING });
  assert.equal(r.counts.A, 0);
  assert.deepEqual(r.unknown, []);
});
t(`COUNT_FAILED(${COUNT_FAILED}) 记 unknown 且不当 0`, () => {
  const r = toCounts(['A'], { A: COUNT_FAILED });
  assert.equal(r.counts.A, null);
  assert.deepEqual(r.unknown, ['A']);
});
t('非数字也记 unknown', () => {
  const r = toCounts(['A'], { A: 'abc' });
  assert.equal(r.counts.A, null);
  assert.deepEqual(r.unknown, ['A']);
});
t('识别结果为空字典时全部记 0', () => {
  const r = toCounts(['A', 'B'], null);
  assert.deepEqual(r.counts, { A: 0, B: 0 });
});

console.log('== 拾取决策（NPC 对话不按 F）');
const W = ['薄荷', '霓裳花'];
t('目标材料 → 按', () => {
  assert.equal(pickupDecision('薄荷', W).press, true);
  assert.equal(pickupDecision('霓裳花', W).press, true);
  assert.equal(pickupDecision('薄荷（3）', W).press, true);
});
t('NPC 名字 → 不按', () => {
  for (const npc of ['凯瑟琳', '派蒙', '玛乔丽', '瓦格纳']) {
    assert.equal(pickupDecision(npc, W).press, false, npc);
    assert.equal(pickupDecision(npc, W).why, 'not-wanted');
  }
});
t('交互项（对话/商店/锻造…）一定不按，哪怕文字里含目标词', () => {
  for (const word of ['对话', '交谈', '商店', '锻造', '烹饪', '合成', '调查', '开启']) {
    assert.equal(pickupDecision(word, W).press, false, word);
    assert.equal(pickupDecision(word, W).why, 'interact');
  }
  assert.equal(pickupDecision('薄荷 对话', W).press, false, '黑名单优先于白名单');
  assert.equal(pickupDecision('锻造 霓裳花', W).press, false);
});
t('动作词（拾取/采集）→ 按', () => {
  assert.equal(pickupDecision('拾取', []).press, true);
  assert.equal(pickupDecision('采集', []).press, true);
});
t('读不到文字默认不按，显式允许才按', () => {
  assert.equal(pickupDecision('', W).press, false);
  assert.equal(pickupDecision('   ', W).press, false);
  assert.equal(pickupDecision('', W, true).press, true);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
