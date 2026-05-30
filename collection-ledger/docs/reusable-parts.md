# 既存プロジェクトから使える部品

既存プロジェクト `C:\Users\toyoaki\Desktop\filedatachange` を読み取り専用で確認した結果、新プロジェクトで参考にできる部品。

## 共通化候補

- `.env` 読み込み。
- DB接続。
- safety gate。
- dry-run。
- CSVログ出力。
- run id作成。
- 進捗ログ。
- エラーログ。
- URL正規化。
- ランダム待機。
- retry。
- stage tableへのbulk insert。
- DB反映処理。
- Windowsパス正規化。
- パス安全確認。
- サムネイル保存・参照。
- ブラウザからファイルやフォルダを開くAPI。

## 既存から踏襲するルール

- DB破壊的変更は禁止。
- npmパッケージ追加は事前承認。
- 重複候補ファイルは自動削除しない。
- ローカル完結を優先する。
- dry-runとログを重視する。
- 不明点を推論だけで決めない。

## 既存から変える点

- ルート直下に実行JSを増やさない。
- ブラウザUI、API、実処理ジョブを分離する。
- `public` や既存 `xxx_...` ではなく、schema `cl` を使う。
- サイト固有処理は `packages/sources` に隔離する。
- 共通処理は `packages/core`、`packages/db`、`packages/scraping`、`packages/file-system` に寄せる。

