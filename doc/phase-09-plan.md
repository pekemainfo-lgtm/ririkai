# Phase 9 実装計画：前回からの続き（資格・分野・テーマ）＋学習モード（インプット/演習/高速周回）＋リリカイ済みカードの復帰

## Context
Phase 1〜8で ReRIKAI の学習セッション記録・AI分析・復習フラッシュカード・ノート写真は稼働中。利用者は勉強を継続的に行うため、次の使い勝手を要望（チャット指示。SPEC より利用者の直接指示を優先＝§28）：

1. **前回からの続き**：毎回ほぼ同じ資格・分野を学ぶので、資格・コース／分野／テーマを前回セッションから引き継いで初期表示したい。テーマは回ごとに変わることもあるので「自由記述＋過去5回分の候補から選択＋クリアボタン」。
2. **学習モード**：頭に入れる段階／演習する段階（初回〜2,3回）／最後の詰め、でAIに求めるものが違う。**インプット・演習・高速周回**の3モードを追加し、AI分析とカード生成を段階最適化する（利用者確定：インプット=基礎中心／演習=わからないことを手厚く／高速周回=覚えるべき点がはっきりしているので簡潔に）。
3. **カード内の表示順**：同じ概念のカードはセッションを重ねると補足が蓄積する。復習カードの答え面では、その補足を由来モード順 **高速周回（注意すべき点）→ インプット（基礎）→ 演習（手厚い補足）** で並べる（利用者確定：1枚の中身の順）。
4. **リリカイ済みカードの復帰**：一度「リリカイ!（＝mastered＝もう出さない）」としたカードも、結局理解していないと後で分かることがある。**一度非表示にしたカードを復習へ戻して再表示**できるようにする。

## バックエンド

### `backend/lib/cards.mjs`（純ロジック・テスト対象）
- **モード定数/正規化**：`export const STUDY_MODES = new Set(["input","practice","fast"])`、`export function sanitizeStudyMode(v)`（不正・未指定は `"input"`）。表示順 `export const MODE_PRIORITY = { fast:0, input:1, practice:2 }`（未知は 99）。
- **`buildCardItem`**：引数に `mode = "input"` を追加。カードに `mode: sanitizeStudyMode(mode)` を保存。補足の由来モードを並列配列で保持：`supplementModes: supplement.map(() => sanitizeStudyMode(mode))`（`supplement` と同じ長さ・同じ順序）。
- **`sortSupplementByMode(supplement, supplementModes)`（新規・export・純関数）**：`MODE_PRIORITY` で安定ソートした補足配列を返す（同モード内は元順を維持、`supplementModes` 欠落や長さ不一致の旧カードは並べ替えず元順を返す＝後方互換）。表示専用で保存データは並べ替えない。
- **補足union のモード対応**：新ヘルパ `unionSupplementWithModes(existSup, existModes, incomingSup, incomingMode, max=12)` を追加し、重複除去しつつ `supplement` と `supplementModes` を整列させて返す。既存行のモードは維持、新規行に `incomingMode` を付与。
- **`integrateAnswer`**：引数末尾に `newMode` を追加。`sameAnswer`（merged）分岐で `unionStrings` を `unionSupplementWithModes` に置き換え、`supplementModes` も更新して返す。`needs_review` 分岐は現状維持（`pendingAnswer` に `mode` も退避）。
- **`mergeCardData`（手動統合）**：`supplement` の union を `unionSupplementWithModes` に変更し `supplementModes` を整列維持。
- 旧カード（`mode`/`supplementModes` なし）は全経路で `sanitizeStudyMode`/欠落フォールバックで吸収。既存の signature は引数追加のみで後方互換。

### `backend/lib/openai.mjs`（モードで力点を変える）
- `buildAnalysisPrompt(input)`：`input.mode` に応じたモード指示ブロックを挿入。
  - **input（インプット/頭に入れる）**：基礎・定義・仕組みの体系整理を中心に。`noteText` を厚め（要点を漏れなく）。
  - **practice（演習/初回〜数回）**：わからない点を手厚く。`ambiguousPoints`・`misconceptions`・`confirmQuestions` を重視し、適用・条件・違いを掘る。
  - **fast（高速周回/最後の詰め）**：覚えるべき点は明確な前提で簡潔に。注意点・弱点・間違えやすい点だけを短く。`noteText` は要点のみ少なめ。
- `buildCardsPrompt(input, analysis)`：`input.mode` でカードの狙いを変える。input=基礎定義中心／practice=適用・条件・違い・弱点中心／fast=注意点・弱点に絞り新規は最小。
- プロンプト文字列内に現在のモード名（日本語）と方針を明示。`normalizeAnalysis` は変更不要。

### `backend/lib/markdown.mjs`
- `frontMatter` に `mode: ${yamlScalar(session.mode)}` を追加（`studyDate` 付近）。本文タイトル下に `> モード: <日本語ラベル>` を1行追加（任意・軽微）。

### `backend/index.mjs`
- `createSession`：`const mode = sanitizeStudyMode(body.mode)` を求め、`sessionItem.mode` と `jobItem.input.mode` に保存。
- `processSessionJob`：`buildSessionMarkdown({ ..., mode: session.mode })` を渡す。`completedSession` は `...session` 展開済みなので `mode` は自動継承。
- `adoptCards`：`buildCardItem({ ..., mode: session.mode })` を渡す（カードに由来モードが乗る）。
- `mergeAnswerIntoCard`：`integrateAnswer(card, answer, supplement, sourceSessionId, now, session?.mode)` のように統合先セッションのモードを渡す（`sessionSk` から取得済みの `session` を利用。無い場合は `"input"`）。
- `listDueCards`：返却前に各カードの `supplement` を `sortSupplementByMode(c.supplement, c.supplementModes)` で並べ替えた配列に差し替えて返す（**表示専用**・保存は不変）。
- **新アクション `listMasteredCards`**：`CARD#` を走査し `status==="active" && review?.mastered` を返す。
- **新アクション `reactivateCard`**（body `{cardId}`）：カード取得→`review.mastered=false`・`review.nextReviewDate=toJstDate(now)`（今日＝当日の復習に出す）に更新して `putItem`。`reviewCount` 等の履歴カウントは維持。返り値にカードを含める。
- `handler` に上記2アクションを分岐追加。
- `cards.mjs` から `sanitizeStudyMode`・`sortSupplementByMode` を import。

### `backend/lib/validate.mjs`
- 変更不要（フィールド許可制ではなく `mode` はそのまま通過することを確認済み）。

## フロントエンド

### `web/session.html`（前回からの続き＋モード選択）
- **モード選択UI**：基本情報に3択のセグメント（ラジオ）`インプット / 演習 / 高速周回`（value=input/practice/fast）。各モードの一言説明を `hint` で表示。`createSession` payload に `mode` を追加。
- **前回からの続き**：ページ読込時に `listSessions`（既存アクション）を1回呼び、
  - 直近セッションから `qualification`・`subject`・`topic`・`mode` を初期値としてプリフィル（すべて編集可）。
  - 過去セッションの `topic`（非空・重複除去）から**直近5件**を「テーマ候補」チップとして表示。チップ押下で `topic` 入力へ反映。
  - テーマ入力欄の隣に**クリア**ボタン（`topic` を空に）。
  - 直近セッションが無ければ従来どおり空＋モード既定=インプット。
- 結果表示に現在モードのラベルを軽く表示（任意）。

### `web/review.html`（カード内の補足をモード順に表示＋リリカイ済みの復帰）
- 補足は API（`listDueCards`）側で既に `高速周回→インプット→演習` 順に整列済みなので、現行の `supplement` 描画のままで並びが反映される（追加改修は基本不要）。必要なら各補足行頭に淡いモード印を付けるが既定は無印でノイズを避ける。
- **完了画面（doneArea）に「リリカイ済みカードを復習に戻す」**セクションを追加：`listMasteredCards` を呼び、mastered カードを一覧（質問＋答えの先頭）。各行に「復習に戻す」ボタン→`reactivateCard` を呼び、成功したら一覧から除去。0件なら非表示。復習キューが空の日でもこの導線から復帰できる。

### `web/calendar.html`（セッション詳細にモード表示）
- セッション詳細に `モード: <日本語ラベル>` を1行追加表示（`s.mode`）。

## テスト（§28.2・TypeScript不使用・`node --test`）
- `backend/test/cards.test.mjs` 追記：
  - `sanitizeStudyMode`（不正/未指定→input、input/practice/fast は保持）。
  - `buildCardItem` に `mode` を渡すと `mode` と `supplementModes`（長さ一致・全要素=mode）が入る。
  - `sortSupplementByMode`：fast→input→practice 順、未知は末尾、同モード内は安定、`supplementModes` 欠落時は元順。
  - `integrateAnswer`（merged 分岐）で新規補足に `newMode` が付き、既存補足のモードが維持される。
  - `mergeCardData` で `supplement` と `supplementModes` の整列が保たれる。
- `backend/test/markdown.test.mjs` 追記：front matter に `mode:` 行が出る。
- 全 `.mjs` に `node --check`、`cd backend && node --test`。モード別AI出力・前回引き継ぎUI・リリカイ復帰は実機E2Eで確認。

## デプロイ（apply は利用者＝§28.4）
- **新規AWSリソースなし**。`terraform init/validate/plan`（Lambda in-place 1件のみ）→ 利用者が `apply`。
- `aws s3 sync web/ s3://ririkai-web-naohiro/ --delete --exclude "*.test.mjs"` ＋ CloudFront `E1PCVM4MVGFZ8B` を `/*` 無効化。

## ドキュメント / メモリ
- `README.md`：モード（3種と各方針・`session.mode`/`job.input.mode`）、カード補足のモード別並び（`supplementModes`・`sortSupplementByMode`・高速→入力→演習）、前回からの続き（listSessions を用いたプリフィル＋過去5テーマ＋クリア）、リリカイ復帰（`listMasteredCards`/`reactivateCard`）を追記。
- 既存メモリ `ririkai-review-and-note-model.md` に「mastered は `reactivateCard` で復習へ戻せる」「補足はモード順表示」を追記。

## 検証（E2E・実機）
1. `node --test` 全パス（既存54件＋今回分）。`terraform validate && plan` が Lambda in-place 1件のみ。
2. apply＋sync 後、`session.html`：初回は空。1セッション作成後に再読込すると資格/分野/テーマ/モードが前回値でプリフィルされ、テーマ候補チップ（過去分）とクリアが機能する。
3. モード別に3セッション（input/practice/fast）を作成し、AI結果の力点が変わること（fast は簡潔・注意点中心、practice は曖昧点/確認質問が厚い、input は noteText 厚め）を確認。Markdown front matter に `mode` が入る。
4. 同一概念のカードを異なるモードのセッションで統合（`mergeAnswerIntoCard`）→ `review.html` の答え面で補足が 高速周回→インプット→演習 の順に並ぶ。
5. あるカードを「リリカイ!」→ `listDueCards` から消える。`review.html` 完了画面の「リリカイ済みカードを復習に戻す」で `reactivateCard`→当日の復習に再表示される。冪等な `reviewCard`（reviewId 重複）が壊れていないことも確認。
6. 確認用に作成したテストのセッション・カード・REVIEW・S3 を削除（**利用者の実データは保全**）→ §25 報告 → コミット＆push（origin/main）。

## 実装ステップ
1. `cards.mjs`（mode・supplementModes・sortSupplementByMode・union/merge/integrate 改修）。
2. `openai.mjs`（分析・カードのモード別プロンプト）＋ `markdown.mjs`（front matter mode）。
3. `index.mjs`（createSession/adoptCards/mergeAnswerIntoCard/listDueCards 整列・listMasteredCards・reactivateCard・handler 分岐）。
4. テスト追記 → `node --check` / `node --test`。
5. `session.html`（続き＋モード）、`review.html`（リリカイ復帰）、`calendar.html`（モード表示）。
6. `README.md` ＋ メモリ更新。
7. 利用者に apply＋sync 依頼 → E2E → テストデータ削除 → §25報告 → コミット＆push。
