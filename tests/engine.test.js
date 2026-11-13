// 実行: node tests/engine.test.js
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const E = require('../js/engine.js');

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stores.sample.json'), 'utf8'));
const defs = load('services.json');
const baseSettings = load('settings.json');
const TODAY = '2026-11-13';

const resolve = (id, override = {}) => E.resolveStore(override, data.chains.find((c) => c.id === id));
const evalStore = (id, settings = baseSettings, opts = {}) => E.evaluateStore(resolve(id), defs, settings, { today: TODAY, ...opts });

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

console.log('engine');

test('ポイント計算：100円ごと1pt・端数切り捨て', () => {
  assert.equal(E.calcPoints({ per: 100, points: 1 }, 1099, 0.1), 10);
  assert.equal(E.calcPoints({ per: 200, points: 1 }, 1000, 0.1), 5);
});
test('ポイント計算：税抜対象', () => {
  // 1000 / 1.08 = 925.9 → 925 → 200円ごと → 4pt
  assert.equal(E.calcPoints({ per: 200, points: 1, basis: 'tax_excluded' }, 1000, 0.08), 4);
});
test('ポイント計算：付与上限', () => {
  assert.equal(E.calcPoints({ rate: 10, maxPoints: 1000 }, 50000, 0.1), 1000);
});

test('ささやま：楽天ポイントカード提示＋楽天カードを合算（税抜対象を反映）', () => {
  const r = evalStore('sample-sasayama');
  assert.equal(r.best.id, 'rakuten_pointcard+rakuten_card');
  assert.equal(r.best.totalPoints, 14); // 4 + 10
  assert.equal(r.best.effectiveRate, 1.4);
});
test('二重計上なし：支払いは1つだけ、同じ手段は2回入らない', () => {
  for (const s of data.chains) {
    const r = evalStore(s.id);
    for (const c of r.ranking.concat(r.campaignRanking)) {
      const pays = c.parts.filter((p) => p.type === 'payment');
      assert.ok(pays.length <= 1, `${s.id} ${c.id}`);
      assert.equal(new Set(c.parts.map((p) => p.key)).size, c.parts.length);
      assert.ok(c.parts.filter((p) => p.type === 'presentation').length <= r.maxCards);
    }
  }
});
test('キャンペーン：期間内は別枠でおすすめ、終了日つき', () => {
  const r = evalStore('sample-sasayama');
  assert.ok(r.campaignBest);
  assert.equal(r.campaignBest.payment, 'setagaya_pay');
  assert.equal(r.campaignBest.endsAt, '2026-11-30');
  // 通常時のおすすめは変わらない
  assert.equal(r.best.payment, 'rakuten_card');
});
test('キャンペーン：終了日不明は無効', () => {
  const r = evalStore('sample-sasayama');
  const c = r.campaigns.find((x) => x.id === 'sample-olive-nodate');
  assert.equal(c.state.active, false);
});
test('キャンペーン：終了後は通常時に戻る', () => {
  const r = evalStore('sample-sasayama', baseSettings, { today: '2026-12-01' });
  assert.equal(r.campaignBest, null);
  const h = evalStore('sample-hanamichi');
  assert.equal(h.campaigns[0].state.ended, true);
  assert.equal(h.campaignBest, null);
});
test('キャンペーン：開始前は無効', () => {
  const r = evalStore('sample-sasayama', baseSettings, { today: '2026-10-15' });
  assert.equal(r.campaignBest, null);
});
test('上書き指定した手段はチェーン情報より優先', () => {
  const r = E.evaluateStore(resolve('sample-sasayama', { methods: { setagaya_pay: { available: false, status: 'confirmed' } } }), defs, baseSettings, { today: TODAY });
  assert.equal(r.byKey.setagaya_pay.available, false);
  assert.equal(r.campaignBest, null); // 対象手段が使えないのでキャンペーンも無効
});
test('条件付きの手段は条件を表示', () => {
  const r = evalStore('sample-sasayama');
  assert.equal(r.byKey.setagaya_pay.status, 'conditional');
  assert.ok(r.campaignBest.conditions.some((c) => c.includes('加盟店舗')));
});
test('併用可否が未確認のポイントカードは合算しない', () => {
  const r = evalStore('sample-midori');
  for (const c of r.ranking) {
    if (c.cards.includes('rakuten_pointcard')) assert.equal(c.payment, null);
  }
  // dポイント提示（併用確認済）＋楽天カード = 10 + 10
  assert.equal(r.best.id, 'dpoint_card+rakuten_card');
  assert.equal(r.best.totalPoints, 20);
});
test('還元率が要確認の手段は計算に入れない', () => {
  const r = evalStore('sample-midori');
  assert.equal(r.byKey.paypay_balance.countable, false);
  assert.ok(!r.ranking.some((c) => c.payment === 'paypay_balance'));
});
test('条件付き高還元：条件を満たすとおすすめ', () => {
  const r = evalStore('sample-sakura');
  assert.equal(r.best.payment, 'olive_touch_phone');
  assert.equal(r.best.effectiveRate, 7);
  assert.ok(r.best.conditions.length > 0);
});
test('条件付き高還元：条件を満たさないとおすすめしない', () => {
  const s = { ...baseSettings, capabilities: baseSettings.capabilities.filter((c) => c !== 'smartphone_touch') };
  const r = evalStore('sample-sakura', s);
  assert.notEqual(r.best.payment, 'olive_touch_phone');
  assert.equal(r.best.service ?? r.best.parts[0].service, 'rakuten');
});
test('PayPayクレジット：利用条件なしなら候補外', () => {
  const r = evalStore('sample-sakura');
  assert.equal(r.byKey.paypay_credit.eligible, false);
});
test('会員ランク：プラチナ特典が反映される', () => {
  const plat = evalStore('sample-tsubame');
  assert.equal(plat.best.id, 'rakuten_pointcard+rakuten_card');
  assert.equal(plat.best.totalPoints, 20);
  const reg = evalStore('sample-tsubame', { ...baseSettings, rakutenRank: 'regular' });
  assert.equal(reg.best.totalPoints, 15);
});
test('同率なら優先順位（楽天→Olive→PayPay→d→せたがやPay）', () => {
  const r = evalStore('sample-hanamichi');
  assert.equal(r.best.payment, 'rakuten_card');
  assert.match(r.reason, /優先順位/);
  const s = { ...baseSettings, priority: ['setagaya', 'paypay', 'rakuten', 'olive', 'dpoint'] };
  assert.equal(evalStore('sample-hanamichi', s).best.payment, 'setagaya_pay');
});
test('情報がない店舗は「判定不可」', () => {
  const r = evalStore('sample-komorebi');
  assert.equal(r.best, null);
  assert.match(r.reason, /要確認/);
});
test('比較対象から外したサービスは使わない', () => {
  const s = { ...baseSettings, enabledServices: ['paypay', 'dpoint', 'setagaya', 'olive'] };
  const r = evalStore('sample-hanamichi', s);
  assert.equal(r.best.payment, 'paypay_balance');
});
test('検索：ひらがな/カタカナ/全角半角/部分一致', () => {
  const r = resolve('sample-midori');
  assert.ok(E.matches(r, 'ミドリ'));
  assert.ok(E.matches(r, 'みどり'));
  assert.ok(E.matches(r, 'ﾐﾄﾞﾘ'));
  assert.ok(E.matches(r, 'サンプル薬局'));
  assert.ok(!E.matches(r, 'スタバ'));
});

// ---------------------------------------------------------------- online
console.log('\nonline');
const online = load('online-shops.json');
const shop = (id) => online.shops.find((x) => x.id === id);
const evalShop = (id, opts = {}) => E.evaluateOnline(shop(id), defs, baseSettings, { today: TODAY, amount: 1000, ...opts });

test('リーベイツ分と決済分を別枠で計算（税抜対象）', () => {
  const r = evalShop('sample-hikari');
  assert.equal(r.rebates.normal.points, 27); // floor(909 * 3%)
  assert.equal(r.payment.best.payment, 'rakuten_card');
  assert.equal(r.totals.normal.paymentPoints, 10);
  assert.equal(r.totals.normal.value, 37);
});
test('リーベイツのキャンペーンは通常率を置き換え（加算しない）', () => {
  const r = evalShop('sample-hikari');
  assert.equal(r.rebates.activeCampaign.id, 'hikari-1111');
  assert.equal(r.totals.campaign.rebatesPoints, 54);
  assert.equal(r.totals.campaign.value, 64);
});
test('リーベイツのキャンペーン終了後は通常に戻る', () => {
  const r = evalShop('sample-hikari', { today: '2026-11-21' });
  assert.equal(r.totals.campaign, null);
});
test('初回特典は別表示（通常時の合計に入れない）', () => {
  const r = evalShop('sample-hikari');
  assert.equal(r.totals.normal.rebatesPoints, 27);
  assert.equal(r.totals.firstTime.rebatesPoints, 54 + 500);
});
test('送料はリーベイツ対象外・決済ポイントには含む', () => {
  const r = evalShop('sample-hikari', { shipping: 500, today: '2026-12-01' });
  assert.equal(r.rebates.normal.points, 27);
  assert.equal(r.totals.normal.paymentPoints, 15);
});
test('終了日不明・開始前のキャンペーンは無効', () => {
  assert.equal(evalShop('sample-denki').totals.campaign, null);
  assert.equal(evalShop('sample-tabi').totals.campaign, null);
  assert.equal(evalShop('sample-tabi').rebates.campaigns[0].state.upcoming, true);
});
test('非掲載ショップはリーベイツ0、決済分のみ', () => {
  const r = evalShop('sample-marugoto');
  assert.equal(r.rebates.listed, false);
  assert.equal(r.totals.normal.rebatesPoints, 0);
  assert.equal(r.totals.normal.paymentPoints, 10);
});
test('調査前の候補（Apple）は要確認で還元率を出さない', () => {
  const s = online.shops.find((x) => E.matches(x, 'Apple'));
  assert.ok(s && s.isCandidate);
  const r = E.evaluateOnline(s, defs, baseSettings, { today: TODAY });
  assert.equal(r.rebates.listed, null);
  assert.equal(r.rebates.normal.known, false);
  assert.equal(r.payment.best, null);
});
test('オンライン決済にポイントカード提示は入らない', () => {
  for (const s of online.shops) {
    const r = E.evaluateOnline(s, defs, baseSettings, { today: TODAY });
    for (const c of r.payment.ranking) assert.ok(c.parts.every((p) => p.type === 'payment'));
  }
});

console.log(`\n${passed} passed`);
test('会員ランクの予定：12/1からダイヤモンド', () => {
  assert.equal(E.rankOn(baseSettings, '2026-11-30'), 'platinum');
  assert.equal(E.rankOn(baseSettings, '2026-12-01'), 'diamond');
});
console.log(`${passed} passed`);
