# ReRIKAI バックログ（将来対応）

初期版では実装しないが、将来必要になる機能のメモ。優先度順ではなく分類。

## 検索・一覧の絞り込み（カード/セッション）

現状 `listCards` / `listSessions` は前方一致プレフィックスで全件（上限500）を取得し、絞り込み・並べ替えはフロント側。データが増えると非効率になるため、将来は最低限これらが必要：

- **資格・コースで絞る**（`qualification`）
- **分野で絞る**（`subject`）
- **質問文検索**（カードの `question` 部分一致。`normalizedQuestion` を活かした正規化検索も検討）
- **最近 mastered にした順**（`review.masteredAt` を降順ソート。※Phase 9追補で `applyReview` が mastered 時に `masteredAt` を記録するようになったため、将来はこれを使えばよい。`reactivationCount`/`lastReactivatedAt` も記録済みで弱点分析に使える）
- **20〜50件ずつのページング**（`limit` + `lastEvaluatedKey` によるカーソル。現状の全件取得を置き換え）

### 実装時の留意点
- DynamoDB 単一テーブル設計のため、資格/分野/質問での効率的な絞り込みには **GSI**（例: `subject`/`qualification` をキーに）か、件数が小さいうちはアプリ側フィルタ＋ページングで割り切る判断が要る。
- 「最近 mastered 順」は現在のスキーマに mastered 化日時が無いので、`reactivateCard`/`applyReview` 時に `review.masteredAt` を記録する追加が前提。
- userId はサーバ固定・PK 固定なので、絞り込みはすべて PK=`USER#naohiro` 配下のクエリになる。
