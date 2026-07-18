# ReRIKAI

学習者が自分の言葉で説明し、その説明をAIが分析する学習支援サービス。詳細は `SPEC.md` を参照。

このREADMEはPhase 4（カード：候補生成・確認・保存・一覧・詳細・編集）まで完了時点の内容。

## 画面構成

| ページ | 役割 |
|---|---|
| `web/calendar.html` | 主要画面（CloudFrontのルート）。月間カレンダー → 日付詳細 → セッション詳細 → Markdown表示の3階層 |
| `web/session.html` | 学習セッションの入力・保存・AI分析・カード候補の採用 |
| `web/cards.html` | カード一覧・詳細・手動編集 |

`web/calendar-core.mjs` はカレンダーの純ロジック（月グリッド生成・日別集計）で、ブラウザと `node --test` の両方から使う。

## APIアクション

`createSession` / `processSessionJob`(内部) / `getSession` / `listSessions` / `getSessionMarkdown` / `adoptCards` / `listCards` / `getCard` / `updateCard` / `health`

## 構成

```
backend/    Lambda本体（Node.js、単一関数・action分岐）
web/        フロントエンド（素のHTML/CSS/JS、ビルド工程なし）
terraform/  新規AWSリソースのIaC
legacy/     既存Eureka Studyのコード（参照専用、変更しない）
SPEC.md     実装仕様書
```

既存の「Eureka Study」（Lambda `EurekaStudyApi` / DynamoDB `StudyLogTable` / S3 `study-log-web` 等）には一切触れない。ReRIKAI用に完全新規のAWSリソースを構築する。

## AWS構成（新規リソース）

| リソース | 名前 | 用途 |
|---|---|---|
| DynamoDB | `ReRikaiTable` | セッション索引（PAY_PER_REQUEST、PK=`USER#{userId}`） |
| S3 | `ririkai-data-naohiro` | Markdown（`sessions/users/{userId}/...`）。将来ノート写真も同バケット |
| S3 | `ririkai-web-naohiro` | フロントエンド静的ファイル（CloudFront経由のみ公開） |
| Lambda | `ReRikaiApi` | API本体 |
| API Gateway | `ReRikai-API` | HTTP API |
| CloudFront | (新規) | `ririkai-web-naohiro` の配信 |

既存の Secrets Manager `eureka-study/openai`（OpenAI APIキー）は読み取り専用で再利用する。

### DynamoDBキー設計

- `PK = USER#{userId}`（userIdはLambda側で固定値 `naohiro`。クライアント指定値は信用しない）
- `SK = SESSION#{createdAt ISO}` — 永続索引アイテム。生の文字起こし本文は含めない
- `SK = JOB#{createdAt}#{rand}` — AI分析の非同期処理用一時アイテム。`expiresAt`属性でTTL自動失効（7日）

## 環境変数（Lambda）

| 変数 | 説明 | 既定値 |
|---|---|---|
| `DATA_BUCKET` | Markdown保存先バケット名 | Terraformが自動設定 |
| `OPENAI_SECRET_ID` | OpenAI APIキーのSecrets Manager ID | `eureka-study/openai` |
| `OPENAI_MODEL` | OpenAIモデル名 | `gpt-4.1` |
| `USER_ID` | シングルユーザー構成の固定userId | `naohiro` |

## ローカルでの確認方法

TypeScriptは使用しない（§28.2）。構文チェックとロジックテストで品質確認する。

```bash
# 構文チェック
node --check backend/index.mjs backend/lib/*.mjs

# ロジックテスト（Markdown生成・JST日付変換・入力検証）
cd backend && node --test
```

フロントエンド（`web/session.html`）は、`terraform apply` 実行後にAPI Gatewayのエンドポイントを画面上部「API接続設定」に入力すればブラウザから直接動作確認できる。ローカルでは `web/` フォルダを任意の静的サーバーで開くか、ファイルを直接ブラウザで開いて確認する。

## デプロイ手順

新規AWSリソースの作成・変更は Terraform で行う。**`terraform apply` は利用者が実行する**（§28.4。Claude Codeは`init`/`validate`/`plan`まで）。

```bash
cd terraform
terraform init
terraform validate
terraform plan -out=tfplan
terraform apply tfplan   # ここは利用者が実行
```

apply後、出力される `api_endpoint` を `web/session.html` の「API接続設定」に設定する。

フロントエンドの更新（Lambdaコードの変更を含む）は、`backend/` または `web/` を編集後に再度 `terraform plan` → 利用者が `apply` する（Lambdaコードは`archive_file`でzip化されTerraform管理下にあるため）。

Webバケットへの静的ファイル配置は次のコマンドで行える（新規・非本番バケットのため通常操作として実行してよいが、運用開始後は事前に確認する）：

```bash
aws s3 sync web/ s3://ririkai-web-naohiro/ --delete
```

## データ構造

### Markdownスキーマ（S3が正本）

`sessions/users/{userId}/{yyyy}/{mm}/{dd}/session_{sessionId}.md`

Front Matter（YAML）＋ 本文（今日の目的／自分で分からなかった点／生の文字起こし／表記を整えた文字起こし／AI分析／復習事項／関連カード）。詳細はSPEC.md §4.3・§4.4を参照。`backend/lib/markdown.mjs` の `buildSessionMarkdown` が生成する。

### DynamoDBセッションアイテム（索引）

`SK=SESSION#{createdAt}`。生の文字起こしは含まない。分析結果（理解できている点・曖昧な点・誤解の可能性・確認質問・復習事項）と、MarkdownのS3キー、カード候補（`cardCandidates`）・採用済みカードID（`cardIds`）・`cardStatus`（pending/done/failed/skipped）を保持する。

### DynamoDBカードアイテム（§12）

`SK=CARD#{cardId}`。`cardType`・`conceptKey`・`normalizedQuestion`・`question`・`canonicalAnswer`・`supplement[]`・`sourceSessionIds[]`・`answerSource`(ai/user)・`status`(active/inactive/merged)・`review{ nextReviewDate, reviewCount, ... }`。

- カード候補はAI分析と同時（`processSessionJob`内）に生成され、SESSIONアイテムに保存。利用者が `session.html` で採用/編集/不採用を選び、採用分だけ `adoptCards` でCARD#として保存する（全件自動登録はしない：§13）
- カード↔セッションの関連はDynamoDBのみで保持（`session.cardIds` と `card.sourceSessionIds`）。S3のMarkdownは生成時のまま書き換えない（§3.2/§26）
- 手動編集したカードは `answerSource=user`（§14）
- `review.nextReviewDate` は採用時に翌日で初期化。実際の復習フロー（できた/あやしい/できなかった → 次回復習日更新）はPhase 6

## カレンダーの集計（Phase 3）

`listSessions`（`yearMonth`指定）が当月のSESSIONアイテムを返し、日別の集計（セッション数・合計学習時間・分野/資格）は `web/calendar-core.mjs` の `aggregateByDate` がクライアント側で行う。新規カード数・復習予定数・要確認数はカード/復習機能（Phase 4〜6）実装後に差し込む予定で、現状はプレースホルダ。

## 重複判定・復習日の考え方

- カード生成はPhase 4で実装済み。各カードに `conceptKey`・`cardType`・`normalizedQuestion` を付与して保存している
- **重複統合**（同一 conceptKey/cardType の重複検出・canonicalAnswer統合・矛盾時 needs_review・手動統合）はPhase 5で実装予定（SPEC.md §10・§11・§15）。Phase 4時点では重複検出・マージは行わない
- 復習スケジュール（できた/あやしい/できなかった → 次回復習日）はPhase 6で実装予定（SPEC.md §16）

## 将来Apple Speechを接続する場所

`createSession` action は `transcript` という共通の文字列だけを受け取る設計にしている（SPEC.md §2.3）。将来Apple Speech経由の文字起こしを追加する場合、`transcript` を生成する経路を追加するだけでよく、`processSessionJob` 以降のAI分析・Markdown生成・保存処理は変更不要。

## 現在未実装の機能（Phase 4完了時点）

- ノート写真アップロード（Phase 7）
- カードの重複統合・canonicalAnswer統合・needs_review・手動統合（Phase 5）
- 復習機能（できた/あやしい/できなかった・次回復習日更新・復習履歴）（Phase 6）
- カレンダーの新規カード数・復習予定数・要確認数（Phase 5/6の実装後に対応）
- understandingScore（精度未検証のため意図的に省略。§28.7）
- 二重送信に対する冪等性はフロントの送信ボタン無効化のみ（強い冪等性制御は未実装）
