# ReRIKAI

学習者が自分の言葉で説明し、その説明をAIが分析する学習支援サービス。詳細は `SPEC.md` を参照。

このREADMEはPhase 9（前回からの続き・学習モード・カード補足のモード順表示・リリカイ済みカードの復帰）まで完了時点の内容。SPEC §21「必須」機能は一通り実装済み。構築フェーズの経緯は `doc/build-plan.md` を参照。

## 画面構成

| ページ | 役割 |
|---|---|
| `web/calendar.html` | 主要画面（CloudFrontのルート）。月間カレンダー → 日付詳細 → セッション詳細 → Markdown表示の3階層。日セルに新規カード数・復習予定数、上部に「今日の復習／要確認」件数、セッション詳細にノート写真を表示 |
| `web/session.html` | 学習セッションの入力・保存・AI分析・カード候補の採用・ノート写真の添付。学習モード選択と前回からの続き（資格・分野・テーマ・モードのプリフィル＋過去5テーマ候補＋クリア） |
| `web/cards.html` | カード一覧・詳細・手動編集・要確認解決・手動統合。資格/分野で絞り込み・質問文/答えの検索・「最近リリカイした順」並べ替え・20/30/50件ずつのページング |
| `web/review.html` | 今日の復習（フラッシュカード。タップでめくる・リリカイ!/次のカードへ）。完了画面から「リリカイ済みカードを復習に戻す」 |

`web/calendar-core.mjs` はカレンダーの純ロジック（月グリッド生成・日別集計）で、ブラウザと `node --test` の両方から使う。

## APIアクション

`createSession` / `processSessionJob`(内部) / `getSession` / `listSessions` / `getSessionMarkdown` / `adoptCards` / `listCards` / `getCard` / `updateCard` / `checkDuplicates` / `mergeAnswerIntoCard` / `resolveConflict` / `mergeCardsManual` / `listDueCards` / `reviewCard` / `listMasteredCards` / `reactivateCard` / `getNoteUploadUrl` / `getNoteImageUrls` / `attachNoteImages` / `health`

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

## 復習フロー（Phase 8でフラッシュカード化・§16）

- `review.html` は1枚ずつのフラッシュカード。**カードをタップすると質問↔答え（＋補足）がめくれる**。右上「詳細」ボタンで分野/資格・カード種別・conceptKey・復習回数・習熟度・次回復習日・出典セッション数を表示。
- 下部は2ボタン：
  - **「リリカイ!」**（`result:"mastered"`）＝理解完了 → `review.mastered=true`・`masteryLevel=5` にして**以後の復習に出さない**（retire）。`computeNextReviewDate` は遠い将来日を返すが、実際の除外は `listDueCards` / カレンダー集計の `!review.mastered` フィルタで行う。
  - **「次のカードへ」**（`result:"again"`）＝まだ理解しきっていない → `nextReviewDate=翌日` にして**翌日また出す**。`againCount`・`reviewCount` を加算。
- `computeNextReviewDate` は独立した純関数（後から間隔を変えやすい）。旧3段階（できた=+7 / あやしい=+3 / できなかった=翌日）も後方互換で残しているが、既定UIは上記2択。新規カードは採用時に翌日で初期化（§16.2）。
- `listDueCards` は `status=active` かつ `!review.mastered` かつ `nextReviewDate <= 今日(JST)` を返す。
- **復習履歴**：`SK=REVIEW#{reviewId}` に1件ずつ保存（result・reviewedAt・previousNextReviewDate・newNextReviewDate、§16.4）。カード本体の `review` カウントにも反映。
- **冪等性**：フロントがカード提示ごとに `reviewId` を発行。バックエンドは履歴を条件付きPut（`putNewItem`）し、二重送信時は加算せず `duplicate:true` を返す（§23.6）。
- **補足のモード順表示（Phase 9）**：`listDueCards` は返却時に各カードの `supplement` を由来モード順（**高速周回→インプット→演習**）に並べ替える（`sortSupplementByMode`。表示専用で保存データは不変）。
- **リリカイ済みの復帰（Phase 9）**：一度 mastered にしたカードも `review.html` 完了画面の「リリカイ済みカードを復習に戻す」から戻せる。`listMasteredCards` で一覧、`reactivateCard`（`cardId`）で `review.mastered=false`・`nextReviewDate=今日(JST)` にして当日の復習へ再表示（履歴カウントは維持）。

## ノート写真（Phase 7・§8）

後から学習内容を見返すための参照資料。OCR・手書き認識・AI分析・自動カード化はしない（§8.1）。

- **アップロード**：ブラウザ→S3の直PUT（Presigned URL、§8.2）。Lambdaは画像本体を中継しない。対応形式は jpeg/png/webp/gif、1枚8MBまで、最大10枚。失敗した写真は再試行できる（§8.4）。写真アップロード欄は2箇所（両方とも同一セッションの `noteImages` に入る）：
  - **フォーム内（事前・任意）**：保存時に `createSession.noteImages[]` へ。作成前なので写真失敗がセッション本文の消失につながらない（§23.7）。
  - **AI結果表示の後（主導線・Phase 8）**：実際の流れは「保存→AI結果→`noteText` を見てノートに書き写す→写メ」。結果画面の「書き写したノートを保存」からアップロードすると、成功ごとに `attachNoteImages`（`sessionSk`, キー）で**作成済みセッションへ追記**する。Markdown（正本）の front matter `noteImages:` も `replaceNoteImagesInFrontMatter` で更新する（本文は書き換えない＝DynamoDBに生文字起こしを持たない設計・§3.2/§26のため全再生成はしない）。
- **キー設計（§8.3）**：`notes/users/{userId}/{yyyy}/{mm}/{dd}/note_{imageId}.{ext}`。`imageId`・`ext`・日付はサーバ生成（`getNoteUploadUrl`）。`userId` はサーバ固定で、`createSession` はクライアント指定の `noteImages` を `notes/users/{固定userId}/` 接頭辞のものだけ受理する（§28.3/§23.8）。
- **表示**：`getNoteImageUrls`（`sessionSk`）が各キーに閲覧用の署名付きGET URLを付けて返し、`calendar.html` のセッション詳細でサムネイル表示（タップで別タブに原寸）。
- **Markdown**：`processSessionJob` が `session.noteImages` を Front Matter の `noteImages:` に記録する（§4.2/§23.2）。既存Markdownはカード更新で書き換えない方針のまま（§26）。
- **CORS**：ブラウザ直PUTのため、データバケットに `aws_s3_bucket_cors_configuration`（PUT/GET/HEAD、初期版は全オリジン許可）を設定。IAMは既存の `s3:GetObject`/`s3:PutObject`（`${data.arn}/*`）で足りる。

## 音声認識エラー・文脈混入への耐性（AI出力品質）

音声認識（文字起こし）由来の誤りや、入力に無い話題の混入を、学習者の理解不足・誤解と切り分ける。

- **新区分 `unclearTranscript`（文字起こしが不明瞭な箇所）**：`{ excerpt, reason }` の配列。音声認識エラーの可能性が高い箇所や意味を特定できない用語を分離する。**この区分の内容は理解度評価・確認質問・復習事項・ノートに使わない**。`session.html`／`calendar.html`／Markdown（`## 文字起こしが不明瞭な箇所`）に表示。
- **分析プロンプト（`buildAnalysisPrompt`）の主なルール**：意味の通らない文字列を推測補完しない／不明瞭は `unclearTranscript` に分離／誤解は「①発言が明確 ②主張を特定できる ③技術的に誤りの可能性が高い ④音声認識エラーでない」を満たす時だけ（断定できなければ確認質問へ）／不明な用語を既存AWSサービスに変換しない／入力（文字起こし・テーマ・分からなかった点）に無い論点・サービスを生成しない（文脈混入の禁止）。
- **達成度**：`達成｜一部達成｜未達成｜判定材料不足`。理由は入力にある内容だけ。材料不足なら断定せず `判定材料不足`。
- **確認質問**：①誤解の修正 ②曖昧点の自力説明 ③テーマ中心事項、の優先順位。不明瞭・用語不明について知識問題を作らない（必要なら「元の用語を確認してください」という音声再確認案内）。
- **復習事項／ノート**：今回確認された弱点（誤解・説明できなかった点・混同）だけに絞る。理解できていた内容や一般論は入れない。ノートは「今回の修正点」のみ。
- **カード生成（`buildCardsPrompt`）**：不明瞭箇所・特定できない用語・入力に無いサービスからカードを作らない。今回理解できていた内容はカード化しない。
- **正規化（`analysis.mjs` の `normalizeAnalysis`・純関数/テスト対象）**：`unclearTranscript` を `{excerpt,reason}` に整え、その内容が理解/曖昧/誤解へ重複混入しないよう防御的に除去する。信頼度は保存フィールドではなくプロンプトのルーティング（低確信→確認が必要/不明瞭）で担保。

## ノートに書き写す内容（Phase 8）

AI分析（`callOpenAIForAnalysis`）が、紙のノートにそのまま書き写せる短い箇条書き `noteText`（5〜10個・要点/定義/違い/条件/数値など・文字ベース）を生成する。セッション詳細（`session.html` の結果／`calendar.html`）に表示し、Markdown 本文に `## ノートに書き写す内容` として保存する。利用者はこれを見て手でノートに書き写し、その写真を「書き写したノートを保存」から `attachNoteImages` でセッションに残す。OCR等はせず、書き写す“お題”をAIが提示するだけ。

## 学習モードと前回からの続き（Phase 9）

学習の段階に応じてAIへ求めるものが違うため、セッションに**学習モード**を持たせる。

- **モード（`session.mode` / `job.input.mode`）**：`input`（インプット＝頭に入れる）／`practice`（演習＝初回〜数回）／`fast`（高速周回＝最後の詰め）。**未指定は下流で `input` 既定**、**明示された不正値は `validate.mjs` が 400 `INVALID_MODE` で拒否**（フロント不具合の握りつぶし防止）。読み取り時は旧データの mode 欠落も許容。
  - **分析（`buildAnalysisPrompt`）の力点**：input=基礎・定義・仕組みの体系整理と `noteText` 厚め／practice=わからない点を手厚く（曖昧点・誤解・確認質問を重視）／fast=覚えるべき点は簡潔に・注意点/弱点だけ・`noteText` は少なめ。
  - **カード生成（`buildCardsPrompt`）の狙い**：input=基礎定義中心／practice=適用・条件・違い・弱点中心／fast=注意点・弱点に絞り新規は最小。
  - Markdown の front matter に `mode:`、本文冒頭に `> モード: <ラベル>` を出力。`calendar.html` のセッション詳細・`session.html` の結果にも表示。
- **カードへの由来モード**：`buildCardItem` はカードに `mode` と、各補足行の由来モードを表す並列配列 `supplementModes`（`supplement` と同じ長さ・順序）を持たせる。**対応関係を保つのは全書き込み経路の責務**：新規採用（`buildCardItem`）・統合（`integrateAnswer` merged / `mergeCardData`）・手動編集（`updateCard`）・矛盾解決（`resolveConflict`）はいずれも `supplementModes` を `supplement` と同じ長さ・順序に保つ（編集時は `realignSupplementModes` で作り直す）。由来が不明な旧データ行は `input` と断定せず `legacy`（表示順は末尾）。表示時は `sortSupplementByMode` で 高速周回→インプット→演習（legacy/未知は末尾）。長さ不一致の旧カードは並べ替えず元順を返す（後方互換・安全側）。
- **前回からの続き（`session.html`・クライアント側）**：読込時に `listSessions` を1回呼び、直近セッションの `qualification`/`subject`/`topic`/`mode` を初期表示（すべて編集可）。過去の `topic`（非空・重複除去）から直近5件を「テーマ候補」チップに、テーマ欄横に「クリア」ボタンを置く。履歴が無ければ空＋モード既定=インプット。バックエンド変更なし。

## カード検索・絞り込み・ページング（Phase 9追補）

`listCards` は純関数 `queryCards`（`cards.mjs`・テスト対象）でフィルタ／並べ替え／ページングする。**パラメータが指定された時だけ**効き、無指定なら従来どおり非merged全件を返す（カレンダー集計など既存呼び出しと後方互換）。

- 絞り込み：`qualification`／`subject`（部分一致・大小無視）、`q`（`question`／`canonicalAnswer`／`normalizedQuestion` を横断検索）。
- 並べ替え：`sort="recentMastered"`（`review.masteredAt` 降順・未設定は末尾）、既定は作成日時の新しい順。
- ページング：`limit`（1〜50にクランプ・既定30）＋`offset`。応答に `total`／`offset`／`limit`／`hasMore` を返す。
- 実装方針：単一利用者・件数が小さい前提で Lambda が `CARD#`（上限500）を取得してメモリ内で処理（アプリ側フィルタ＋ページング）。件数増加後の GSI 最適化は将来（`doc/backlog.md`）。
- フロント（`cards.html`）：資格/分野は既存値の候補（datalist）付き入力、質問検索、並べ替え、件数選択、前へ/次へのページャ。手動統合の候補と候補datalistは別途フィルタ無しの全件取得で用意する。

## データの正本と役割

- **学習セッション本文の正本＝S3 Markdown**（`sessions/users/{userId}/...`）。生／整形済み文字起こし・AI分析本文・ノートに書き写す内容を持つ。カード更新では過去Markdownを書き換えない（§26）。
- **カード・回答・復習状態・復習履歴の正本＝DynamoDB**（`CARD#`・`REVIEW#`）。カードの `canonicalAnswer`・`supplement`/`supplementModes`・`review`（mastered/nextReviewDate/各カウント/masteredAt/reactivationCount）・復習履歴が正本。
- **カレンダー・一覧表示用の索引＝DynamoDB**（`SESSION#` の軽量フィールド）。生の文字起こしは DynamoDB に持たない（§3.2）。
- 後付け写真添付（`attachNoteImages`）は S3 Markdown の front matter 内 `noteImages:` ブロックだけを差し替える（本文は再生成しない）。

## セキュリティ状況（既知の制約）

- **API認証**：現状 API Gateway（HTTP API・`$default` ルート）に**オーソライザーが無く、URLを知る第三者が未認証で全アクションを実行できる**。`userId` のサーバ固定は認可境界ではない。**単一利用者の初期版としての割り切りで、認証の追加は要検討事項**（Lambdaオーソライザー＋共有シークレット / Cognito / CloudFront 署名など）。実データ保護の観点では最優先の検討対象。
- **S3**：データ／Webバケットとも Public Access Block 全有効・SSE(AES256)・データはVersioning有効。Webは CloudFront OAC 経由のみ（バケットポリシーで CloudFront ソースARN限定）。ブラウザ→S3直PUT/GETは**時間制限付き署名付きURL**が認可境界（Lambda 経由で発行、キーは自ユーザ配下のみ）。
- **XSS**：フロントは利用者・AI由来の文字列を `textContent` か `escapeHtml` 経由でのみ描画（`shared.js` の `escapeHtml`）。Markdown は別タブで S3 の生データ（`text/markdown`）として開き、アプリ内でHTML化しない。
- **DynamoDB**：Point-in-Time Recovery と Deletion Protection を有効化（`terraform/dynamodb.tf`、要 apply）。IAMは当該テーブル／データバケット配下／対象シークレットに限定。
- **ログ**：CloudWatch Logs 保持30日。文字起こし全文・AI応答全文・APIキーはログに出さない方針。

## 将来Apple Speechを接続する場所

`createSession` action は `transcript` という共通の文字列だけを受け取る設計にしている（SPEC.md §2.3）。将来Apple Speech経由の文字起こしを追加する場合、`transcript` を生成する経路を追加するだけでよく、`processSessionJob` 以降のAI分析・Markdown生成・保存処理は変更不要。

## 現在未実装の機能（Phase 7完了時点）

- ノート写真のAI/OCR解析（§8.1で初期版では意図的に非対応。参照用のみ）
- 最大ファイルサイズ・枚数の上限はクライアント側検証（署名付きPUT URLではサイズ強制ができないため。初期版の割り切り）
- understandingScore（精度未検証のため意図的に省略。§28.7）
- セッション保存の二重送信に対する冪等性はフロントの送信ボタン無効化のみ（復習の二重加算はサーバ側で防止済み）
