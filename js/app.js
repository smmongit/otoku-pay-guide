/* お得な支払いガイド — 画面ロジック（判定は engine.js） */
(() => {
  'use strict';
  const E = window.PayEngine;
  const app = document.getElementById('app');

  // ------------------------------------------------------------ 端末保存（失敗しても動く）
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode 等 */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
  };
  const K = { favS: 'opg.fav.stores', favO: 'opg.fav.shops', recS: 'opg.recent.stores', recO: 'opg.recent.shops', settings: 'opg.settings' };

  const S = {
    defs: null, base: null, settings: null, storesMeta: null, onlineMeta: null,
    stores: [], storeById: {}, shops: [], shopById: {},
    ui: { sq: '', sc: 'all', oq: '', oc: 'all', sort: 'recommended', onlyCamp: false, onlyFirst: false },
  };

  // ------------------------------------------------------------ 小物
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (n) => `${Number((+n).toFixed(2))}%`;
  const ymd = (d) => (d ? d.replace(/-/g, '/') : '');
  const md = (d) => (d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '');
  const yen = (n) => `${Math.round(n).toLocaleString('ja-JP')}円`;
  const today = () => E.toISODate(new Date());
  const svcColor = (svc) => (S.defs.services[svc] || {}).color || '#888';

  function statusBadge(status) {
    const map = { confirmed: ['b-ok', '確認済み'], conditional: ['b-cond', '条件付き'], unverified: ['b-unk', '要確認'] };
    const [c, t] = map[status] || map.unverified;
    return `<span class="badge ${c}">${t}</span>`;
  }
  const scopeBadge = (scope) => (scope === 'store' ? '<span class="badge b-scope">個別の上書き</span>' : '');

  function favBtn(kind, id) {
    const on = LS.get(kind === 'store' ? K.favS : K.favO, []).includes(id);
    return `<button class="fav" data-fav="${kind}" data-id="${esc(id)}" aria-pressed="${on}" aria-label="${on ? 'お気に入りから外す' : 'お気に入りに追加'}">${on ? '★' : '☆'}</button>`;
  }
  function toggleFav(kind, id) {
    const key = kind === 'store' ? K.favS : K.favO;
    const list = LS.get(key, []);
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.unshift(id);
    LS.set(key, list);
  }
  function pushRecent(key, id) {
    const list = LS.get(key, []).filter((x) => x !== id);
    list.unshift(id);
    LS.set(key, list.slice(0, 8));
  }

  // ------------------------------------------------------------ クーポン確認ラベル
  const COUPON = {
    paypay: { label: 'PayPayクーポン確認', app: 'PayPayアプリ' },
    vpoint: { label: 'Vポイントクーポン確認', app: 'Vポイントアプリ（またはVポイントPayアプリ）' },
  };
  const couponBadges = (o) => (o.coupons || []).map((c) => `<span class="badge b-coupon">🎟 ${esc((COUPON[c.service] || {}).label || 'クーポン確認')}</span>`).join('');
  const couponPanel = (o) => (o.coupons || []).length ? `<div class="panel coupon-panel"><h2>🎟 支払う前にクーポンを確認</h2><ul class="plain">${o.coupons.map((c) => {
      const d = COUPON[c.service] || { app: 'アプリ' };
      return `<li><strong>${esc(d.label)}</strong>：${esc(d.app)}で、このお店のクーポンが配信されていないか確認してください。<br><small>${ymd(c.asOf)}時点で配信を確認。有効期限・還元率・使える条件はアプリで確認（おすすめ判定には含めていません）</small></li>`;
    }).join('')}</ul></div>` : '';

  // ------------------------------------------------------------ 読み込み
  async function getJSON(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function applySettings() {
    const o = LS.get(K.settings, {});
    S.settings = { ...S.base, ...o, pointValue: { ...S.base.pointValue, ...(o.pointValue || {}) } };
    // 端末で手動変更していなければ、日付に応じてランクを自動切り替え
    if (!o.rakutenRank) S.settings.rakutenRank = E.rankOn(S.base, today());
  }

  async function init() {
    try {
      const [defs, base, stores, online] = await Promise.all([
        getJSON('data/services.json'), getJSON('data/settings.json'), getJSON('data/stores.json'), getJSON('data/online-shops.json'),
      ]);
      S.defs = defs; S.base = base; S.storesMeta = stores.meta; S.onlineMeta = online.meta;
      applySettings();
      S.stores = stores.chains.map((c) => E.resolveStore({}, c));
      S.storeById = Object.fromEntries(S.stores.map((s) => [s.id, s]));
      S.shops = online.shops;
      S.shopById = Object.fromEntries(S.shops.map((s) => [s.id, s]));
    } catch (err) {
      app.innerHTML = `<p class="empty"><strong>データを読み込めませんでした</strong>${esc(err.message)}<br>通信状態を確認して再読み込みしてください。</p>`;
      return;
    }
    window.addEventListener('hashchange', route);
    route();
  }

  // ------------------------------------------------------------ ルーティング
  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const parts = h.split('/').filter(Boolean).map(decodeURIComponent);
    let tab = 'store';
    if (parts[0] === 'store' && parts[1]) renderStoreDetail(parts[1]);
    else if (parts[0] === 'online' && parts[1]) { tab = 'online'; renderShopDetail(parts[1]); }
    else if (parts[0] === 'online') { tab = 'online'; renderOnlineHome(); }
    else if (parts[0] === 'settings') { tab = null; renderSettings(); }
    else renderStoreHome();
    document.querySelectorAll('.tabs a').forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (parts.length > 1 || parts[0] === 'settings') window.scrollTo(0, 0);
  }

  // ============================================================ 実店舗
  const evalStore = (r, opts) => E.evaluateStore(r, S.defs, S.settings, opts);
  const catLabel = (c) => S.defs.categories[c] || 'その他';

  /** おすすめの組み合わせの「支払いに使うサービス」（支払いが5サービス外なら提示カードのサービス） */
  const comboService = (c) => { if (!c) return ''; const pay = c.parts.find((p) => p.type === 'payment'); return (pay || c.parts[0] || {}).service || ''; };

  function storeCard(r) {
    const ev = evalStore(r);
    const best = ev.best;
    const rec = best
      ? `<div class="rec svc-${comboService(best)}"><div class="rec-body"><div class="rec-label">🏆 おすすめ</div><div class="rec-method">${esc(best.label)}</div></div><div class="rec-rate">${pct(best.effectiveRate)}</div></div>`
      : `<div class="rec none"><div class="rec-body"><div class="rec-label">判定不可</div><div class="rec-method" style="color:inherit">還元率 要確認</div></div></div>`;
    const camp = ev.campaignBest
      ? `<div class="camp-line">🎉 キャンペーン時：${esc(ev.campaignBest.label)} ${pct(ev.campaignBest.effectiveRate)}（〜${md(ev.campaignBest.endsAt)}）</div>`
      : '';
    return `<article class="card">
      <a href="#/store/${encodeURIComponent(r.id)}">
        <div class="card-meta"><span>${esc(catLabel(r.category))}</span>${couponBadges(r)}${r.isSample ? '<span class="badge b-sample">サンプル</span>' : ''}</div>
        <h3>${esc(r.name)}</h3>
        ${rec}${camp}
      </a>${favBtn('store', r.id)}</article>`;
  }

  function storeChips() {
    const cats = ['all', ...Object.keys(S.defs.categories)];
    return cats.map((c) => `<button class="chip" data-cat="${c}" aria-pressed="${S.ui.sc === c}">${c === 'all' ? 'すべて' : esc(catLabel(c))}</button>`).join('');
  }

  function renderStoreHome() {
    app.innerHTML = `
      ${S.storesMeta && S.stores.some((s) => s.isSample) ? `<p class="banner">現在のデータは<strong>サンプル（架空のチェーン）</strong>です。実在のお店の情報ではありません。</p>` : ''}
      <div class="search" role="search">
        <span class="ico">🔍</span>
        <input id="q" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="チェーン名で検索（例：マツキヨ）" value="${esc(S.ui.sq)}" aria-label="店舗を検索">
        <button class="clear" type="button" aria-label="検索語を消す" ${S.ui.sq ? '' : 'hidden'}>×</button>
      </div>
      <div class="chips" role="group" aria-label="カテゴリー">${storeChips()}</div>
      <div id="results"></div>`;
    const q = app.querySelector('#q');
    const clear = app.querySelector('.clear');
    q.addEventListener('input', () => { S.ui.sq = q.value; clear.hidden = !q.value; renderStoreResults(); });
    clear.addEventListener('click', () => { q.value = ''; S.ui.sq = ''; clear.hidden = true; renderStoreResults(); q.focus(); });
    app.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
      S.ui.sc = b.dataset.cat;
      app.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', x === b));
      renderStoreResults();
    }));
    renderStoreResults();
  }

  function section(title, items, render, note) {
    if (!items.length) return '';
    return `<section class="section"><h2>${title}${note ? ` <small>${note}</small>` : ''}</h2><div class="list grid2">${items.map(render).join('')}</div></section>`;
  }

  function renderStoreResults() {
    const box = app.querySelector('#results');
    const { sq, sc } = S.ui;
    const byCat = (r) => sc === 'all' || r.category === sc;
    if (sq.trim() || sc !== 'all') {
      const hits = S.stores.filter((r) => byCat(r) && E.matches(r, sq));
      box.innerHTML = hits.length
        ? section(`検索結果`, hits, storeCard, `${hits.length}件`)
        : `<p class="empty"><strong>見つかりませんでした</strong>「${esc(sq)}」${sc !== 'all' ? `（${esc(catLabel(sc))}）` : ''}に一致するチェーンはまだ登録されていません。<br>表記を変える（ひらがな・略称など）か、カテゴリーを「すべて」にしてみてください。</p>`;
      return;
    }
    const pick = (ids) => ids.map((id) => S.storeById[id]).filter(Boolean);
    let html =
      section('⭐ お気に入り', pick(LS.get(K.favS, [])), storeCard) +
      section('🕘 最近見たお店', pick(LS.get(K.recS, [])).slice(0, 4), storeCard) +
      section('🎟 クーポン確認', S.stores.filter((r) => (r.coupons || []).length), storeCard, 'アプリでクーポンを確認してから支払う');
    for (const c of Object.keys(S.defs.categories)) {
      const list = S.stores.filter((r) => r.category === c).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      html += section(esc(catLabel(c)), list, storeCard);
    }
    box.innerHTML = html;
  }

  function methodRows(ev, keys) {
    return keys.map((k) => {
      const m = ev.byKey[k];
      const def = S.defs.methods[k];
      const e = m.entry || {};
      let rateTxt; let off = false; let badge;
      if (m.reason === '比較対象外のサービス') { rateTxt = '対象外'; off = true; badge = '<span class="badge b-no">比較対象外</span>'; }
      else if (m.available === false) { rateTxt = '利用不可'; off = true; badge = '<span class="badge b-no">利用不可</span>'; }
      else if (m.available == null) { rateTxt = '要確認'; badge = '<span class="badge b-unk">利用可否 要確認</span>'; }
      else {
        rateTxt = m.rate != null && E.COUNTABLE_STATUS.has(m.status) ? pct(m.rate) : '要確認';
        badge = statusBadge(m.status);
      }
      const meta = [badge, scopeBadge(m.scope)];
      if (m.rankApplied) meta.push(`<span class="badge b-ok">${esc(S.defs.rakutenRanks[m.rankApplied])}会員の特典を反映</span>`);
      if (m.missing && m.missing.length) meta.push(`<span class="badge b-unk">条件未達：${esc(m.missing.map((x) => S.defs.capabilities[x] || x).join('、'))}</span>`);
      if (def.type === 'presentation' && m.available === true) {
        const st = E.stackInfo(m);
        meta.push(`<span class="badge ${E.COUNTABLE_STATUS.has(st.status) ? 'b-ok' : 'b-unk'}">${esc(st.text)}</span>`);
      }
      if (e.earn && e.earn.basis === 'tax_excluded') meta.push('<span>税抜金額が対象</span>');
      if (e.earn && e.earn.per) meta.push(`<span>${e.earn.per}円ごとに${e.earn.points}pt</span>`);
      if (e.condition) meta.push(`<span>${esc(e.condition)}</span>`);
      if (e.note) meta.push(`<span>${esc(e.note)}</span>`);
      return `<div class="mrow ${off ? 'off' : ''}"><span>${esc(def.label)}</span><span class="rate">${rateTxt}</span><div class="meta">${meta.join('')}</div></div>`;
    }).join('');
  }

  function servicesPanel(ev, typeFilter) {
    const groups = S.settings.priority.map((svc) => {
      const keys = Object.keys(S.defs.methods).filter((k) => S.defs.methods[k].service === svc && (!typeFilter || S.defs.methods[k].type === typeFilter));
      if (!keys.length) return '';
      return `<div class="svc"><div class="svc-name"><span class="svc-dot" style="background:${svcColor(svc)}"></span>${esc(S.defs.services[svc].label)}</div>${methodRows(ev, keys)}</div>`;
    });
    // 優先順位にないサービス（無効化されたもの）も最後に表示
    const rest = Object.keys(S.defs.services).filter((s) => !S.settings.priority.includes(s)).map((svc) => {
      const keys = Object.keys(S.defs.methods).filter((k) => S.defs.methods[k].service === svc && (!typeFilter || S.defs.methods[k].type === typeFilter));
      return `<div class="svc"><div class="svc-name"><span class="svc-dot" style="background:${svcColor(svc)}"></span>${esc(S.defs.services[svc].label)}</div>${methodRows(ev, keys)}</div>`;
    });
    return groups.join('') + rest.join('');
  }

  function breakdown(combo) {
    return `<ul class="breakdown">${combo.parts.map((p) => {
      const bonus = p.bonuses.map((b) => `<br><small>＋${esc(b.title)} ${pct(b.rate)}</small>`).join('');
      const base = p.baseUnknown ? '通常分 要確認' : pct(p.rate - p.bonuses.reduce((s, b) => s + (b.rate || 0), 0));
      return `<li><span>${esc(p.label)}（${base}）${bonus}</span><span class="num">${p.points}pt</span></li>`;
    }).join('')}</ul>`;
  }

  function renderStoreDetail(id) {
    const r = S.storeById[id];
    if (!r) { app.innerHTML = `<a class="back" href="#/">‹ 戻る</a><p class="empty"><strong>見つかりません</strong>データから削除された可能性があります。</p>`; return; }
    pushRecent(K.recS, id);
    const amount = S.ui.amount ?? S.settings.referenceAmount;
    const tax = S.ui.tax ?? r.defaultTaxRate ?? S.settings.defaultTaxRate;
    const ev = evalStore(r, { amount, taxRate: tax });
    const best = ev.best;

    const hero = best
      ? `<div class="hero svc-${comboService(best)}"><div class="k">🏆 通常時のおすすめ</div>
          <div class="v"><div class="method">${esc(best.label)}</div><div class="rate">${pct(best.effectiveRate)}</div></div>
          ${breakdown(best)}
          <p class="reason">${esc(ev.reason)}</p>
          ${best.conditions.map((c) => `<p class="cond">⚠ 条件：${esc(c)}</p>`).join('')}
        </div>`
      : `<div class="hero none"><div class="k">判定不可</div><div class="v"><div class="method">還元率 要確認</div></div><p class="reason">${esc(ev.reason)}</p></div>`;

    const camp = ev.campaignBest
      ? `<div class="hero camp"><div class="k">🎉 現在のキャンペーン適用時（終了日 ${ymd(ev.campaignBest.endsAt)}）</div>
          <div class="v"><div class="method">${esc(ev.campaignBest.label)}</div><div class="rate">${pct(ev.campaignBest.effectiveRate)}</div></div>
          ${breakdown(ev.campaignBest)}
          ${ev.campaignBest.conditions.map((c) => `<p class="cond">⚠ 条件：${esc(c)}</p>`).join('')}
          ${ev.activeCampaigns.filter((c) => c.conditions).map((c) => `<p class="cond">⚠ ${esc(c.conditions)}</p>`).join('')}
        </div>`
      : '';

    const ranking = ev.ranking.slice(0, 5);
    const rule = r.pointCardRule;
    const ruleTxt = rule && E.COUNTABLE_STATUS.has(rule.status || 'unverified')
      ? `ポイントカードは1会計につき${rule.maxCards}枚まで ${statusBadge(rule.status)} ${scopeBadge(rule.scope)}${rule.note ? `<br><small>${esc(rule.note)}</small>` : ''}`
      : `${statusBadge('unverified')} 何枚まで提示できるか未確認のため、1枚として計算しています`;

    app.innerHTML = `
      <a class="back" href="#/">‹ 一覧へ</a>
      ${r.isSample ? '<p class="banner">これは<strong>サンプル（架空）</strong>のチェーンです。表示される還元率は動作確認用の仮の数値です。</p>' : ''}
      <div class="detail-head"><h1>${esc(r.name)}</h1>${favBtn('store', r.id)}</div>
      <p class="sub">${esc(catLabel(r.category))} ・ チェーン共通の情報</p>

      ${hero}
      ${camp}
      ${couponPanel(r)}

      <div class="panel">
        <h2>金額を変えて計算</h2>
        <div class="calc">
          <label>支払額 <input id="amt" type="number" inputmode="numeric" min="1" step="1" value="${amount}"></label>
          <label>税率 <select id="tax">
            <option value="0.08" ${tax === 0.08 ? 'selected' : ''}>8%（食品）</option>
            <option value="0.1" ${tax === 0.1 ? 'selected' : ''}>10%</option></select></label>
        </div>
        <p class="foot" style="margin-top:6px">付与単位（○円ごと）の端数切り捨て・税抜対象・付与上限を反映して計算します。税率は「税抜金額が対象」のポイントにだけ影響します。</p>
      </div>

      <div class="panel">
        <h2>組み合わせランキング（通常時）</h2>
        ${ranking.length ? `<ol class="ranking">${ranking.map((c) => `<li><span>${esc(c.label)}</span><span class="num">${pct(c.effectiveRate)}</span></li>`).join('')}</ol>` : '<p class="sub">確認済みの組み合わせがありません。</p>'}
        <p class="foot">${yen(ev.amount)}支払い時の獲得ポイント（1pt=1円換算）で比較。</p>
      </div>

      <div class="panel">
        <h2>決済サービス別の還元率</h2>
        ${servicesPanel(ev)}
      </div>

      <div class="panel">
        <h2>併用条件</h2>
        <p class="sub" style="font-size:14px">${ruleTxt}</p>
        <p class="foot" style="margin-top:6px">支払いは1会計につき1つです。ポイントカード提示は「支払い方法との併用が確認済み」のものだけ合算します。</p>
      </div>

      ${ev.campaigns.length ? `<div class="panel"><h2>キャンペーン</h2><ul class="plain">${ev.campaigns.map((c) => `<li>${esc(c.title)}：${c.start ? ymd(c.start) : '?'}〜${c.end ? ymd(c.end) : '終了日不明'} <span class="badge ${c.state.active ? 'b-camp' : 'b-no'}">${esc(c.state.active ? '開催中' : c.state.reason)}</span> ${scopeBadge(c.scope)}</li>`).join('')}</ul></div>` : ''}

      ${r.notes.length ? `<div class="panel"><h2>注意事項</h2><ul class="plain">${r.notes.map((n) => `<li>${esc(n.text)} ${scopeBadge(n.scope)}</li>`).join('')}</ul></div>` : ''}

      <div class="panel">
        <h2>情報ソース</h2>
        ${r.sources.length ? `<ul class="plain">${r.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a> ${scopeBadge(s.scope)}${s.checkedAt ? ` <small>(${ymd(s.checkedAt)}確認)</small>` : ''}${s.via ? `<br><small class="badge b-cond">${esc(s.via)}</small>` : ''}</li>`).join('')}</ul>` : `<p class="sub">${r.isSample ? 'サンプルデータのため情報ソースはありません。' : '情報ソース未登録（要確認）'}</p>`}
        <dl class="kv" style="margin-top:10px"><dt>最終確認日</dt><dd>${r.checkedAt ? ymd(r.checkedAt) : '未確認'}</dd></dl>
      </div>
      <p class="foot">チェーン全体の情報です。一部の店舗（駅ナカ・商業施設内など）では使える決済が異なる場合があります。還元率・キャンペーンは変更されることがあるため、高額な買い物の前には公式情報を確認してください。</p>`;

    const amt = app.querySelector('#amt');
    const taxSel = app.querySelector('#tax');
    const rerender = () => {
      const v = parseInt(amt.value, 10);
      if (!(v > 0)) return;
      S.ui.amount = v; S.ui.tax = parseFloat(taxSel.value);
      const y = window.scrollY;
      renderStoreDetail(id);
      window.scrollTo(0, y);
      app.querySelector('#amt').focus({ preventScroll: true });
    };
    amt.addEventListener('change', rerender);
    taxSel.addEventListener('change', rerender);
  }

  // ============================================================ オンライン（楽天リーベイツ）
  const oCatLabel = (c) => S.defs.onlineCategories[c] || 'その他';
  const evalShop = (s, opts) => E.evaluateOnline(s, S.defs, S.settings, opts);

  function listedBadge(ev, shop) {
    if (shop.isCandidate) return '<span class="badge b-unk">調査前・要確認</span>';
    if (ev.rebates.listed === true && ev.rebates.countable) return '<span class="badge b-ok">リーベイツ対応</span>';
    if (ev.rebates.listed === false && E.COUNTABLE_STATUS.has(ev.rebates.status)) return '<span class="badge b-no">リーベイツ非対応</span>';
    return '<span class="badge b-unk">対応 要確認</span>';
  }

  function currentRebates(ev) {
    const c = ev.rebates.activeCampaign;
    if (c) return { label: c.rateLabel, camp: true };
    if (ev.rebates.normal.known) return { label: ev.rebates.normal.rateLabel, camp: false };
    return null;
  }

  function upcomingBlock() {
    const list = (S.onlineMeta && S.onlineMeta.upcomingSales) || [];
    if (!list.length) return '';
    return `<details class="upcoming">
      <summary>📅 大型セール予定：${list.map((u) => esc(u.short || u.title)).join('・')} <span class="muted">（日程は公式発表待ち）</span></summary>
      <ul>${list.map((u) => `<li><strong>${esc(u.title)}</strong>：${esc(u.expected)}${u.note ? `<br><span class="muted">${esc(u.note)}</span>` : ''}${u.url ? ` <a href="${esc(u.url)}" target="_blank" rel="noopener">公式 ↗</a>` : ''}</li>`).join('')}</ul>
    </details>`;
  }

  function shopCard(shop) {
    const ev = evalShop(shop);
    const cur = currentRebates(ev);
    let rec;
    const ex = (ev.extras || []).filter((x) => x.countable);
    if (ev.rebates.listed === false && E.COUNTABLE_STATUS.has(ev.rebates.status) && ex.length) {
      rec = `<div class="rec"><div class="rec-body"><div class="rec-label">リーベイツ対象外 → 代わりに</div><div class="rec-method">${esc(ex[0].label)}</div></div><div class="rec-rate">${pct(ex[0].rate)}</div></div>`;
    } else if (ev.rebates.listed === false && E.COUNTABLE_STATUS.has(ev.rebates.status)) {
      rec = `<div class="rec none"><div class="rec-body"><div class="rec-label">楽天リーベイツ</div><div class="rec-method" style="color:inherit">対象外ショップ</div></div></div>`;
    } else if (cur) {
      rec = `<div class="rec"><div class="rec-body"><div class="rec-label">${cur.camp ? '🎉 期間限定ポイントバック' : '楽天リーベイツ ポイントバック'}</div><div class="rec-method">${cur.camp ? `通常 ${esc(ev.rebates.normal.rateLabel || '要確認')} → ` : ''}経由で購入</div></div><div class="rec-rate">${esc(cur.label)}</div></div>`;
    } else {
      rec = `<div class="rec none"><div class="rec-body"><div class="rec-label">楽天リーベイツ</div><div class="rec-method" style="color:inherit">ポイントバック率 要確認</div></div></div>`;
    }
    const c = ev.rebates.activeCampaign;
    const camp = c ? `<div class="camp-line">🎉 ${esc(c.title)}（〜${md(c.end)}）</div>` : '';
    const ft = (ev.rebates.firstTime && ev.rebates.firstTime.valid ? `<span class="badge b-camp">初回特典 ${esc(ev.rebates.firstTime.rateLabel)}</span>` : '')
      + (ev.verdict === 'ichiba' ? '<span class="badge b-vs">🆚 楽天市場の方がお得</span>' : ev.verdict === 'rebates' ? '<span class="badge b-vs">🆚 リーベイツ経由がお得</span>' : ev.verdict === 'tie' ? '<span class="badge b-vs">🆚 楽天市場と同等</span>' : '');
    return `<article class="card">
      <a href="#/online/${encodeURIComponent(shop.id)}">
        <div class="card-meta"><span>${esc(oCatLabel(shop.category))}</span>${listedBadge(ev, shop)}${ft}${couponBadges(shop)}${shop.isSample ? '<span class="badge b-sample">サンプル</span>' : ''}</div>
        <h3>${esc(shop.name)}</h3>
        ${rec}${camp}
      </a>${favBtn('shop', shop.id)}</article>`;
  }

  function sortShops(list, how) {
    const withEv = list.map((s) => ({ s, ev: evalShop(s) }));
    const cmpName = (a, b) => a.s.name.localeCompare(b.s.name, 'ja');
    if (how === 'name') withEv.sort(cmpName);
    else if (how === 'rate') withEv.sort((a, b) => b.ev.sortRate - a.ev.sortRate || cmpName(a, b));
    else {
      // おすすめ順：還元率が確認できているもの → キャンペーン中 → 率 → 名前
      const known = (x) => (x.ev.sortRate >= 0 && x.ev.rebates.countable && x.ev.rebates.listed ? 1 : 0);
      withEv.sort((a, b) => known(b) - known(a) || (b.ev.rebates.activeCampaign ? 1 : 0) - (a.ev.rebates.activeCampaign ? 1 : 0) || b.ev.sortRate - a.ev.sortRate || cmpName(a, b));
    }
    return withEv.map((x) => x.s);
  }

  function renderOnlineHome() {
    const cats = ['all', ...Object.keys(S.defs.onlineCategories)];
    const hasSample = S.shops.some((s) => s.isSample);
    app.innerHTML = `
      ${hasSample ? '<p class="banner">【サンプル】は架空のショップです。</p>' : ''}
      ${upcomingBlock()}
      ${S.onlineMeta.pointCap ? `<p class="foot" style="margin:8px 2px 0">※ ${esc(S.onlineMeta.pointCap)}</p>` : ''}
      <div class="search" role="search">
        <span class="ico">🔍</span>
        <input id="oq" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="ショップ名で検索（例：Apple）" value="${esc(S.ui.oq)}" aria-label="ショップを検索">
        <button class="clear" type="button" aria-label="検索語を消す" ${S.ui.oq ? '' : 'hidden'}>×</button>
      </div>
      <div class="chips" role="group" aria-label="カテゴリー">${cats.map((c) => `<button class="chip" data-cat="${c}" aria-pressed="${S.ui.oc === c}">${c === 'all' ? 'すべて' : esc(oCatLabel(c))}</button>`).join('')}</div>
      <div class="toolbar">
        <button class="chip" id="f-camp" aria-pressed="${S.ui.onlyCamp}">🎉 キャンペーン中</button>
        <button class="chip" id="f-coupon" aria-pressed="${!!S.ui.onlyCoupon}">🎟 クーポン確認</button>
        <select id="sort" aria-label="並び替え">
          <option value="recommended" ${S.ui.sort === 'recommended' ? 'selected' : ''}>おすすめ順</option>
          <option value="rate" ${S.ui.sort === 'rate' ? 'selected' : ''}>還元率が高い順</option>
          <option value="name" ${S.ui.sort === 'name' ? 'selected' : ''}>名前順</option>
        </select>
      </div>
      <div id="oresults"></div>
      <p class="foot">楽天リーベイツは、リーベイツのページを経由して<strong>オンライン</strong>で購入した場合のポイントバックです。実店舗での購入や、経由せずに直接アクセスした購入は原則対象外です。還元率は変わるため、購入直前に公式ページで再確認してください。</p>`;
    const q = app.querySelector('#oq');
    const clear = app.querySelector('.clear');
    q.addEventListener('input', () => { S.ui.oq = q.value; clear.hidden = !q.value; renderOnlineResults(); });
    clear.addEventListener('click', () => { q.value = ''; S.ui.oq = ''; clear.hidden = true; renderOnlineResults(); q.focus(); });
    app.querySelectorAll('.chips .chip').forEach((b) => b.addEventListener('click', () => {
      S.ui.oc = b.dataset.cat;
      app.querySelectorAll('.chips .chip').forEach((x) => x.setAttribute('aria-pressed', x === b));
      renderOnlineResults();
    }));
    const tog = (elId, key) => app.querySelector(elId).addEventListener('click', (e) => {
      S.ui[key] = !S.ui[key]; e.currentTarget.setAttribute('aria-pressed', S.ui[key]); renderOnlineResults();
    });
    tog('#f-camp', 'onlyCamp');
    tog('#f-coupon', 'onlyCoupon');
    app.querySelector('#sort').addEventListener('change', (e) => { S.ui.sort = e.target.value; renderOnlineResults(); });
    renderOnlineResults();
  }

  function renderOnlineResults() {
    const box = app.querySelector('#oresults');
    const { oq, oc, onlyCamp, onlyFirst, onlyCoupon, sort } = S.ui;
    const filtered = oq.trim() || oc !== 'all' || onlyCamp || onlyFirst || onlyCoupon;
    if (filtered) {
      let hits = S.shops.filter((s) => (oc === 'all' || s.category === oc) && E.matches(s, oq) && (!onlyCoupon || (s.coupons || []).length));
      if (onlyCamp || onlyFirst) {
        hits = hits.filter((s) => {
          const ev = evalShop(s);
          return (!onlyCamp || ev.rebates.activeCampaign) && (!onlyFirst || (ev.rebates.firstTime && ev.rebates.firstTime.valid));
        });
      }
      hits = sortShops(hits, sort);
      box.innerHTML = hits.length
        ? section('検索結果', hits, shopCard, `${hits.length}件`)
        : `<p class="empty"><strong>見つかりませんでした</strong>${oq ? `「${esc(oq)}」に一致する` : '条件に合う'}ショップは登録されていません。<br>未登録のショップは、楽天リーベイツ公式サイトで直接確認してください。</p>`;
      return;
    }
    const evs = S.shops.map((s) => ({ s, ev: evalShop(s) }));
    const pick = (ids) => ids.map((id) => S.shopById[id]).filter(Boolean);
    const camp = evs.filter((x) => x.ev.rebates.activeCampaign).map((x) => x.s);
    const high = evs.filter((x) => x.ev.sortRate > 0).sort((a, b) => b.ev.sortRate - a.ev.sortRate).slice(0, 5).map((x) => x.s);
    const popular = sortShops(S.shops.filter((s) => s.popular), 'recommended');
    let html =
      section('⭐ お気に入り', pick(LS.get(K.favO, [])), shopCard) +
      section('🕘 最近見たショップ', pick(LS.get(K.recO, [])).slice(0, 4), shopCard) +
      section('🎉 期間限定キャンペーン', sortShops(camp, 'rate'), shopCard) +
      section('📈 高還元率ショップ', high, shopCard, '現在の還元率順') +
      section('🔥 人気の楽天リーベイツ対応ショップ', popular, shopCard);
    for (const c of ['cosme', 'fashion', 'electronics', 'daily', 'travel', 'department', 'other']) {
      html += section(esc(oCatLabel(c)), sortShops(S.shops.filter((s) => s.category === c), 'recommended'), shopCard);
    }
    box.innerHTML = html;
  }

  function ichibaPanel(shop, ev) {
    const ic = shop.ichiba;
    if (!ic) return '';
    if (!ic.exists) return `<div class="panel"><h2>🆚 楽天市場の公式店</h2><p class="sub" style="font-size:14px">${esc(ic.note || '公式店なし')}（${ymd(ic.checkedAt)}確認）</p></div>`;
    const r = ev.totals.normal; const i = ev.ichiba;
    const win = ev.verdict === 'ichiba' ? '楽天市場の公式店で買う方がお得' : ev.verdict === 'rebates' ? '楽天リーベイツ経由で公式サイトから買う方がお得' : 'どちらも同じ';
    return `<div class="panel compare">
      <h2>🆚 リーベイツ経由 vs 楽天市場の公式店</h2>
      <p class="verdict">👑 ${esc(win)}</p>
      <div class="split">
        <div class="${ev.verdict === 'rebates' ? 'win' : ''}"><div class="k">リーベイツ経由で公式サイト</div><div class="v">${r.value.toLocaleString('ja-JP')}pt</div><div class="k">実質${pct(r.rate)}（①＋②${(ev.extras || []).length ? '＋③' : ''}）</div></div>
        <div class="${ev.verdict === 'ichiba' ? 'win' : ''}"><div class="k">楽天市場：${esc(ic.shopName)}</div><div class="v">${i.value.toLocaleString('ja-JP')}pt</div><div class="k">実質${pct(i.rate)}</div></div>
      </div>
      <ul class="breakdown">${i.parts.map((x) => `<li><span>${esc(x.label)}（${pct(x.rate)}）</span><span class="num">${x.points}pt</span></li>`).join('')}</ul>
      <p class="foot">${yen(ev.amount)}（税込）の買い物で同じ価格と仮定。楽天市場のポイントは税抜価格が対象。${esc(ic.note || '')}</p>
      <a class="btn" href="${esc(ic.url)}" target="_blank" rel="noopener" style="margin-top:8px">楽天市場の公式店を開く ↗</a>
      <p class="foot" style="margin-top:6px">SPUの追加倍率は「設定」で変更できます（現在 +${Number(S.settings.ichibaSpuExtra) || 0}%）。</p>
    </div>`;
  }

  function linkBtn(url, label, primary) {
    return url
      ? `<a class="btn ${primary ? 'primary' : ''}" href="${esc(url)}" target="_blank" rel="noopener">${label} ↗</a>`
      : `<a class="btn" aria-disabled="true">${label}（URL未登録・要確認）</a>`;
  }

  function renderShopDetail(id) {
    const shop = S.shopById[id];
    if (!shop) { app.innerHTML = `<a class="back" href="#/online">‹ 戻る</a><p class="empty"><strong>ショップが見つかりません</strong></p>`; return; }
    pushRecent(K.recO, id);
    const amount = S.ui.oamount ?? 10000;
    const shipping = S.ui.oship ?? 0;
    const ev = evalShop(shop, { amount, shipping, taxRate: 0.1 });
    const rb = ev.rebates;
    const src = shop.rebates || {};
    const cur = currentRebates(ev);
    const best = ev.payment.best;

    let hero;
    if (rb.listed === false && E.COUNTABLE_STATUS.has(rb.status)) {
      hero = `<div class="hero none"><div class="k">楽天リーベイツ</div><div class="v"><div class="method">対象外ショップ</div></div><p class="reason">リーベイツのポイントバックはありません。決済ポイントのみ獲得できます。</p></div>`;
    } else if (cur) {
      hero = `<div class="hero ${cur.camp ? 'camp' : ''}"><div class="k">${cur.camp ? `🎉 期間限定（〜${ymd(rb.activeCampaign.end)}）` : '楽天リーベイツ 現在のポイントバック'}</div>
        <div class="v"><div class="method">リーベイツ経由で購入</div><div class="rate">${esc(cur.label)}</div></div>
        <p class="reason">購入直前に楽天リーベイツ公式ページで最新の還元率を確認してください。</p></div>`;
    } else {
      hero = `<div class="hero none"><div class="k">楽天リーベイツ</div><div class="v"><div class="method">${shop.isCandidate ? '掲載状況 要確認（調査前）' : 'ポイントバック率 要確認'}</div></div><p class="reason">公式ページで現在の還元率が確認できていないため、数値は表示していません。</p></div>`;
    }

    const rowRate = (label, val, extra) => `<div class="mrow"><span>${label}</span><span class="rate">${val}</span>${extra ? `<div class="meta">${extra}</div>` : ''}</div>`;
    const ft = rb.firstTime;
    const ratesPanel = `
      ${rowRate('通常時', rb.normal.known ? esc(rb.normal.rateLabel) : '要確認', rb.normal.known ? statusBadge(rb.status) : '')}
      ${rb.campaigns.length ? rb.campaigns.map((c) => rowRate(esc(c.title), esc(c.rateLabel || '要確認'), `<span class="badge ${c.state.active ? 'b-camp' : 'b-no'}">${esc(c.state.active ? '開催中' : c.state.reason)}</span><span>${c.start ? ymd(c.start) : '?'}〜${c.end ? ymd(c.end) : '終了日不明'}</span>${c.conditions ? `<span>${esc(c.conditions)}</span>` : ''}`)).join('') : rowRate('期間限定', 'なし／要確認')}
      ${ft ? rowRate('初回購入特典', ft.valid ? esc(ft.rateLabel) : '要確認', `${statusBadge(ft.status)}<span>${esc(ft.mode === 'replace' ? '通常分と置き換え' : '通常分に上乗せ')}</span>${ft.conditions ? `<span>${esc(ft.conditions)}</span>` : ''}`) : rowRate('初回購入特典', 'なし／要確認')}`;

    const totalBlock = (title, t, cls) => t ? `
      <div class="${cls || ''}" style="margin-top:12px">
        <div style="font-weight:700;font-size:14px">${title}</div>
        <div class="split">
          <div><div class="k">① リーベイツ分（楽天ポイント）</div><div class="v">${t.rebatesPoints.toLocaleString('ja-JP')}pt</div></div>
          <div><div class="k">② 決済分（${best ? esc(best.label) : '確認済みの決済なし'}）</div><div class="v">${t.paymentPoints.toLocaleString('ja-JP')}pt</div></div>
          ${(ev.extras || []).length ? `<div><div class="k">③ ${esc(ev.extras.map((x) => x.label).join('・'))}</div><div class="v">${(t.extraPoints || 0).toLocaleString('ja-JP')}pt</div></div>` : ''}
        </div>
        <div class="total"><span>合計（①＋②${(ev.extras || []).length ? '＋③' : ''}）</span><span class="v">${t.value.toLocaleString('ja-JP')}pt <small>/ 実質${pct(t.rate)}</small></span></div>
      </div>` : '';

    app.innerHTML = `
      <a class="back" href="#/online">‹ オンライン一覧へ</a>
      ${shop.isSample ? '<p class="banner">これは<strong>サンプル（架空）</strong>のショップです。数値は動作確認用です。</p>' : ''}
      ${shop.isCandidate ? '<p class="banner warn">調査前のショップです。楽天リーベイツに掲載されているか、還元率はいくらかは<strong>まだ確認していません</strong>。</p>' : ''}
      <div class="detail-head"><h1>${esc(shop.name)}</h1>${favBtn('shop', shop.id)}</div>
      <p class="sub">${esc(oCatLabel(shop.category))} ・ ${listedBadge(ev, shop)}</p>

      ${hero}

      <div class="btn-col" style="margin-top:12px">
        ${linkBtn(shop.rebatesUrl, '楽天リーベイツ経由で購入する', true)}
        ${linkBtn(shop.officialUrl, '公式ショップを開く（リーベイツ経由なし）', false)}
      </div>
      ${couponPanel(shop)}
      ${((S.onlineMeta && S.onlineMeta.upcomingSales) || []).filter((u) => (u.shops || []).includes(shop.id)).map((u) => `<p class="banner">📅 ${esc(u.title)}：${esc(u.expected)}。${esc(u.note || '')}</p>`).join('')}

      <div class="panel"><h2>ポイントバック率</h2>${ratesPanel}</div>
      ${(ev.extras || []).length ? `<div class="panel"><h2>その他のポイント</h2>${ev.extras.map((x) => `<div class="mrow"><span>${esc(x.label)}</span><span class="rate">${x.rate != null ? pct(x.rate) : '要確認'}</span><div class="meta">${statusBadge(x.status)}<span>${esc(x.condition || '')}</span></div></div>`).join('')}</div>` : ''}

      <div class="panel">
        <h2>実質還元シミュレーション</h2>
        <div class="calc">
          <label>商品代金（税込） <input id="oamt" type="number" inputmode="numeric" min="1" value="${amount}"></label>
          <label>送料 <input id="oship" type="number" inputmode="numeric" min="0" value="${shipping}"></label>
        </div>
        ${totalBlock('通常時', ev.totals.normal)}
        ${totalBlock(`🎉 キャンペーン適用時（〜${rb.activeCampaign ? ymd(rb.activeCampaign.end) : ''}）`, ev.totals.campaign)}
        ${totalBlock('🔰 初回購入時', ev.totals.firstTime)}
        <p class="foot">リーベイツ分は「税抜・送料除く商品代金」を対象に端数切り捨て（ショップ条件が分かればそれに従う）。決済分は送料を含む支払総額で計算。リーベイツ分と決済分は別々に付与されるポイントとして分けて表示し、同じポイントを二重に数えていません。</p>
      </div>

      ${ichibaPanel(shop, ev)}

      <div class="panel"><h2>支払い方法の比較（決済分）</h2>${servicesPanel(ev, 'payment')}</div>

      ${(src.conditions || []).length ? `<div class="panel"><h2>ポイント付与条件</h2><ul class="plain">${src.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
      <div class="panel"><h2>対象外になる条件</h2>
        ${(src.exclusions || []).length ? `<ul class="plain">${src.exclusions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '<p class="sub">ショップ固有の対象外条件：要確認</p>'}
        <ul class="plain" style="margin-top:8px;color:var(--text-2)">
          <li>実店舗での購入は対象外（オンライン購入専用）</li>
          <li>楽天リーベイツを経由せずに購入した場合は対象外</li>
          <li>店舗受け取り・アプリからの購入などはショップごとの条件を確認</li>
          <li>楽天市場の買い物とは別サービスです</li>
        </ul>
      </div>
      ${(shop.notes || []).length ? `<div class="panel"><h2>メモ</h2><ul class="plain">${shop.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
      <div class="panel">
        <h2>情報ソース</h2>
        ${(shop.sources || []).length ? `<ul class="plain">${shop.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a></li>`).join('')}</ul>` : `<p class="sub">${shop.isSample ? 'サンプルデータのため情報ソースはありません。' : '情報ソース未登録（要確認）'}</p>`}
        <dl class="kv" style="margin-top:10px"><dt>最終確認日</dt><dd>${shop.checkedAt ? ymd(shop.checkedAt) : '未確認'}</dd></dl>
      </div>`;

    const a = app.querySelector('#oamt');
    const sh = app.querySelector('#oship');
    const rerender = () => {
      const v = parseInt(a.value, 10); const s = parseInt(sh.value, 10) || 0;
      if (!(v > 0) || s < 0) return;
      S.ui.oamount = v; S.ui.oship = s;
      const y = window.scrollY; renderShopDetail(id); window.scrollTo(0, y);
    };
    a.addEventListener('change', rerender);
    sh.addEventListener('change', rerender);
  }

  // ============================================================ 自動更新の結果
  function autoUpdatePanel() {
    const u = (S.onlineMeta && S.onlineMeta.autoUpdate) || (S.storesMeta && S.storesMeta.autoUpdate);
    if (!u) return `<div class="panel"><h2>自動更新</h2><p class="sub" style="font-size:14px">毎朝6時に公式ページの数値を自動確認します（まだ実行されていません）。</p></div>`;
    const at = new Date(u.at);
    const when = isNaN(at) ? ymd(u.date) : at.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const fmt = (e) => e ? (e.rate != null ? `${e.upTo ? '最大' : ''}${e.rate}%` : `${e.per}円で${e.points}pt`) : '-';
    return `<div class="panel"><h2>自動更新（毎朝6時）</h2>
      <dl class="kv"><dt>最終確認</dt><dd>${esc(when)}</dd><dt>確認した項目</dt><dd>${u.checked}件</dd><dt>変更</dt><dd>${u.changed.length}件</dd><dt>要確認</dt><dd>${u.issues.length}件</dd></dl>
      ${u.changed.length ? `<h3 style="font-size:13px;margin:10px 0 4px">変更された項目</h3><ul class="plain">${u.changed.slice(0, 20).map((c) => `<li>${esc(c.where)}：${esc(fmt(c.from))} → <strong>${esc(fmt(c.to))}</strong></li>`).join('')}</ul>` : ''}
      ${u.issues.length ? `<h3 style="font-size:13px;margin:10px 0 4px">自動で読み取れなかった項目（以前の値のまま）</h3><ul class="plain">${u.issues.map((i) => `<li><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.where)}</a>：${esc(i.reason)}</li>`).join('')}</ul>` : ''}
      <p class="foot">自動で更新するのは、公式ページから機械的に読み取れる数値（リーベイツ還元率・ポイントカードの付与率）だけです。キャンペーンや条件の変化は反映されません。</p></div>`;
  }

  // ============================================================ 設定
  function renderSettings() {
    const st = S.settings;
    const d = S.defs;
    app.innerHTML = `
      <a class="back" href="#/">‹ 戻る</a>
      <h1 style="font-size:21px;margin:10px 0 0">設定</h1>
      <p class="sub">初期値は <code>data/settings.json</code>。ここでの変更はこの端末のブラウザにだけ保存されます。</p>

      <div class="panel"><h2>楽天</h2>
        <div class="form-row"><label for="rank">楽天会員ランク</label>
          <select id="rank">${Object.entries(d.rakutenRanks).map(([k, v]) => `<option value="${k}" ${st.rakutenRank === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
        ${(S.base.rakutenRankSchedule || []).map((x) => `<p class="foot" style="margin-top:0">予定：${ymd(x.from)}から${esc(d.rakutenRanks[x.rank] || x.rank)}（${LS.get(K.settings, {}).rakutenRank ? '手動設定中のため自動切替は停止中' : '自動で切り替わります'}）</p>`).join('')}
        <p class="foot" style="margin-top:0">ランク特典はデータに記載がある店舗だけで反映されます（すべての店舗で還元率が上がるわけではありません）。</p>
      </div>

      <div class="panel"><h2>比較する決済サービスと優先順位</h2>
        <p class="foot" style="margin-top:0">還元率が同じときは上にあるものを優先します。</p>
        <ol class="prio">${st.priority.map((svc, i) => `<li>
          <span class="n">${i + 1}</span>
          <input type="checkbox" data-svc="${svc}" ${st.enabledServices.includes(svc) ? 'checked' : ''} aria-label="${esc(d.services[svc].label)}を比較対象にする">
          <span class="svc-dot" style="background:${svcColor(svc)}"></span>
          <span class="name">${esc(d.services[svc].label)}</span>
          <button data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="上へ">▲</button>
          <button data-down="${i}" ${i === st.priority.length - 1 ? 'disabled' : ''} aria-label="下へ">▼</button></li>`).join('')}</ol>
      </div>

      <div class="panel"><h2>利用条件</h2>
        ${Object.entries(d.capabilities).map(([k, v]) => `<label class="form-row"><span>${esc(v)}</span><input type="checkbox" data-cap="${k}" ${st.capabilities.includes(k) ? 'checked' : ''}></label>`).join('')}
        <p class="foot" style="margin-top:0">ここでオフにした条件が必要な決済方法は、おすすめから除外されます。</p>
      </div>

      <div class="panel"><h2>計算</h2>
        <div class="form-row"><label for="ref">一覧で使う基準金額（円）</label><input id="ref" type="number" min="1" inputmode="numeric" value="${st.referenceAmount}" style="width:110px"></div>
        <div class="form-row"><label for="spu">楽天市場SPUの追加倍率（楽天カード以外・%）</label><input id="spu" type="number" min="0" step="0.1" inputmode="decimal" value="${Number(st.ichibaSpuExtra) || 0}" style="width:90px"></div>
        <div class="form-row"><span>ポイント価値</span><span>1ポイント＝1円</span></div>
      </div>

      <div class="panel"><h2>データ</h2>
        <dl class="kv"><dt>店舗データ更新</dt><dd>${ymd(S.storesMeta.updatedAt)}</dd><dt>オンラインデータ更新</dt><dd>${ymd(S.onlineMeta.updatedAt)}</dd><dt>今日</dt><dd>${ymd(today())}</dd></dl>
      </div>
      ${autoUpdatePanel()}

      <div class="btn-col" style="margin-top:16px"><button class="btn" id="reset">初期設定に戻す</button></div>`;

    const save = (patch) => {
      const o = { ...LS.get(K.settings, {}), ...patch };
      LS.set(K.settings, o);
      applySettings();
      renderSettings();
    };
    app.querySelector('#rank').addEventListener('change', (e) => save({ rakutenRank: e.target.value }));
    app.querySelectorAll('[data-svc]').forEach((cb) => cb.addEventListener('change', () => {
      const en = new Set(S.settings.enabledServices);
      if (cb.checked) en.add(cb.dataset.svc); else en.delete(cb.dataset.svc);
      save({ enabledServices: S.settings.priority.filter((s) => en.has(s)) });
    }));
    const move = (i, dir) => {
      const p = [...S.settings.priority];
      [p[i], p[i + dir]] = [p[i + dir], p[i]];
      save({ priority: p });
    };
    app.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => move(+b.dataset.up, -1)));
    app.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => move(+b.dataset.down, 1)));
    app.querySelectorAll('[data-cap]').forEach((cb) => cb.addEventListener('change', () => {
      const caps = new Set(S.settings.capabilities);
      if (cb.checked) caps.add(cb.dataset.cap); else caps.delete(cb.dataset.cap);
      save({ capabilities: [...caps] });
    }));
    app.querySelector('#ref').addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); if (v > 0) save({ referenceAmount: v }); });
    app.querySelector('#spu').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v >= 0) save({ ichibaSpuExtra: v }); });
    app.querySelector('#reset').addEventListener('click', () => { LS.del(K.settings); applySettings(); renderSettings(); });
  }

  // ------------------------------------------------------------ 共通イベント
  app.addEventListener('click', (e) => {
    const b = e.target.closest('.fav');
    if (!b) return;
    e.preventDefault();
    toggleFav(b.dataset.fav, b.dataset.id);
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on); b.textContent = on ? '★' : '☆';
    b.setAttribute('aria-label', on ? 'お気に入りから外す' : 'お気に入りに追加');
  });

  const offline = document.getElementById('offline-badge');
  const net = () => { offline.hidden = navigator.onLine; };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  net();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  init();
})();
