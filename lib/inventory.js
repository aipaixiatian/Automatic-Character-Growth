// lib/inventory.js —— 背包数量读取（BGI 内置 CountInventoryItem，替代 OCR 拖页）
// 语义：>=0 有效数量；-1 包里没有；-2 识别失败（必须重试，绝不能当 0，否则会无限刷）
import { info, warn } from './env.js';

export const COUNT_MISSING = -1;
export const COUNT_FAILED = -2;

function runCountTask(config) {
  return dispatcher.runTask(new SoloTask('CountInventoryItem', config));
}

function toCounts(requested, dict) {
  const counts = {};
  const unknown = [];
  for (const name of requested) {
    const raw = dict ? dict[name] : undefined;
    const v = raw === undefined || raw === null ? COUNT_FAILED : Number(raw);
    if (v === COUNT_FAILED || Number.isNaN(v)) { unknown.push(name); counts[name] = null; }
    else if (v === COUNT_MISSING) counts[name] = 0;
    else counts[name] = v;
  }
  return { counts, unknown };
}

/**
 * 一次读完全部材料数量
 * @param {string[]} itemNames 材料全名（如「勤劳」的教导 / 霓裳花）
 * @param {object} opts {retries, pages}
 * @returns {{counts:Object<string,number|null>, unknown:string[], source:string}}
 */
export async function countItems(itemNames, opts = {}) {
  const names = [...new Set((itemNames || []).filter(Boolean))];
  if (!names.length) return { counts: {}, unknown: [], source: 'empty' };
  const retries = opts.retries ?? 2;

  // 策略 1：不给 gridScreenName，让 BGI 按物品库自动分组多页扫描（养成道具 + 材料 都能覆盖）
  for (let i = 0; i <= retries; i++) {
    try {
      const dict = await runCountTask({ itemNames: names, stopByItemSort: false });
      const { counts, unknown } = toCounts(names, dict);
      if (!unknown.length) return { counts, unknown, source: 'auto' };
      if (i === retries) {
        // 兜底：按两个页签分别扫一次
        const merged = { ...counts };
        const stillUnknown = [];
        for (const page of ['CharacterDevelopmentItems', 'Materials']) {
          const sub = names.filter((n) => merged[n] === null);
          if (!sub.length) break;
          try {
            const d2 = await runCountTask({ gridScreenName: page, itemNames: sub, stopByItemSort: false });
            const r2 = toCounts(sub, d2);
            Object.assign(merged, r2.counts);
          } catch (e) { warn(`按页签 ${page} 统计失败：${e?.message || e}`); }
        }
        for (const n of names) if (merged[n] === null) stillUnknown.push(n);
        return { counts: merged, unknown: stillUnknown, source: 'auto+pages' };
      }
      warn(`第 ${i + 1} 次统计有 ${unknown.length} 项未识别，重试…`);
    } catch (e) {
      warn(`CountInventoryItem 调用失败（第 ${i + 1} 次）：${e?.message || e}`);
      if (i === retries) throw e;
    }
    try { sleep(1200); } catch { /* 环境无 sleep 时直接重试 */ }
  }

  // 策略 2：逐项单查（最慢但最稳）
  info('退回逐项统计模式…');
  const counts = {}, unknown = [];
  for (const name of names) {
    try {
      const dict = await runCountTask({ gridScreenName: null, itemNames: [name] });
      const r = toCounts([name], dict);
      counts[name] = r.counts[name];
      if (counts[name] === null) unknown.push(name);
    } catch {
      counts[name] = null;
      unknown.push(name);
    }
  }
  return { counts, unknown, source: 'single' };
}
