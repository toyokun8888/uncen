# 決定事項

## プロジェクト

- プロジェクト名は `collection-ledger`。
- 新規プロジェクトとして `c:\uncen\collection-ledger` に分離する。
- 既存プロジェクト `C:\Users\toyoaki\Desktop\filedatachange` は参照元・参考元として扱う。
- 既存プロジェクトを直接肥大化させない。

## 技術構成

- 既存プロジェクトと同じ技術を基本路線にする。
- Node.js、PostgreSQL、React、Vite、TypeScriptを使う。
- APIは必要に応じてExpressを使う。
- スクレイピングは既存同様、Puppeteer、Cheerio、axiosを想定する。

## DB

- PostgreSQLを使う。
- 新規DBオブジェクトはschema `cl` に分離する。
- DB接続ロールは既存と同じものを使う。
- DBオブジェクト名はすべて小文字にする。
- sequence権限付与を忘れない。
- schema usage/create権限、table権限、sequence権限、default privilegesを初期SQLに含める。

## レイヤー

- ブラウザUIと実処理ジョブを分ける。
- `apps/web` はブラウザUI。
- `apps/api` はブラウザUI向けAPI。
- `apps/jobs` は手動実行・PM2自動実行の入口JS。
- `packages/*` は共通部品とドメインロジック。
- 実処理JSは `node apps/jobs/xxx.js` で直接実行できるようにする。

## まだ決めないこと

- Q9以降のプロトタイプ範囲。
- 最初に対応するサイトの具体URLやselector。
- 最初のDBテーブル粒度。
- 所持ファイル判定の詳細。
- DL可能リンクの取得・表示・自動DLの範囲。
