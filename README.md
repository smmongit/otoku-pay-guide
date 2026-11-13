# お得な支払いガイド

お店（チェーン）の名前を検索すると、自分が使う5つの決済サービス（楽天／Olive・Vポイント／PayPay／dポイント・d払い／せたがやPay）の中から**一番お得な支払い方法**を判定する個人用Webアプリです。
「オンライン」タブでは**楽天リーベイツ**対応ショップの還元率を調べられます。

- 素の HTML / CSS / JavaScript だけで動きます（ビルド不要、依存パッケージなし）
- GitHub Pages で無料公開できます。PWA に対応しているので、ホーム画面に追加でき、オフラインでも見られます
- ログイン不要で、個人情報は扱いません。お気に入り・履歴・設定の変更はその端末のブラウザにだけ保存されます

## ファイル構成

| パス | 役割 |
|---|---|
| `index.html` / `css/style.css` | 画面 |
| `js/engine.js` | おすすめ判定ロジック（画面から独立） |
| `js/app.js` | 画面表示・検索・お気に入り・設定 |
| `data/stores.json` | 実店舗データ（1件＝1チェーン。支店名・住所・駅は持たない） |
| `data/online-shops.json` | 楽天リーベイツのショップデータ |
| `data/services.json` | 5サービス・決済手段・カテゴリーの定義 |
| `data/settings.json` | 個人設定（会員ランク・優先順位・ポイント価値など） |
| `manifest.json` / `sw.js` / `icons/` | PWA |
| `tests/engine.test.js` | 判定ロジックのテスト（`node tests/engine.test.js`） |

## 判定ルール（engine.js）

1. 比較するのは `settings.enabledServices` に入っているサービスだけです。
2. **支払いは1会計につき1つ**です。そのため、同じカードのポイントが二重に数えられることは構造上ありません。
3. ポイントカード提示は、`stack.status` が確認済み／条件付きで、その支払い方法と併用できる場合だけ合算します。提示できる枚数は `pointCardRule.maxCards` で決まり、未確認なら1枚として扱います。
4. `status: "unverified"`（要確認）の手段や、還元率・利用可否が不明な手段は計算に入れません。
5. `requires`（スマホのタッチ決済など）を満たさない手段はおすすめしません。条件は設定画面で切り替えられます。
6. 会員ランクの特典は、データに `rankEarn` が書かれている店舗だけで反映します。
7. キャンペーンは「終了日がある」「期間内」「確認済み」をすべて満たすものだけ有効にし、通常時のおすすめとは別枠で表示します。
8. 還元率が同じ場合は `settings.priority` の順（楽天→Olive→PayPay→dポイント→せたがやPay）で決めます。
9. ポイントは「○円ごとに○pt」の端数切り捨て・税抜対象・付与上限を反映して計算し、1pt＝1円で換算します。

**オンライン**：リーベイツ分（税抜・送料を除いた商品代金が対象）と決済分（支払総額が対象）を**別々に計算**し、合計を表示します。
- リーベイツのキャンペーン還元率は、通常率に**置き換え**て計算します。
- 初回購入特典は、`mode` が `add`（上乗せ）か `replace`（置き換え）かに従います。初回特典は通常時の合計には含めません。

## データの書き方

### 実店舗（`data/stores.json` の `chains`）
```jsonc
"methods": {
  "rakuten_pointcard": {
    "available": true,                 // true / false / null(要確認)
    "status": "confirmed",             // confirmed / conditional / unverified
    "earn": { "per": 200, "points": 1, "basis": "tax_excluded" },  // または { "rate": 1.0 }
    "rankEarn": { "platinum": { "per": 100, "points": 1 } },       // ランク特典が実在する場合だけ
    "stack": { "with": "any", "except": ["rakuten_pay"], "status": "confirmed" },  // 提示系のみ
    "requires": ["smartphone_touch"],  // 適用条件（services.json の capabilities）
    "condition": "スマホのタッチ決済のみ", "note": "..."
  }
},
"campaigns": [{ "id": "...", "title": "...", "method": "setagaya_pay", "earn": { "rate": 10, "maxPoints": 1000 },
                "start": "2026-11-01", "end": "2026-11-30", "status": "confirmed", "conditions": "..." }],
"sources": [{ "title": "公式ページ", "url": "https://..." }],
"checkedAt": "2026-11-13"
```
データはチェーン単位です。一部の店舗だけ条件が違う場合は、`status: "conditional"` と `condition`、または `notes` に書きます。

### オンライン（`data/online-shops.json`）
```jsonc
{ "id": "...", "name": "...", "aliases": ["..."], "category": "cosme", "popular": true,
  "officialUrl": "https://...", "rebatesUrl": "https://...",
  "rebates": { "listed": true, "status": "confirmed",
    "normal": { "earn": { "rate": 3 } },             // 1件あたりの固定ptなら { "fixedPoints": 300 }
    "campaigns": [{ "title": "...", "earn": { "rate": 6 }, "start": "...", "end": "...", "status": "confirmed" }],
    "firstTime": { "earn": { "fixedPoints": 500 }, "status": "conditional", "mode": "add", "conditions": "..." },
    "conditions": ["..."], "exclusions": ["..."] },
  "payments": { "rakuten_card": { "available": true, "status": "confirmed", "earn": { "per": 100, "points": 1 } } },
  "sources": [...], "checkedAt": "YYYY-MM-DD" }
```

データを更新したら、`sw.js` の `CACHE` 名（例：`opg-v1` → `opg-v2`）も変えてください。古い画面がキャッシュから表示され続けるのを防げます（データファイル自体は常にネットワークを優先して読み込みます）。

## ローカルで動かす

```bash
python3 -m http.server 8000
```
ブラウザで http://localhost:8000 を開きます。テストは `node tests/engine.test.js` で実行できます。

## データの状態

- **実店舗（`data/stores.json`）**：28チェーン分を、2026/11/13 に各決済サービスと各チェーンの公式ページで確認しました。
  - 情報の確度は `status` で管理します（confirmed＝確認済み／conditional＝条件付き／unverified＝要確認）。
  - 公式ページをクラウドから直接閲覧できず、検索結果の抜粋で確認したソースには `via` を付けています。
  - 計算に使うのは、確認済みと条件付きの情報だけです。
- **判定ロジックのテスト用データ**：`tests/fixtures/stores.sample.json`（架空のチェーン）。
- **オンライン（`data/online-shops.json`）**：楽天リーベイツへの掲載状況は未調査です。

## データの自動更新（毎朝6時）

`.github/workflows/update-data.yml` が、GitHub Actions で毎日 6:00（日本時間）に `scripts/update-data.mjs` を実行します。GitHub の無料機能だけで動き、Claude は使いません。

- **更新するもの**：公式ページから機械的に読み取れる数値だけです。
  - 楽天リーベイツの還元率
  - 楽天ポイントカード／dポイントカード／Vポイントの付与率（`data/stores.json` で `src` が付いている項目）
- **読み取れないとき**：データは書き換えず、`meta.autoUpdate.issues` に記録します。アプリの「設定」画面で確認できます。
- **テストが失敗したとき**：更新を保存しません。
- **手動で実行する**：GitHub のリポジトリ → Actions →「データ自動更新」→「Run workflow」。
- **自動では反映されないもの**：キャンペーンの開始・終了、条件の変更、新しい店舗の追加。これらは公式ページを確認して手動で更新します。

手元で実行する場合（Playwright が必要）：

```bash
npm install && npx playwright install chromium && npm run update-data
```
