# ReRIKAI

学習者が自分の言葉で説明し、その説明をAIが分析する学習支援サービス。詳細は `SPEC.md` を参照。

このREADMEはPhase 7（ノート写真・仕上げ・カレンダー集計表示）まで完了時点の内容。これで SPEC §21「必須」機能は一通り実装済み。

## 画面構成

| ページ | 役割 |
|---|---|
| `web/calendar.html` | 主要画面（CloudFrontのルート）。月間カレンダー → 日付詳細 → セッション詳細 → Markdown表示の3階層。日セルに新規カード数・復習予定数、上部に「今日の復習／要確認」件数、セッション詳細にノート写真を表示 |
| `web/session.html` | 学習セッションの入力・保存・AI分析・カード候補の採用・ノート写真の添付 |
| `web/cards.html` | カード一覧・詳細・手動編集・要確認解決・手動統合 |
| `web/review.html` | 今日の復習（質問→正解→3段階評価） |

`web/calendar-core.mjs` はカレンダーの純ロジック（月グリッド生成・日別集計）で、ブラウザと `node --test` の両方から使う。

## APIアクション

`createSession` / `processSessionJob`(内部) / `getSession` / `listSessions` / `getSessionMarkdown` / `adoptCards` / `listCards` / `getCard` / `updateCard` / `checkDuplicates` / `mergeAnswerIntoCard` / `resolveConflict` / `mergeCardsManual` / `listDueCards` / `reviewCard` / `getNoteUploadUrl` / `getNoteImageUrls` / `health`

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
| S3 | `ririkai-data-naohiro` | Markdown（`sessions/users/{userId}/...`）とノート写真（`notes/users/{userId}/...`）。ブラウザ直PUT用にCORSを設定 |
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

`SK=SESSION#{createdAt}`。生の文字起こしは含まない。分析結果（理解できている点・曖昧な点・誤解の可能性・確認質問・復習事項）と、MarkdownのS3キー、カード候補（`cardCandidates`）・採用済みカードID（`cardIds`）・`cardStatus`（pending/done/failed/skipped）・ノート写真キー（`noteImages`、§8）を保持する。

### DynamoDBカードアイテム（§12）

`SK=CARD#{cardId}`。`cardType`・`conceptKey`・`normalizedQuestion`・`question`・`canonicalAnswer`・`supplement[]`・`sourceSessionIds[]`・`answerSource`(ai/user)・`status`(active/inactive/needs_review/merged)・`pendingAnswer`(needs_review時の新回答退避)・`mergedIntoCardId`(merged時)・`review{ nextReviewDate, reviewCount, ... }`。

- カード候補はAI分析と同時（`processSessionJob`内）に生成され、SESSIONアイテムに保存。利用者が `session.html` で採用/編集/不採用を選び、採用分だけ `adoptCards` でCARD#として保存する（全件自動登録はしない：§13）
- カード↔セッションの関連はDynamoDBのみで保持（`session.cardIds` と `card.sourceSessionIds`）。S3のMarkdownは生成時のまま書き換えない（§3.2/§26）
- 手動編集したカードは `answerSource=user`（§14）
- `review.nextReviewDate` は採用時に翌日で初期化。復習フロー（Phase 6）が `review` 集計と次回日を更新する

### DynamoDB復習履歴アイテム（§16.4）

`SK=REVIEW#{reviewId}`。`cardId`・`result`(correct/uncertain/incorrect)・`reviewedAt`・`previousNextReviewDate`・`newNextReviewDate`。reviewId は冪等性キー（二重送信で二重加算しない）。

## カレンダーの集計（Phase 3）

`listSessions`（`yearMonth`指定）が当月のSESSIONアイテムを返し、日別の集計（セッション数・合計学習時間・分野/資格）は `web/calendar-core.mjs` の `aggregateByDate` がクライアント側で行う。加えて `listCards` の結果を `aggregateCardsByDate(cards, today)` で集計し、各日セルに「新規カード数（採用日 = `createdAt` の JST 日付）」「復習予定数（その日が `review.nextReviewDate`）」を、カレンダー上部に「今日の復習件数（`nextReviewDate <= 今日` の active）」「要確認件数（`status=needs_review`）」を表示する（Phase 7）。集計はすべてクライアント側の純関数で、`node --test` 済み。

## 重複判定・統合の考え方（Phase 5・§10/§11/§15）

- 重複検出は**決定論的**（AIなし・§28.6の初期版方式、ベクトル検索なし）。`findDuplicateCards` が「conceptKey非空で一致 かつ cardType一致」または「normalizedQuestion一致」で判定。AIの意味的類似はカード生成時に conceptKey を付与済みなことで代替
- カード採用時、`checkDuplicates` で既存カードと照合。重複があれば `session.html` で §10.5 の選択（既存を更新／新規保存／破棄）を出す（無条件に2枚目を作らない）
- 回答統合（`mergeAnswerIntoCard`→`integrateAnswer`）：回答が正規化一致なら補足だけ統合し既存回答を維持。**回答が異なる／既存がユーザー編集済みなら needs_review**（自動確定しない・§11.4/§14）。新回答は `pendingAnswer` に退避
- needs_review は `cards.html` で利用者が確定（`resolveConflict`）。過去のMarkdownは書き換えない
- 手動統合（`mergeCardsManual`→`mergeCardData`）：source を target に吸収（sourceSessionIds/supplement をunion、review集計を合算）、source は `status=merged`・`mergedIntoCardId` を保持（§15）

## 復習日計算ルール（Phase 6・§16）

- 評価は3段階（できた=`correct` / あやしい=`uncertain` / できなかった=`incorrect`）
- 次回復習日（`computeNextReviewDate`、独立した純関数で後から変更しやすい）：できた=+7日 / あやしい=+3日 / できなかった=翌日。新規カードは採用時に翌日で初期化（§16.2）
- `listDueCards` が `nextReviewDate <= 今日(JST)` の有効カードを返し、`review.html` が1枚ずつ提示。評価は `reviewCard` で記録し `applyReview` が review 集計と次回日を更新
- **復習履歴**：`SK=REVIEW#{reviewId}` に1件ずつ保存（result・reviewedAt・previousNextReviewDate・newNextReviewDate、§16.4）。カード本体の `review` カウントにも反映
- **冪等性**：フロントがカード提示ごとに `reviewId` を発行。バックエンドは履歴を条件付きPut（`putNewItem`）し、二重送信時は加算せず `duplicate:true` を返す（§23.6）

## ノート写真（Phase 7・§8）

後から学習内容を見返すための参照資料。OCR・手書き認識・AI分析・自動カード化はしない（§8.1）。

- **アップロード**：ブラウザ→S3の直PUT（Presigned URL、§8.2）。Lambdaは画像本体を中継しない。`session.html` で写真を選ぶと即アップロードし、成功したキーだけを保存時に `createSession` の `noteImages[]` へ渡す。**アップロードはセッション作成の前**に行うので、写真の失敗はセッション本文の消失につながらない（失敗分は付かないだけ、§23.7）。対応形式は jpeg/png/webp/gif、1枚8MBまで、最大10枚。失敗した写真は再試行できる（§8.4）。
- **キー設計（§8.3）**：`notes/users/{userId}/{yyyy}/{mm}/{dd}/note_{imageId}.{ext}`。`imageId`・`ext`・日付はサーバ生成（`getNoteUploadUrl`）。`userId` はサーバ固定で、`createSession` はクライアント指定の `noteImages` を `notes/users/{固定userId}/` 接頭辞のものだけ受理する（§28.3/§23.8）。
- **表示**：`getNoteImageUrls`（`sessionSk`）が各キーに閲覧用の署名付きGET URLを付けて返し、`calendar.html` のセッション詳細でサムネイル表示（タップで別タブに原寸）。
- **Markdown**：`processSessionJob` が `session.noteImages` を Front Matter の `noteImages:` に記録する（§4.2/§23.2）。既存Markdownはカード更新で書き換えない方針のまま（§26）。
- **CORS**：ブラウザ直PUTのため、データバケットに `aws_s3_bucket_cors_configuration`（PUT/GET/HEAD、初期版は全オリジン許可）を設定。IAMは既存の `s3:GetObject`/`s3:PutObject`（`${data.arn}/*`）で足りる。

## 将来Apple Speechを接続する場所

`createSession` action は `transcript` という共通の文字列だけを受け取る設計にしている（SPEC.md §2.3）。将来Apple Speech経由の文字起こしを追加する場合、`transcript` を生成する経路を追加するだけでよく、`processSessionJob` 以降のAI分析・Markdown生成・保存処理は変更不要。

## 現在未実装の機能（Phase 7完了時点）

- ノート写真のAI/OCR解析（§8.1で初期版では意図的に非対応。参照用のみ）
- 最大ファイルサイズ・枚数の上限はクライアント側検証（署名付きPUT URLではサイズ強制ができないため。初期版の割り切り）
- understandingScore（精度未検証のため意図的に省略。§28.7）
- セッション保存の二重送信に対する冪等性はフロントの送信ボタン無効化のみ（復習の二重加算はサーバ側で防止済み）
