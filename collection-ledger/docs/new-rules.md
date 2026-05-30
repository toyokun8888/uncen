# 新ルールまとめ

## DB

- schemaは `cl`。
- 名前はすべて小文字。
- sequence権限まで必ず見る。
- 既存DBロールを使うが、schemaは分離する。

## ディレクトリ

- ブラウザUIは `apps/web`。
- UI向けAPIは `apps/api`。
- 手動・自動実行ジョブは `apps/jobs`。
- 共通部品は `packages`。
- 運用資材は `ops`。
- ログや出力物は `storage`。

## job

- 手動実行は `node apps/jobs/xxx.js`。
- PM2も同じJSを呼ぶ。
- npm scriptsは補助。
- job本体をAPIの中に置かない。

## レビュー

- 全体レビュー用: `overall_review`。
- JSレビュー用: `js_review`。
- DBレビュー用: `db_review`。

