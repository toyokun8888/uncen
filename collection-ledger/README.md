# collection-ledger

複数サイトから取得したマスター情報、ローカル所持ファイル、DL可能リンク、サムネイルを、同じ考え方で整理して扱うためのローカル運用プロジェクト。

## 方針

- ブラウザ画面と実処理ジョブを明確に分ける。
- 実処理ジョブは `node apps/jobs/xxx.js` で手動実行でき、将来は同じ入口をPM2から起動できるようにする。
- サイトごとの違いは `packages/sources` に閉じ込め、DB投入・ログ・CSV・retry・dry-runなどは共通部品化する。
- PostgreSQLは専用schema `cl` を使い、既存プロジェクトの `public` や既存テーブルと混ぜない。
- まだQ9以降のプロトタイプ範囲には進まない。このリポジトリは、現時点では合意済み設計の土台を置く段階。

## 主要ディレクトリ

- `apps/web`: React/Viteのブラウザ画面。
- `apps/api`: ブラウザ画面向けAPI。
- `apps/jobs`: 手動実行・PM2自動実行の入口JS。
- `packages/core`: 設定、ログ、run id、CSV、dry-run、安全確認など。
- `packages/domain`: マスター、所持、DL候補、サムネイルなどのドメイン定義。
- `packages/db`: PostgreSQL接続、repository、SQL管理。
- `packages/scraping`: Puppeteer/Cheerio共通処理。
- `packages/sources`: サイトごとの取得実装。
- `packages/file-system`: 所持ファイル確認、パス正規化、ファイル安全確認。
- `ops`: PM2設定、SQL、運用資材。
- `docs`: 要件、決定事項、設計、ルール。

