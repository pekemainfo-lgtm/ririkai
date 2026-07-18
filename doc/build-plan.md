# ReRIKAI 構築プラン（フェーズ履歴）

学習者が自分の言葉で説明した内容をAIが分析し、理解度・復習カード・ノートを支援する Web サービス「ReRIKAI（リリカイ）」の構築フェーズ一覧。実装は SPEC.md に沿い、§28（追記：前提の確定事項）と利用者のチャット指示を最優先とする。各フェーズは利用者の承認を得てから実装し、フェーズ間で明示的に区切る。

## 前提・不変の制約
- `terraform apply` は**利用者のみ**が実行（§28.4）。Claude は init/validate/plan まで。
- `userId` はサーバ固定の `"naohiro"`。クライアント指定の userId/キーは信頼しない（§28.3/§23.8）。
- 既存の Eureka Study リソースには触れない。APIキーはコミットしない。
- E2E 検証後はテストデータのみ削除し、**利用者の実データは保全**する。
- TypeScript 不使用・`node --test` による純関数テスト（§28.2）。
- push 先: GitHub `origin/main`（https://github.com/pekemainfo-lgtm/ririkai ）。

## アーキテクチャ概要
- **Lambda**（nodejs22.x・単一関数 `ReRikaiApi`・action 分岐）／**API Gateway HTTP API**。
- **DynamoDB** 単一テーブル `ReRikaiTable`（PK=`USER#naohiro`、SK 接頭辞 `SESSION#`/`JOB#`/`CARD#`/`REVIEW#`）。
- **S3**：`ririkai-data-naohiro`（Markdown 正本・ノート写真、versioning+CORS）／`ririkai-web-naohiro`（静的Web、CloudFront `E1PCVM4MVGFZ8B` 経由）。
- **OpenAI Responses API**（`/v1/responses`, json_object）で分析・カード生成。
- Markdown が正本、DynamoDB は軽量インデックス（生の文字起こしは保持しない＝§3.2）。
- API: `https://x1y8yib6vd.execute-api.ap-northeast-1.amazonaws.com/api` ／ Web: `https://d2y939rwopq8ij.cloudfront.net`

## フェーズ一覧

| Phase | 内容 | コミット |
|------|------|---------|
| 1-3 | 既存調査・学習セッション・カレンダー | `7a0808a` |
| 4 | 復習カード（候補生成・採用・一覧・詳細・編集） | `c4eac8e` |
| 5 | カードの重複統合（検出・canonicalAnswer統合・needs_review・手動統合） | `173abcd` |
| 6 | 復習機能（今日の復習・3段階評価・次回復習日更新・履歴） | `270459a` |
| 7 | ノート写真・仕上げ・カレンダー集計表示 | `6651ba1` |
| 8 | 復習フラッシュカード化・ノートに書き写す内容のAI生成・結果後の写真保存 | `aa2cab1` |
| 9 | 前回からの続き・学習モード・カード補足のモード順・リリカイ済み復帰 | （作業中） |

---

### Phase 1-3 — 学習セッション・カレンダー（`7a0808a`）
- 既存 Eureka Study 資源の調査と非干渉の確認。
- 学習セッション作成：基本情報＋目的＋文字起こしを保存し、非同期で AI 分析（理解できている点/曖昧な点/誤解の可能性/確認質問/復習事項/目的達成判定）。
- セッションごとに Markdown を S3 に生成（正本）。DynamoDB は索引。
- カレンダー表示でセッションを日付別に閲覧。

### Phase 4 — 復習カード（`c4eac8e`）
- AI がセッションから一問一答カード候補を生成（cardType/conceptKey/question/canonicalAnswer/supplement/reason）。
- 候補を編集して採用 → `CARD#` アイテム化。カード一覧・詳細・手動編集（編集後は answerSource=user で AI 自動上書きを防止）。

### Phase 5 — 重複統合（`173abcd`）
- 採用前に既存カードとの重複を検出（conceptKey+cardType 一致 or normalizedQuestion 一致）。
- 回答一致 → merged（supplement を union）／回答矛盾 → needs_review（既存維持・pendingAnswer 退避）。
- 利用者による手動統合（source を target へ吸収し merged 化）。

### Phase 6 — 復習（`270459a`）
- 今日の復習（nextReviewDate 到来カード）を出題。
- 当初は3段階評価（できた=+7 / あやしい=+3 / できなかった=+1）で次回復習日を更新。
- 復習履歴（`REVIEW#`）を reviewId + 条件付きPut で冪等記録。

### Phase 7 — ノート写真・仕上げ・集計（`6651ba1`）
- ノート写真アップロード：署名付き PUT でブラウザ→S3 直アップロード、GET で閲覧。データバケットに CORS 設定。
- ノート画像キー `notes/users/{userId}/{yyyy}/{mm}/{dd}/note_{imageId}.{ext}`（imageId/ext はサーバ生成、自ユーザ配下のみ受理）。
- カレンダーに新規カード数・復習予定数の集計バッジ、今日の復習/要確認への導線。

### Phase 8 — フラッシュカード化・書き写す内容・結果後の写真（`aa2cab1`）
- 復習UIをフラッシュカードに刷新：タップで表(質問)↔裏(答え+補足)、右上「詳細」でメタ情報。
- 下部2択：「リリカイ!」＝mastered（以後の復習に出さない・retire）／「次のカードへ」＝again（翌日また出す・againCount++）。旧3段階は後方互換で保持。
- AI が「ノートに書き写す内容」(`noteText`) を短い箇条書きで生成。Markdown にも `## ノートに書き写す内容` を出力。
- AI 結果表示の**後**に写真保存口を設置し、`attachNoteImages` で作成済みセッションへ後追加（Markdown 正本の front matter `noteImages:` も差し替え・本文は再生成しない）。

### Phase 9 — 前回からの続き・学習モード・補足のモード順・リリカイ復帰（作業中）
詳細は [phase-09-plan.md](./phase-09-plan.md) を参照。要点：
- **前回からの続き**：資格・分野・テーマ・モードを直近セッションからプリフィル。テーマは自由記述＋過去5件の候補チップ＋クリア。
- **学習モード**：インプット／演習／高速周回。AI 分析とカード生成の力点を段階最適化し、`session.mode`/`job.input.mode` に保存、Markdown・カレンダーに表示。
- **カード補足のモード順**：各補足行に由来モードを持たせ（`supplementModes`）、復習カードの答え面で 高速周回→インプット→演習 の順に並べる（`sortSupplementByMode`）。
- **リリカイ済み復帰**：mastered にしたカードを一覧（`listMasteredCards`）し、当日の復習へ戻す（`reactivateCard`）。
