// お得な支払いガイド — データ自動更新（GitHub Actions から毎朝実行）
//
// 公式ページを開いて、機械的に読み取れる「数値」だけを更新する。
//  - 楽天リーベイツ：各ショップの還元率（data/online-shops.json）
//  - 楽天ポイントカード／dポイントカード／Vポイント：付与率（data/stores.json の src 付き項目）
// 読み取れない・ページがない等の場合はデータを書き換えず、meta.autoUpdate.issues に記録する。
// 実行：node scripts/update-data.mjs  （Playwright が必要）
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES = path.join(ROOT, 'data', 'stores.json');
const ONLINE = path.join(ROOT, 'data', 'online-shops.json');

// 日本時間の日付
const todayJST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const TODAY = todayJST();

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

// ---------------------------------------------------------------- 解析（テスト可能な純粋関数）

/** 「200円(税抜)につき1ポイント」「100円（税込）で1ポイント」「200円につき→ 1ポイント」→ {per, points, basis?} */
export function parsePerPoint(line) {
  if (!line) return null;
  const s = line.normalize('NFKC').replace(/\s+/g, '');
  const m = s.match(/([\d,]+)円(?:\((税込|税抜)\))?(?:につき|で)→?([\d,]+)(?:ポイント|pt|P)/);
  if (!m) return null;
  const e = { per: Number(m[1].replace(/,/g, '')), points: Number(m[3].replace(/,/g, '')) };
  if (m[2]) e.basis = m[2] === '税抜' ? 'tax_excluded' : 'tax_included';
  return e;
}

/** リーベイツの表示「10.0%」「最大7.5%」「120ポイント」→ {rate, upTo} / {fixedPoints} */
export function parseRebates(line) {
  if (!line) return null;
  const s = line.normalize('NFKC').replace(/\s+/g, '');
  let m = s.match(/^(最大)?([\d.]+)%/);
  if (m) return { rate: Number(m[2]), upTo: !!m[1] };
  m = s.match(/^(最大)?([\d,]+)(?:ポイント|pt)/);
  if (m) return { fixedPoints: Number(m[2].replace(/,/g, '')), upTo: !!m[1] };
  return null;
}

const lineAfter = (lines, key, skip = () => false) => {
  const i = lines.indexOf(key);
  if (i < 0) return null;
  for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) if (!skip(lines[j])) return lines[j];
  return null;
};

/** ページ本文（行の配列）から付与率を読む */
export function extractRule(kind, lines) {
  if (kind === 'rakuten') {
    const i = lines.indexOf('楽天ポイントの付与・利用について');
    if (i < 0) return null;
    const j = lines.indexOf('貯まる', i);
    return j < 0 ? null : parsePerPoint(lines[j + 1]);
  }
  if (kind === 'dpoint') {
    // ローソンのように時間帯で分かれる場合は最初（通常時間帯）の行を使う
    return parsePerPoint(lineAfter(lines, 'dポイントカード提示で', (l) => /^【.*】$/.test(l)));
  }
  if (kind === 'vpoint') {
    const l = lines.find((x) => /円につき/.test(x));
    return parsePerPoint(l);
  }
  return null;
}

export function extractRebates(lines) {
  // 還元率は「購入で」「宿泊で」「国内・海外旅行で」などの直後、「楽天IDでログイン」の直前にある
  const i = lines.indexOf('楽天IDでログイン');
  if (i > 0) { const r = parseRebates(lines[i - 1]); if (r && /で$/.test(lines[i - 2] || '')) return r; }
  for (let j = 0; j < Math.min(lines.length - 1, 40); j++) {
    if (/で$/.test(lines[j])) { const r = parseRebates(lines[j + 1]); if (r) return r; }
  }
  return null;
}

// ---------------------------------------------------------------- 取得

async function fetchLines(browser, url) {
  const page = await browser.newPage({ locale: 'ja-JP' });
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    const status = res ? res.status() : 0;
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    return { status, lines: text.split('\n').map((l) => l.trim()).filter(Boolean) };
  } catch (e) {
    return { status: 0, error: e.message.split('\n')[0], lines: [] };
  } finally {
    await page.close();
  }
}

const sameRule = (a, b) => a.per === b.per && a.points === b.points && (!b.basis || a.basis === b.basis);

// ---------------------------------------------------------------- メイン

async function main() {
  // Playwright はここで読み込む（解析関数だけをテストから使えるように）
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  const issues = [];
  const changed = [];
  let checked = 0;

  // ---- 実店舗
  const stores = readJSON(STORES);
  const KIND = { rakuten_pointcard: 'rakuten', dpoint_card: 'dpoint', vpoint_card: 'vpoint' };
  for (const c of stores.chains) {
    let ok = 0;
    for (const [key, kind] of Object.entries(KIND)) {
      const m = c.methods[key];
      if (!m || !m.src || m.available !== true) continue;
      const { status, lines, error } = await fetchLines(browser, m.src);
      checked++;
      if (status !== 200) { issues.push({ where: `${c.name}／${key}`, url: m.src, reason: error || `HTTP ${status}` }); continue; }
      const rule = extractRule(kind, lines);
      if (!rule) { issues.push({ where: `${c.name}／${key}`, url: m.src, reason: '付与率を読み取れない（ページの形式変更、または取り扱い終了の可能性）' }); continue; }
      const cur = m.rankEarn ? null : m.earn || {};
      if (cur && !sameRule(cur, rule)) {
        const next = { ...cur, per: rule.per, points: rule.points };
        if (rule.basis) next.basis = rule.basis;
        delete next.rate;
        changed.push({ where: `${c.name}／${key}`, from: cur, to: next });
        m.earn = next;
      }
      ok++;
    }
    if (ok) {
      c.checkedAt = TODAY;
      for (const s of c.sources || []) if (Object.values(c.methods).some((m) => m.src === s.url)) s.checkedAt = TODAY;
    }
  }

  // ---- オンライン（楽天リーベイツ）
  const online = readJSON(ONLINE);
  for (const s of online.shops) {
    const rb = s.rebates || {};
    if (rb.listed !== true || !s.rebatesUrl) continue;
    const { status, lines, error } = await fetchLines(browser, s.rebatesUrl);
    checked++;
    if (status === 404) { issues.push({ where: s.name, url: s.rebatesUrl, reason: '楽天リーベイツのページが見つからない（掲載終了の可能性）' }); rb.status = 'unverified'; continue; }
    if (status !== 200) { issues.push({ where: s.name, url: s.rebatesUrl, reason: error || `HTTP ${status}` }); continue; }
    const r = extractRebates(lines);
    if (!r || r.rate == null) { issues.push({ where: s.name, url: s.rebatesUrl, reason: '還元率を読み取れない（固定ポイント型・形式変更の可能性）' }); continue; }
    const cur = (rb.normal && rb.normal.earn) || {};
    if (cur.rate !== r.rate || !!cur.upTo !== r.upTo) {
      const next = { ...cur, rate: r.rate };
      if (r.upTo) next.upTo = true; else delete next.upTo;
      changed.push({ where: `${s.name}（リーベイツ）`, from: cur, to: next });
      rb.normal = { ...(rb.normal || {}), earn: next };
      rb.status = r.upTo ? 'conditional' : 'confirmed';
    }
    s.checkedAt = TODAY;
    for (const src of s.sources || []) if (src.url === s.rebatesUrl) src.checkedAt = TODAY;
  }

  await browser.close();

  const summary = { at: new Date().toISOString(), date: TODAY, checked, changed, issues };
  stores.meta.autoUpdate = summary;
  online.meta.autoUpdate = summary;
  stores.meta.updatedAt = TODAY;
  online.meta.updatedAt = TODAY;
  writeJSON(STORES, stores);
  writeJSON(ONLINE, online);

  console.log(`確認 ${checked}件 / 変更 ${changed.length}件 / 要確認 ${issues.length}件`);
  for (const c of changed) console.log('変更:', c.where, JSON.stringify(c.from), '→', JSON.stringify(c.to));
  for (const i of issues) console.log('要確認:', i.where, i.reason);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
