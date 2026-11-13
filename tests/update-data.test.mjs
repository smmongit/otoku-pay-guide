// 実行: node tests/update-data.test.mjs
import assert from 'node:assert/strict';
import { parsePerPoint, parseRebates, extractRule, extractRebates } from '../scripts/update-data.mjs';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
console.log('update-data');
t('楽天ポイントカード表記', () => assert.deepEqual(parsePerPoint('200円(税抜)につき1ポイント'), { per: 200, points: 1, basis: 'tax_excluded' }));
t('dポイント表記', () => assert.deepEqual(parsePerPoint('100円（税込）で1ポイントたまる'), { per: 100, points: 1, basis: 'tax_included' }));
t('Vポイント表記（税区分なし）', () => assert.deepEqual(parsePerPoint('200円につき→ 1ポイント（一部店舗除く）'), { per: 200, points: 1 }));
t('リーベイツ：通常', () => assert.deepEqual(parseRebates('10.0%'), { rate: 10, upTo: false }));
t('リーベイツ：最大', () => assert.deepEqual(parseRebates('最大7.5%'), { rate: 7.5, upTo: true }));
t('リーベイツ：固定ポイント', () => assert.deepEqual(parseRebates('120ポイント'), { fixedPoints: 120, upTo: false }));
t('楽天ポイントカード：ページから抽出', () => assert.deepEqual(
  extractRule('rakuten', ['貯まる', 'ヘッダ', '楽天ポイントの付与・利用について', '貯まる', '200円(税込)につき1ポイント']), { per: 200, points: 1, basis: 'tax_included' }));
t('dポイント：時間帯で分かれるページ（ローソン）', () => assert.deepEqual(
  extractRule('dpoint', ['dポイントカード提示で', '【0:00～15:59】', '200円（税抜）で1ポイントたまる', '【16:00～23:59】']), { per: 200, points: 1, basis: 'tax_excluded' }));
t('リーベイツ：ページから抽出', () => assert.deepEqual(extractRebates(['ヘッダ', '購入で', '4.0%', 'オンライン決済導入ストア']), { rate: 4, upTo: false }));
t('リーベイツ：旅行系の表記（宿泊で）', () => assert.deepEqual(extractRebates(['ヘルプ', '宿泊で', '3.5%', '楽天IDでログイン']), { rate: 3.5, upTo: false }));
t('リーベイツ：旅行系の表記（最大）', () => assert.deepEqual(extractRebates(['ヘルプ', '国内・海外旅行で', '最大7.5%', '楽天IDでログイン']), { rate: 7.5, upTo: true }));
t('読めない場合はnull', () => { assert.equal(extractRule('dpoint', ['d払い']), null); assert.equal(extractRebates(['購入で', 'ストアにすすむ']), null); });
console.log(`\n${n} passed`);
