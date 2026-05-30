# rules

このプロジェクトの定款。作業前に必ず読む。

## 禁止事項

- 外部ライブラリを勝手に追加しない。
- DBの破壊的変更をしない。
  - `drop`
  - `truncate`
  - 既存カラム削除
  - 未確認の一括上書き
- 既存プロジェクト `C:\Users\toyoaki\Desktop\filedatachange` を明示指示なしに変更しない。
- 重複候補ファイルを自動削除しない。
- ブラウザAPIと実処理ジョブを同じ場所に混ぜない。
- ルート直下に野良の実行JSを増やさない。
- あいまいなまま推論で決定しない。危険な分岐は2案以上を提示して確認する。

## 優先事項

- ローカル完結を優先する。
- 既存プロジェクトの使い勝手と運用知見を尊重する。
- 既存の肥大化から学び、責務を最初から分離する。
- 手動実行とPM2自動実行で同じjob入口を使う。
- dry-run、ログ、run id、CSV出力、エラー追跡を重視する。

## DBルール

- PostgreSQLを使う。
- 新規DBオブジェクトは専用schema `cl` に作る。
- DBオブジェクト名はすべて小文字にする。
- schema、table、view、column、index、sequenceの名前は小文字。
- `public` と既存 `xxx_...` 系の資産とは混ぜない。
- `bigserial`、`serial`、identityを使う場合はsequence権限付与を忘れない。
- schema権限、table権限、sequence権限、default privilegesを設計に含める。

## 実装ルール

- `apps/web`: ブラウザUI。
- `apps/api`: ブラウザUI専用API。
- `apps/jobs`: 手動実行・PM2自動実行の入口。
- `packages/*`: 共通部品、ドメイン、DB、スクレイピング、サイト固有処理。
- 手動実行は `node apps/jobs/xxx.js` を正式な運用として許容する。
- npm scriptsはショートカットであり、必須の入口にはしない。

