# paco owned file design

## 決定事項

paco の所持ファイルは、作品ファイル本体と出演者リンクを分けて管理する。

```text
cl.paco_owned_file
cl.paco_owned_file_actor
```

この2テーブル構成にする理由は次の通り。

- 1ファイルに複数出演者を紐付けられる。
- 出演者なし、単体、複数出演者の作品を同じ形で扱える。
- `actor_name_master` と `actor_group_master` を使って、出演者名と人物グループを正規化できる。
- 他サイトでも同じ形の `site_owned_file` / `site_owned_file_actor` を作りやすい。
- ブラウザ/API用のviewを作る時に、作品・所持パス・出演者検索を組み合わせやすい。

## cl.paco_owned_file

所持している実ファイル1件につき1レコードを持つ。

主な責務:

- 実ファイルのパスを保持する。
- paco作品マスターの `movie_code` と紐付ける。
- ファイル名、拡張子、ドライブ、サイズを保持する。
- 再スキャン時に `last_seen_at` を更新する。

重要な制約:

- `file_path` はユニーク。
- `movie_code` は `cl.paco_m001_master_staging(movie_code)` を参照する。

## cl.paco_owned_file_actor

所持ファイルと出演者マスターの中間テーブル。

主な責務:

- 1ファイルに複数出演者を紐付ける。
- `actor_name_id` と `actor_group_id` の両方を保持し、名前単位・グループ単位の検索を楽にする。

重要な制約:

- `owned_file_id` は `cl.paco_owned_file(owned_file_id)` を参照し、ファイル削除時はcascadeで消える。
- `actor_name_id` は `cl.actor_name_master(actor_name_id)` を参照する。
- `actor_group_id` は `cl.actor_group_master(actor_group_id)` を参照する。
- `unique(owned_file_id, actor_name_id)` で同一出演者の重複リンクを防ぐ。

## 投入方針

対象ファイルは各NASの直下にある `?:\uncen\paco` のファイルのみ。
`unmatched` ディレクトリは対象外。

リネーム済みファイル名から `movie_code` を抽出し、`cl.paco_m001_master_staging` と照合する。
出演者は `cl.paco_m001_master_staging.actor_name` をカンマで分解し、`site_id = 1` の `cl.actor_name_master` と結合する。

投入は再実行可能にする。

- `cl.paco_owned_file` は `file_path` conflictで更新。
- `cl.paco_owned_file_actor` は対象ファイル分のリンクを削除してから再作成。
- 未照合ファイルがある場合はDB投入前に停止する。
