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

## paco m001 マスター

- 本番用テーブル名は `paco_m001_master_*` とする。
- マスターの一意キーは `movie_code` とする。
- `relation_key_mmddyy` は所持照合の候補キーとして保持するが、一意制約は付けない。
- 同じ `relation_key_mmddyy` に複数レコードがある場合は、マスターでは全部保持し、照合段階で人間確認する。
- 取得元一覧に同一 `movie_code` がページまたぎで重複する場合は、同一マスターレコードとして扱う。

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

## DB外郭

- 共通DB外郭は `docs/common-db-outline.md` に整理する。
- ここではテーブル名、テーブル数、カラム名、データ型はまだ決めない。
- 今後サイトが増えても共通するraw/staging/正式化/CSV確認/View作成の流れを外郭として扱う。
- サイト固有の取得カラム、一意キー、正式名ルール、正規化ルールは個別設計で扱う。
