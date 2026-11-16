// tools/build-maps.mjs —— 生成 data/monster-map.json 与 data/boss-map.json
//
// 设计：输出的两个 JSON 完全由 data/ 下的输入推导，不手改；要补映射就改输入文件。
//   data/_drop-tables.txt     敌人 → 掉落材料（主源，来自吉吉喵《背包材料统计》）
//   data/monster-map-wiki.json 材料 → 敌人候选（bwiki）
//   data/boss-map-wiki.json    素材 → 首领候选（bwiki / 3DM 汇总）
//   data/_manual-maps.json     人工确认（优先级最高）
//   data/_enemy-aliases.json   掉落表里的敌人名 → BGI 实际目录名
//   data/_bgi-enemies.txt      BGI「敌人与魔物」目录快照（57）
//   data/_bgi-bosses.txt       BGI 自动首领快照（44）
//   data/_monster-materials.txt 需要打怪的全部怪物材料（156）
//
// 用法（本机没有 node，用 DSH 自带 Electron 当 Node）：
//   ELECTRON_RUN_AS_NODE=1 "C:/a.funna/DSH/DSH Desktop/DSH Desktop.exe" tools/build-maps.mjs
//   ... build-maps.mjs --check    # 只校验，输出会变则以非 0 退出（供单测/CI 用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => path.join(ROOT, p);
const CHECK_ONLY = process.argv.includes('--check');

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(at(p), 'utf8')); }
  catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`读取 ${p} 失败：${e.message}`);
  }
};
const readLines = (p) => fs.readFileSync(at(p), 'utf8')
  .split(/\r?\n/).map((s) => s.replace(/\s+$/, '').trim())
  .filter((s) => s && !s.startsWith('#'));
const writeText = (p, text) => {
  const before = fs.existsSync(at(p)) ? fs.readFileSync(at(p), 'utf8') : null;
  if (before === text) return false;
  if (!CHECK_ONLY) fs.writeFileSync(at(p), text, 'utf8');
  return true;
};
const sortKeys = (obj) => {
  const out = {};
  for (const k of Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = obj[k];
  return out;
};
// 与现有文件风格一致：1 空格缩进
const toJson = (obj) => JSON.stringify(obj, null, 1) + '\n';

/** 解析「敌人：材料，材料」掉落表 */
function parseDropTable() {
  const map = {}; // 材料 → [敌人]
  for (const line of readLines('data/_drop-tables.txt')) {
    const m = line.match(/^(.+?)[：:](.+)$/);
    if (!m) continue;
    const enemies = m[1].split(/[/／]/).map((s) => s.trim()).filter(Boolean);
    for (const raw of m[2].split(/[，,]/)) {
      const name = raw.trim();
      if (!name) continue;
      const list = (map[name] = map[name] || []);
      for (const e of enemies) if (!list.includes(e)) list.push(e);
    }
  }
  return map;
}

/** 敌人名 → BGI 目录名；null = 该敌人不参与打怪 */
function makeAliaser(aliases) {
  return (name) => {
    if (Object.prototype.hasOwnProperty.call(aliases, name)) return aliases[name];
    return name;
  };
}

function main() {
  const enemies = new Set(readLines('data/_bgi-enemies.txt'));
  const bosses = new Set(readLines('data/_bgi-bosses.txt'));
  const monsterMaterials = readLines('data/_monster-materials.txt');
  const materials = (readJson('data/materials.json', { materials: {} }).materials) || {};
  const dropTable = parseDropTable();
  const wikiMonster = (readJson('data/monster-map-wiki.json', { map: {} }).map) || {};
  const wikiBoss = (readJson('data/boss-map-wiki.json', { map: {} }).map) || {};
  const aliases = (readJson('data/_enemy-aliases.json', { aliases: {} }).aliases) || {};
  const manual = readJson('data/_manual-maps.json', { monster: {}, boss: {} });
  const alias = makeAliaser(aliases);

  const prevMonster = (readJson('data/monster-map.json', { map: {} }).map) || {};
  const prevBoss = (readJson('data/boss-map.json', { map: {} }).map) || {};

  // ---------- 怪物材料 ----------
  const monsterMap = {};
  const unresolvedMonster = [];
  for (const name of monsterMaterials) {
    if (manual.monster && manual.monster[name] && manual.monster[name].enemy) {
      const enemy = manual.monster[name].enemy;
      monsterMap[name] = { enemy, confidence: 'manual', candidates: [enemy], exists: enemies.has(enemy) };
      continue;
    }
    const raw = [];
    for (const e of dropTable[name] || []) raw.push({ from: 'drop-table', enemy: e });
    for (const e of wikiMonster[name] || []) raw.push({ from: 'wiki', enemy: e });
    if (!raw.length) {
      monsterMap[name] = { enemy: null, confidence: 'none', reason: '掉落表与 wiki 都没有来源' };
      unresolvedMonster.push(name);
      continue;
    }
    // 归一化 + 只保留 BGI 里真实存在的目录；都没有就退回首项（exists=false，方便人工看到）
    const candidates = [];
    for (const item of raw) {
      const mapped = alias(item.enemy);
      if (mapped === null) continue;
      if (!candidates.some((c) => c.enemy === mapped)) candidates.push({ from: item.from, enemy: mapped });
    }
    if (!candidates.length) {
      monsterMap[name] = {
        enemy: null, confidence: 'none',
        reason: `候选敌人 ${raw.map((r) => r.enemy).join('/')} 都不参与打怪`,
      };
      unresolvedMonster.push(name);
      continue;
    }
    const hit = candidates.find((c) => enemies.has(c.enemy)) || candidates[0];
    monsterMap[name] = {
      enemy: hit.enemy,
      confidence: hit.from === 'drop-table' ? 'high' : 'wiki',
      candidates: candidates.map((c) => c.enemy),
      exists: enemies.has(hit.enemy),
    };
    if (!enemies.has(hit.enemy)) unresolvedMonster.push(name);
  }

  // ---------- 首领素材 ----------
  const bossMap = {};
  const unresolvedBoss = [];
  for (const [name, meta] of Object.entries(materials)) {
    if (!meta || meta.kind !== 'boss') continue;
    const man = manual.boss && manual.boss[name];
    if (man) {
      const entry = { boss: man.boss || null, confidence: man.boss ? (man.confidence || 'manual') : 'none' };
      if (man.source) entry.source = man.source;
      if (man.realBoss) entry.realBoss = man.realBoss;
      if (man.reason) entry.reason = man.reason;
      bossMap[name] = entry;
      if (!man.boss) unresolvedBoss.push(name);
      continue;
    }
    const cands = (wikiBoss[name] || []).slice();
    const hit = cands.find((b) => bosses.has(b));
    if (hit) { bossMap[name] = { boss: hit, confidence: 'wiki', source: 'bwiki 首领页' }; continue; }
    if (cands.length) {
      bossMap[name] = {
        boss: null, confidence: 'none', realBoss: cands[0],
        reason: `BGI 自动首领不支持「${cands[0]}」，需手动刷取`,
      };
    } else {
      bossMap[name] = { boss: null, confidence: 'none', reason: '缺少「素材→首领」映射' };
    }
    unresolvedBoss.push(name);
  }

  // ---------- 输出 ----------
  const monsterOut = {
    note: '怪物掉落材料 → BGI「敌人与魔物」路线目录。本文件由 tools/build-maps.mjs 生成，勿手改。',
    enemyDirsAvailable: enemies.size,
    total: Object.keys(monsterMap).length,
    unresolved: unresolvedMonster.length,
    map: sortKeys(monsterMap),
  };
  const bossOut = {
    note: '首领素材 → BGI AutoBoss 首领名。本文件由 tools/build-maps.mjs 生成，勿手改。',
    bossSupported: bosses.size,
    total: Object.keys(bossMap).length,
    unresolved: unresolvedBoss.length,
    map: sortKeys(bossMap),
  };

  // ---------- 待补映射（给用户看的清单） ----------
  const lines = [];
  lines.push('角色自动养成 —— 映射状态（由 tools/build-maps.mjs 生成，勿手改）');
  lines.push('补法：脚本设置里「怪物掉落补映射」「首领素材补映射」，格式 材料=名字，多个用 ; 分隔；');
  lines.push('      长期修法：改 data/_drop-tables.txt 或 data/_manual-maps.json 后重跑 tools/build-maps.mjs。');
  lines.push('');
  lines.push(`一、怪物掉落：共 ${Object.keys(monsterMap).length} 种，已映射 ${Object.keys(monsterMap).length - unresolvedMonster.length} 种，待补 ${unresolvedMonster.length} 种`);
  if (unresolvedMonster.length) {
    for (const n of unresolvedMonster) {
      const e = monsterMap[n];
      const reason = e.reason ? `   # ${e.reason}` : e.exists === false ? `   # 敌人「${e.enemy}」在 BGI 里没有目录` : '';
      lines.push(`  ${n}=${e.enemy || ''}${reason}`);
    }
  } else {
    lines.push('  （无）');
  }
  lines.push('');
  const bossUnresolved = Object.keys(bossMap).filter((n) => !bossMap[n].boss);
  lines.push(`二、首领素材：共 ${Object.keys(bossMap).length} 种，已映射 ${Object.keys(bossMap).length - bossUnresolved.length} 种，待补 ${bossUnresolved.length} 种`);
  if (bossUnresolved.length) {
    for (const n of bossUnresolved) {
      const e = bossMap[n];
      const extra = [e.realBoss ? `真实首领：${e.realBoss}` : '', e.reason || ''].filter(Boolean).join('；');
      lines.push(`  ${n}=   # ${extra}`);
    }
  } else {
    lines.push('  （无）');
  }
  lines.push('');
  lines.push(`三、可选敌人目录（${enemies.size} 个，来自你已订阅的「地图追踪/敌人与魔物」）`);
  lines.push('  ' + [...enemies].sort().join('、'));
  lines.push('');
  lines.push(`四、可选 BGI 首领名（${bosses.size} 个，来自 GameTask/AutoBoss）`);
  lines.push('  ' + [...bosses].sort().join('、'));

  const changedMonster = writeText('data/monster-map.json', toJson(monsterOut));
  const changedBoss = writeText('data/boss-map.json', toJson(bossOut));
  const changedReport = writeText('record/待补映射.txt', lines.join('\n') + '\n');

  // ---------- 汇总 ----------
  const diffCount = (prev, next, key) => {
    let added = 0, fixed = 0, lost = 0;
    for (const [n, v] of Object.entries(next.map)) {
      const before = prev[n] ? prev[n][key] : undefined;
      if (!before && v[key]) added++;
      else if (before && v[key] && before !== v[key]) fixed++;
      else if (before && !v[key]) lost++;
    }
    return { added, fixed, lost };
  };
  const md = diffCount(prevMonster, { map: monsterMap }, 'enemy');
  const bd = diffCount(prevBoss, { map: bossMap }, 'boss');
  console.log(`怪物映射：${Object.keys(monsterMap).length} 条，待补 ${unresolvedMonster.length}`);
  console.log(`  新增 ${md.added} / 修正 ${md.fixed} / 丢失 ${md.lost}`);
  console.log(`首领映射：${Object.keys(bossMap).length} 条，待补 ${bossUnresolved.length}`);
  console.log(`  新增 ${bd.added} / 修正 ${bd.fixed} / 丢失 ${bd.lost}`);
  if (unresolvedMonster.length) console.log(`  怪物待补：${unresolvedMonster.join('、')}`);
  if (bossUnresolved.length) console.log(`  首领待补：${bossUnresolved.join('、')}`);
  console.log(CHECK_ONLY
    ? (changedMonster || changedBoss || changedReport ? '✗ 输出与输入不同步（需要重跑生成）' : '✓ 输出与输入一致')
    : `写入：${changedMonster ? 'monster-map ' : ''}${changedBoss ? 'boss-map ' : ''}${changedReport ? '待补映射 ' : ''}${changedMonster || changedBoss || changedReport ? '' : '（无变化）'}`);
  if (CHECK_ONLY && (changedMonster || changedBoss || changedReport)) process.exit(1);
}

main();
