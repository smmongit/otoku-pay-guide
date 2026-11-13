/**
 * お得な支払いガイド — おすすめ決済判定エンジン
 *
 * 画面(app.js)から独立した純粋なロジック。ブラウザでは window.PayEngine、
 * Node では require('./engine.js') で使える（tests/engine.test.js 参照）。
 *
 * 基本方針
 *  - 比較対象は settings.enabledServices に含まれるサービスのみ
 *  - 「支払い（payment）」は1回の会計で1つだけ → 同じカードの二重計上は構造上起きない
 *  - 「ポイントカード提示（presentation）」は、併用が公式に確認できたものだけ合算
 *  - 還元率・利用可否が「要確認」のものは計算に入れない（推測しない）
 *  - 条件（requires）を満たさない手段はおすすめしない
 *  - キャンペーンは終了日が確認できて、かつ期間内のものだけ有効
 *  - 同率の場合は settings.priority の順で決定
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PayEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 計算に使ってよい情報確度 */
  const COUNTABLE_STATUS = new Set(['confirmed', 'conditional']);

  const STATUS_LABEL = {
    confirmed: '確認済み',
    conditional: '条件付き',
    unverified: '要確認',
  };

  // ---------------------------------------------------------------- 日付

  /** Date → 'YYYY-MM-DD'（端末のローカル時刻） */
  function toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** 日付時点の楽天会員ランク（settings.rakutenRankSchedule を from の昇順で適用） */
  function rankOn(settings, todayISO) {
    let rank = settings.rakutenRank;
    const sched = [...(settings.rakutenRankSchedule || [])].sort((a, b) => (a.from < b.from ? -1 : 1));
    for (const x of sched) if (x.from && todayISO >= x.from) rank = x.rank;
    return rank;
  }

  // ---------------------------------------------------------------- 店舗の解決

  /**
   * チェーンの情報を画面・判定用の形に整える。
   * データは「1件＝1チェーン」。第1引数 override に同じキーを書くと、その手段だけ丸ごと置き換える
   * （将来、特定の条件だけ別扱いしたい場合のための仕組み。通常は {} を渡す）。
   */
  function resolveStore(store, chain) {
    store = store || {};
    chain = chain || {};
    const methods = {};
    for (const [k, v] of Object.entries(chain.methods || {})) methods[k] = { ...v, scope: 'chain' };
    for (const [k, v] of Object.entries(store.methods || {})) methods[k] = { ...v, scope: 'store' };

    const tag = (arr, scope) => (arr || []).map((x) => ({ ...x, scope }));

    return {
      id: store.id || chain.id,
      chainId: chain.id || null,
      name: store.name || chain.name,
      chainName: chain.name || null,
      aliases: [...(chain.aliases || []), ...(store.aliases || [])],
      category: store.category || chain.category || 'other',
      isSample: !!(store.isSample || chain.isSample),
      defaultTaxRate: store.defaultTaxRate ?? chain.defaultTaxRate ?? null,
      methods,
      pointCardRule: store.pointCardRule
        ? { ...store.pointCardRule, scope: 'store' }
        : chain.pointCardRule
          ? { ...chain.pointCardRule, scope: 'chain' }
          : null,
      campaigns: [...tag(chain.campaigns, 'chain'), ...tag(store.campaigns, 'store')],
      notes: [...tag((chain.notes || []).map((t) => ({ text: t })), 'chain'), ...tag((store.notes || []).map((t) => ({ text: t })), 'store')],
      sources: [...tag(chain.sources, 'chain'), ...tag(store.sources, 'store')],
      checkedAt: store.checkedAt || chain.checkedAt || null,
    };
  }

  // ---------------------------------------------------------------- 還元率・ポイント計算

  /** 名目還元率(%)。earn = {rate} または {per, points} */
  function nominalRate(earn) {
    if (!earn) return null;
    if (typeof earn.rate === 'number') return earn.rate;
    if (typeof earn.per === 'number' && typeof earn.points === 'number' && earn.per > 0) {
      return (earn.points / earn.per) * 100;
    }
    return null;
  }

  /**
   * 実際に付与されるポイント数。
   *  - basis: 'tax_included'(既定) / 'tax_excluded'（税抜金額が対象）
   *  - per/points 形式は「per円ごとにpointsポイント」= 端数切り捨て
   *  - rate 形式は対象金額×rate% の端数切り捨て
   *  - maxPoints: 1回あたりの付与上限
   */
  function calcPoints(earn, amount, taxRate) {
    if (!earn || !(amount > 0)) return 0;
    const t = typeof taxRate === 'number' ? taxRate : 0.1;
    const base = earn.basis === 'tax_excluded' ? Math.floor(amount / (1 + t)) : amount;
    let pts;
    if (typeof earn.per === 'number' && typeof earn.points === 'number') {
      pts = Math.floor(base / earn.per) * earn.points;
    } else if (typeof earn.rate === 'number') {
      pts = Math.floor((base * earn.rate) / 100);
    } else {
      return 0;
    }
    if (typeof earn.maxPoints === 'number') pts = Math.min(pts, earn.maxPoints);
    return pts;
  }

  // ---------------------------------------------------------------- 手段ごとの評価

  function missingRequirements(requires, settings) {
    const caps = new Set(settings.capabilities || []);
    return (requires || []).filter((r) => !caps.has(r));
  }

  /**
   * 1つの決済手段を評価する。
   * 返り値:
   *   eligible  … 利用可能が確認済み＆条件を満たす（キャンペーン加算の前提）
   *   countable … eligible かつ 還元率が確認済み/条件付き（通常時の計算に使える）
   */
  function evaluateMethod(key, entry, defs, settings) {
    const def = defs.methods[key];
    const e = entry || {};
    const res = {
      key,
      def,
      entry: entry || null,
      scope: e.scope || null,
      available: e.available === true ? true : e.available === false ? false : null,
      status: e.status || 'unverified',
      earn: null,
      rate: null,
      rankApplied: null,
      eligible: false,
      countable: false,
      reason: '',
      missing: [],
    };
    if (!def) {
      res.reason = '未定義の決済手段';
      return res;
    }
    if (!(settings.enabledServices || []).includes(def.service)) {
      res.reason = '比較対象外のサービス';
      return res;
    }
    if (res.available === false) {
      res.reason = '利用不可';
      return res;
    }
    if (res.available !== true) {
      res.reason = '利用可否 要確認';
      return res;
    }
    // 会員ランク別の還元（実在する特典のみデータに書く）
    let earn = e.earn || null;
    const rank = settings.rakutenRank;
    if (e.rankEarn && rank && e.rankEarn[rank]) {
      earn = e.rankEarn[rank];
      res.rankApplied = rank;
    }
    res.earn = earn;
    res.rate = nominalRate(earn);

    res.missing = missingRequirements(e.requires, settings);
    if (res.missing.length) {
      res.reason = '適用条件を満たしていない';
      return res;
    }
    res.eligible = true;

    if (!COUNTABLE_STATUS.has(res.status)) {
      res.reason = '還元率 要確認';
      return res;
    }
    if (res.rate == null) {
      res.reason = '還元率 要確認';
      return res;
    }
    res.countable = true;
    return res;
  }

  /** ポイントカード提示と支払い手段が併用できるか（公式に確認できたものだけ true） */
  function canStack(presEval, paymentKey) {
    if (paymentKey == null) return true; // 提示のみ（支払いは5サービス以外）
    const s = presEval.entry && presEval.entry.stack;
    if (!s || !COUNTABLE_STATUS.has(s.status || 'unverified')) return false;
    if ((s.except || []).includes(paymentKey)) return false;
    if (s.with === 'any') return true;
    return Array.isArray(s.with) && s.with.includes(paymentKey);
  }

  function stackInfo(presEval) {
    const s = presEval.entry && presEval.entry.stack;
    if (!s) return { status: 'unverified', text: '併用可否 要確認' };
    const status = s.status || 'unverified';
    if (!COUNTABLE_STATUS.has(status)) return { status, text: '併用可否 要確認' };
    if (s.with === 'any') {
      return { status, text: (s.except && s.except.length) ? '一部の支払いを除き併用可' : '支払い方法を問わず併用可' };
    }
    if (Array.isArray(s.with) && s.with.length) return { status, text: '特定の支払いのみ併用可' };
    return { status, text: '併用不可' };
  }

  // ---------------------------------------------------------------- キャンペーン

  /**
   * キャンペーンの状態。
   * active になるのは「確度が確認済み/条件付き」「終了日が分かっている」「期間内」「条件を満たす」の全部を満たす場合のみ。
   */
  function campaignState(c, todayISO, settings) {
    if (!COUNTABLE_STATUS.has(c.status || 'unverified')) return { active: false, reason: '内容 要確認' };
    if (!c.end) return { active: false, reason: '終了日が確認できないため対象外' };
    if (c.start && todayISO < c.start) return { active: false, reason: '開始前', upcoming: true };
    if (todayISO > c.end) return { active: false, reason: '終了済み', ended: true };
    const miss = missingRequirements(c.requires, settings);
    if (miss.length) return { active: false, reason: '適用条件を満たしていない', missing: miss };
    return { active: true, reason: '開催中' };
  }

  // ---------------------------------------------------------------- 組み合わせ

  function priorityIndex(service, settings) {
    const i = (settings.priority || []).indexOf(service);
    return i === -1 ? 99 : i;
  }

  function* subsets(arr, maxSize) {
    // 0〜maxSize個の組み合わせ（小さいものから）
    const n = arr.length;
    function* rec(start, picked) {
      yield picked;
      if (picked.length >= maxSize) return;
      for (let i = start; i < n; i++) yield* rec(i + 1, [...picked, arr[i]]);
    }
    yield* rec(0, []);
  }

  /**
   * 組み合わせを列挙して評価する。
   *  mode 'normal'   … 通常時（キャンペーンは無視）
   *  mode 'campaign' … 有効なキャンペーンを加算
   */
  function buildCombos(evals, ctx, mode, campaignsByMethod) {
    const { settings, amount, taxRate, maxCards } = ctx;
    const pv = settings.pointValue || {};
    const usable = (ev) => (mode === 'campaign' ? ev.eligible && (ev.countable || (campaignsByMethod[ev.key] || []).length > 0) : ev.countable);

    const payments = evals.filter((ev) => ev.def && ev.def.type === 'payment' && usable(ev));
    const presentations = evals.filter((ev) => ev.def && ev.def.type === 'presentation' && usable(ev));

    const partFor = (ev) => {
      const value = pv[ev.def.pointType] ?? 1;
      const basePts = ev.countable ? calcPoints(ev.earn, amount, taxRate) : 0;
      const part = {
        key: ev.key,
        label: ev.def.label,
        service: ev.def.service,
        pointType: ev.def.pointType,
        type: ev.def.type,
        rate: ev.countable ? ev.rate : 0,
        points: basePts,
        baseUnknown: !ev.countable,
        status: ev.status,
        bonuses: [],
      };
      if (mode === 'campaign') {
        for (const c of campaignsByMethod[ev.key] || []) {
          const bp = calcPoints(c.earn, amount, taxRate);
          part.bonuses.push({ id: c.id, title: c.title, rate: nominalRate(c.earn), points: bp, end: c.end });
          part.points += bp;
          part.rate += nominalRate(c.earn) || 0;
        }
      }
      part.value = part.points * value;
      return part;
    };

    const combos = [];
    for (const pay of [null, ...payments]) {
      const stackable = presentations.filter((p) => canStack(p, pay ? pay.key : null));
      for (const cards of subsets(stackable, maxCards)) {
        if (!pay && cards.length === 0) continue;
        const members = [...cards, ...(pay ? [pay] : [])];
        const parts = members.map(partFor);
        const totalPoints = parts.reduce((s, p) => s + p.points, 0);
        const totalValue = parts.reduce((s, p) => s + p.value, 0);
        const conditions = [];
        for (const m of members) {
          if (m.status === 'conditional' && m.entry && m.entry.condition) conditions.push(`${m.def.label}：${m.entry.condition}`);
        }
        combos.push({
          id: members.map((m) => m.key).join('+'),
          payment: pay ? pay.key : null,
          cards: cards.map((c) => c.key),
          parts,
          label: comboLabel(parts, !!pay),
          totalPoints,
          totalValue,
          nominalRate: round2(parts.reduce((s, p) => s + p.rate, 0)),
          effectiveRate: amount > 0 ? round2((totalValue / amount) * 100) : 0,
          conditions,
          hasCampaign: parts.some((p) => p.bonuses.length),
          tieKey: members.map((m) => priorityIndex(m.def.service, settings)).sort((a, b) => a - b),
        });
      }
    }

    combos.sort((a, b) => {
      if (b.totalValue !== a.totalValue) return b.totalValue - a.totalValue;
      if (b.nominalRate !== a.nominalRate) return b.nominalRate - a.nominalRate;
      // 同率 → 優先順位（楽天→Olive→PayPay→dポイント→せたがやPay）
      const len = Math.max(a.tieKey.length, b.tieKey.length);
      for (let i = 0; i < len; i++) {
        const x = a.tieKey[i] ?? 99;
        const y = b.tieKey[i] ?? 99;
        if (x !== y) return x - y;
      }
      // 支払いが5サービス内の組み合わせを優先
      return (a.payment ? 0 : 1) - (b.payment ? 0 : 1);
    });
    return combos;
  }

  function comboLabel(parts, hasPayment) {
    const pres = parts.filter((p) => p.type === 'presentation').map((p) => p.label);
    const pay = parts.filter((p) => p.type === 'payment').map((p) => p.label);
    const s = [...pres, ...pay].join('＋');
    return hasPayment ? s : `${s}（支払いは現金など）`;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /** 同点の候補があったか（理由表示用） */
  function wasTieBroken(combos) {
    return combos.length > 1 && combos[0].totalValue === combos[1].totalValue && combos[0].nominalRate === combos[1].nominalRate;
  }

  // ---------------------------------------------------------------- メイン

  /**
   * 店舗を評価する。
   * @param {object} resolved resolveStore() の結果
   * @param {object} defs     services.json
   * @param {object} settings settings.json（＋端末の上書き）
   * @param {object} [opts]   { amount, taxRate, today: 'YYYY-MM-DD' }
   */
  function evaluateStore(resolved, defs, settings, opts) {
    opts = opts || {};
    const amount = opts.amount ?? settings.referenceAmount ?? 1000;
    const taxRate = opts.taxRate ?? resolved.defaultTaxRate ?? settings.defaultTaxRate ?? 0.1;
    const today = opts.today || toISODate(new Date());

    const rule = resolved.pointCardRule;
    const maxCards = rule && COUNTABLE_STATUS.has(rule.status || 'unverified') && typeof rule.maxCards === 'number' ? rule.maxCards : 1;

    const evals = Object.keys(defs.methods).map((key) => evaluateMethod(key, resolved.methods[key], defs, settings));
    const byKey = Object.fromEntries(evals.map((e) => [e.key, e]));

    // キャンペーン
    const campaigns = resolved.campaigns.map((c) => {
      const state = campaignState(c, today, settings);
      const ev = byKey[c.method];
      if (state.active && !(ev && ev.eligible)) {
        return { ...c, state: { active: false, reason: ev && ev.reason ? `対象の決済手段が${ev.reason}` : '対象の決済手段が利用できない' } };
      }
      if (state.active && nominalRate(c.earn) == null) {
        return { ...c, state: { active: false, reason: '還元率 要確認' } };
      }
      return { ...c, state };
    });
    const activeCampaigns = campaigns.filter((c) => c.state.active);
    const campaignsByMethod = {};
    for (const c of activeCampaigns) (campaignsByMethod[c.method] = campaignsByMethod[c.method] || []).push(c);

    const ctx = { settings, amount, taxRate, maxCards };
    const normal = buildCombos(evals, ctx, 'normal', {});
    let campaignCombos = [];
    let campaignBest = null;
    if (activeCampaigns.length) {
      campaignCombos = buildCombos(evals, ctx, 'campaign', campaignsByMethod);
      const top = campaignCombos[0];
      // キャンペーン込みで通常時より得になる場合のみ「キャンペーン時のおすすめ」を出す
      if (top && top.hasCampaign && (!normal[0] || top.totalValue > normal[0].totalValue)) {
        const ends = top.parts.flatMap((p) => p.bonuses.map((b) => b.end)).sort();
        campaignBest = { ...top, endsAt: ends[0] || null };
      }
    }

    const best = normal[0] || null;
    let reason;
    if (!best) {
      reason = '確認済みの還元情報がないため、おすすめを判定できません（要確認）。';
    } else {
      reason = `通常条件で確認できている還元の合計が最も高いため（${amount.toLocaleString('ja-JP')}円の支払いで${best.totalPoints}ポイント相当）。`;
      if (wasTieBroken(normal)) reason += ' 同率の候補があるため、設定の優先順位で決定しました。';
      if (best.conditions.length) reason += ' 適用条件があります。';
    }

    const unverifiedCount = evals.filter((e) => e.def && (settings.enabledServices || []).includes(e.def.service) && e.available !== false && !e.countable).length;

    return {
      amount,
      taxRate,
      today,
      maxCards,
      maxCardsConfirmed: !!(rule && COUNTABLE_STATUS.has(rule.status || 'unverified')),
      evals,
      byKey,
      best,
      reason,
      ranking: normal,
      campaigns,
      activeCampaigns,
      campaignBest,
      campaignRanking: campaignCombos,
      unverifiedCount,
    };
  }

  // ---------------------------------------------------------------- オンライン（楽天リーベイツ）

  /**
   * リーベイツの還元額。
   *  earn = {rate, basis, maxPoints} … 対象金額×rate%（既定は税抜・送料除く）
   *  earn = {fixedPoints}            … 1注文あたり固定ポイント
   */
  function rebatesPoints(earn, itemAmount, taxRate) {
    if (!earn) return 0;
    if (typeof earn.fixedPoints === 'number') return itemAmount > 0 ? earn.fixedPoints : 0;
    const e = { basis: 'tax_excluded', ...earn };
    return calcPoints(e, itemAmount, taxRate);
  }

  function rebatesRateLabel(earn) {
    if (!earn) return null;
    if (typeof earn.fixedPoints === 'number') return `${earn.fixedPoints.toLocaleString('ja-JP')}pt/件`;
    const r = nominalRate(earn);
    return r == null ? null : `${round2(r)}%`;
  }

  /**
   * オンラインショップを評価する。
   * リーベイツ分と決済分は別々に計算し、合計は単純な足し算（同一ポイントの二重計上はしない）。
   * @param {object} shop online-shops.json の1件
   * @param {object} opts { amount: 商品代金(税込), shipping: 送料, taxRate, today }
   */
  function evaluateOnline(shop, defs, settings, opts) {
    opts = opts || {};
    const amount = opts.amount ?? settings.referenceAmount ?? 1000;
    const shipping = opts.shipping ?? 0;
    const taxRate = opts.taxRate ?? settings.defaultTaxRate ?? 0.1;
    const today = opts.today || toISODate(new Date());
    const pv = settings.pointValue || {};
    const rakutenValue = pv.rakuten ?? 1;

    // --- リーベイツ
    const rb = shop.rebates || {};
    const listed = rb.listed === true ? true : rb.listed === false ? false : null;
    const rbCountable = listed === true && COUNTABLE_STATUS.has(rb.status || 'unverified');
    const normalEarn = rb.normal && rb.normal.earn;
    const normalRateKnown = rbCountable && normalEarn && (nominalRate(normalEarn) != null || typeof normalEarn.fixedPoints === 'number');
    const normalPts = normalRateKnown ? rebatesPoints(normalEarn, amount, taxRate) : 0;

    const campaigns = (rb.campaigns || []).map((c) => {
      let state = campaignState(c, today, settings);
      if (state.active && !rbCountable) state = { active: false, reason: 'リーベイツ掲載 要確認' };
      return { ...c, state, points: rebatesPoints(c.earn, amount, taxRate), rateLabel: rebatesRateLabel(c.earn) };
    });
    const active = campaigns.filter((c) => c.state.active).sort((a, b) => b.points - a.points);
    const activeCampaign = active[0] || null;

    let firstTime = null;
    if (rb.firstTime) {
      const ft = rb.firstTime;
      const ok = rbCountable && COUNTABLE_STATUS.has(ft.status || 'unverified') && ft.earn;
      const st = ft.end ? campaignState({ ...ft, status: ft.status }, today, settings) : { active: !!ok, reason: ok ? '' : '要確認' };
      firstTime = { ...ft, valid: !!ok && st.active !== false, points: ok ? rebatesPoints(ft.earn, amount, taxRate) : 0, rateLabel: rebatesRateLabel(ft.earn) };
    }

    const rebates = {
      listed,
      status: rb.status || 'unverified',
      countable: rbCountable,
      normal: { known: !!normalRateKnown, rateLabel: normalRateKnown ? rebatesRateLabel(normalEarn) : null, rate: normalRateKnown ? nominalRate(normalEarn) : null, points: normalPts },
      campaigns,
      activeCampaign,
      firstTime,
    };

    // --- 決済（支払いのみ。ポイントカード提示はオンラインでは扱わない）
    const evals = Object.keys(defs.methods)
      .filter((k) => defs.methods[k].type === 'payment')
      .map((k) => evaluateMethod(k, (shop.payments || {})[k], defs, settings));
    const payTotal = amount + shipping;
    const ranking = buildCombos(evals, { settings, amount: payTotal, taxRate, maxCards: 0 }, 'normal', {});
    const bestPay = ranking[0] || null;
    const payValue = bestPay ? bestPay.totalValue : 0;

    const mk = (rebPts) => {
      const value = rebPts * rakutenValue + payValue;
      return { rebatesPoints: rebPts, paymentPoints: bestPay ? bestPay.totalPoints : 0, value, rate: payTotal > 0 ? round2((value / payTotal) * 100) : 0 };
    };
    const totals = {
      normal: mk(normalPts),
      campaign: activeCampaign ? mk(activeCampaign.points) : null,
      // 初回特典：mode 'add'(既定)=通常/キャンペーン分に上乗せ、'replace'=置き換え
      firstTime: firstTime && firstTime.valid
        ? mk(firstTime.mode === 'replace' ? firstTime.points : (activeCampaign ? activeCampaign.points : normalPts) + firstTime.points)
        : null,
    };

    // 一覧の並び替え用：今使えるリーベイツ還元率(%)
    const sortRate = activeCampaign ? nominalRate(activeCampaign.earn) ?? 0 : rebates.normal.rate ?? -1;

    return { amount, shipping, taxRate, today, rebates, evals, byKey: Object.fromEntries(evals.map((e) => [e.key, e])), payment: { best: bestPay, ranking }, totals, sortRate };
  }

  // ---------------------------------------------------------------- 検索

  /** 検索用の正規化：全角半角統一・小文字化・ひらがな→カタカナ・空白/記号除去 */
  function normalize(s) {
    if (!s) return '';
    return String(s)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60))
      .replace(/[\s・･.\-‐－—,、。「」()（）【】]/g, '');
  }

  function searchText(resolved) {
    return normalize([resolved.name, resolved.chainName, ...(resolved.aliases || [])].filter(Boolean).join(' '));
  }

  function matches(resolved, query) {
    const q = normalize(query);
    if (!q) return true;
    return searchText(resolved).includes(q);
  }

  return {
    STATUS_LABEL,
    COUNTABLE_STATUS,
    toISODate,
    rankOn,
    resolveStore,
    nominalRate,
    calcPoints,
    evaluateMethod,
    canStack,
    stackInfo,
    campaignState,
    evaluateStore,
    evaluateOnline,
    rebatesPoints,
    rebatesRateLabel,
    normalize,
    matches,
  };
});
