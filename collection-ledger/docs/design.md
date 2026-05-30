# 設計書

## 全体構成

```txt
collection-ledger/
  apps/
    web/
    api/
    jobs/
  packages/
    core/
    domain/
    db/
    scraping/
    sources/
    file-system/
  ops/
    pm2/
    sql/
  storage/
    logs/
    exports/
    thumbnails/
  docs/
```

## ブラウザ部分

`apps/web` と `apps/api` が担当する。

- `apps/web`: React/Vite UI。
- `apps/api`: UIから呼ぶAPI。

APIは実処理の本体を持たない。必要な場合は、ジョブ実行の操作口として振る舞う。

## 実処理部分

`apps/jobs` と `packages` が担当する。

- `apps/jobs`: 人間やPM2が起動する入口。
- `packages/core`: 横断的な共通処理。
- `packages/domain`: 純粋なルールと状態。
- `packages/db`: PostgreSQLアクセス。
- `packages/scraping`: スクレイピング共通処理。
- `packages/sources`: サイト固有処理。
- `packages/file-system`: ローカルファイル確認。

## 依存方向

基本の依存方向は以下とする。

```txt
apps/jobs -> packages/*
apps/api -> packages/db, packages/domain
apps/web -> apps/api
packages/sources -> packages/scraping, packages/domain
packages/db -> packages/domain
packages/domain -> 外部依存なし
```

`packages/domain` はDB、ファイルシステム、Puppeteer、HTTPクライアントに直接依存しない。

## job入口

手動実行を正式に許容する。

```txt
node apps/jobs/collect-master.js --source xxx --dry-run
node apps/jobs/scan-owned-files.js --dry-run
node apps/jobs/collect-download-links.js --source xxx
node apps/jobs/sync-thumbnails.js
```

PM2も同じ入口JSを呼ぶ。

## DB設計の前提

- schemaは `cl`。
- すべて小文字。
- 初期SQLは `ops/sql` に置く。
- 権限付与ではsequenceも対象にする。
- 将来のmigration作成を見て、schema `usage` だけでなく `create` 権限も対象にする。
- 具体テーブル設計はQ9以降で詰める。
