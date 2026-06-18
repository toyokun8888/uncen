# Tokyo-Hot 実装順仕様書

この文書は、`docs/new-site-questionnaire.md` の回答をもとに、Tokyo-Hot / 東京熱を `collection-ledger` に追加する本実装前の確認用仕様書である。

この文書だけでは、DB作成、SQL実行、ファイル移動、リネーム、バッチ配置、本実行を行わない。オーナー確認後に、ここで合意した順番だけを本実装する。

## 読み込み済み前提

- `rules.md`
- `AGENTS.md`
- リポジトリ内の全 `.md`
- 既存サイト設計: PACO、Heydouga 4017、10musume、HEYZO、1Pondo、H0930、Caribbeancom
- 既存運用: `manual-batch-operations.md`
- 既存実装: サイト別 pipeline、owned operations、manual thumbnail、DL reference、video metadata、API source registry

## 本実装可否

結論: 本実装は可能。

ただし、以下は本実装に入る前にオーナー確認が必要。

1. `source名:n` をそのまま使うか、実装上は `tokyo_hot` にするか。実装上の表記を許可
2. マスター番号を既存の続きとして `m008` にするか。　ＯＫ
3. DB接頭語を `tokyo_hot` にするか。ＯＫ
4. 質問票の一覧URLは `vendor=%E6%9D%B1%E7%86%B1` だが、実測では0件だったため、実装URLは `vendor=Tokyo-Hot` に置き換えてよいか。Ｏｋ
5. `対象NAS: 全部`、`対象外フォルダ: 全部` の具体的なドライブ範囲を、本実装前に実機で確認してよいか。ＯＫ
6. Q8のフォルダ `G:\all\お気に入りD(F)\新規DL\月極\東熱` は、特別フォルダとして扱い、全ファイル所持扱い・リネーム禁止・ファイル名から一意値/タイトル/出演者を取得する仕様でよいか。ＯＫ，それでよい。さらにこのファイルにあってマスターにないものは、マスターにこのファイル名でマスター登録すること
7. DL参照で「4KとHDは別扱い」を、同一 `movie_code` に対して `resolution_variant = 4k | hd | unknown` のような区分を持つ意味でよいか。ＯＫ

上記のうち 1、2、3 は命名に関わるため、未確認のままSQLやJSを作らない。回答した。確認して

## 既存踏襲する方式

既存サイト追加の標準方式を踏襲する。

- DBは `cl` schema。
- DBオブジェクト名は小文字。
- SQLは `ops/sql`。
- 実処理入口は `apps/jobs`。
- サイト固有処理は既存 pipeline と owned operations の型に合わせる。
- ブラウザ/APIはDB/Viewが揃ってから進める。
- 手動バッチは `ops/batches` とNAS上の実配置を分けて確認する。
- 所持登録後のHD/4K/LOW判定は `collect-video-metadata.js` の ffprobe 結果で行う。
- ファイル移動は同一NAS内だけ。
- 上書き禁止。
- dry-run / review CSV / apply の順番を守る。
- 本実装前レビュー、実装後レビュー、ブラウザ確認、動画再生確認を行う。

## サイト固有の暫定値

オーナー確認待ちを含む。

```text
source / site_key 候補 = tokyo_hot
正式サイト名          = Tokyo-Hot
UI表示名              = 東京熱
master_no             = m008 候補
db_prefix             = tokyo_hot 候補
公式一意キー          = n + 数字。例: n1067
公式マスターURL       = https://my.tokyo-hot.com/product/?page={page}&vendor=Tokyo-Hot
公式最大ページ        = 70
DL参照URL             = https://hijav.net/category/jav-uncensored/tokyo-hot/page/{page}/
DL参照最大ページ      = 128
手動サムネイル入力    = P:\uncen\tokyo_hot_thumbnails 候補
手動マスター入力      = P:\uncen\tokyo_hot_new_master 候補
手動所持入力          = ?:\uncen\tokyo_hot_new_mp4 候補
正規所持フォルダ      = ?:\uncen\tokyo_hot 候補
trashフォルダ         = ?:\uncen\tokyo_hot_trash 候補
```

注意:

- 上記の `tokyo_hot_new_mp4`、`tokyo_hot`、`tokyo_hot_trash` は、今後の手動バッチ運用や正規配置の候補である。
- 既存所持ファイルの検索範囲ではない。
- 既存所持ファイルの検索範囲は、質問票Q9どおりNAS全部である。

## 外部URL実測結果

2026-06-17 に外部URLを `curl` で実測した。

保存した確認用HTML:

```text
storage/exports/tokyo_hot_official_page70_check.html
storage/exports/tokyo_hot_official_vendor_tokyohot_page1_check.html
storage/exports/tokyo_hot_official_vendor_tokyohot_page70_check.html
storage/exports/tokyo_hot_official_vendor_tokyohot_page71_check.html
storage/exports/tokyo_hot_official_detail_n2046_check.html
storage/exports/tokyo_hot_hijav_page128_check.html
storage/exports/tokyo_hot_hijav_detail_n1083_check.html
```

公式一覧:

- 質問票URL `https://my.tokyo-hot.com/product/?page=70&vendor=%E6%9D%B1%E7%86%B1` はHTTP 200だが、本文は `0 items found` / `No Results`。
- サイト内Studioフィルタでは `vendor=Tokyo-Hot` が使われている。
- `https://my.tokyo-hot.com/product/?page=1&vendor=Tokyo-Hot` は `3457 items found`。
- `https://my.tokyo-hot.com/product/?page=70&vendor=Tokyo-Hot` は `3457 items found` で、`n0007` から `n0001` まで7件を確認。
- `https://my.tokyo-hot.com/product/?page=71&vendor=Tokyo-Hot` は `No Results`。
- 最大ページ70は実測で妥当。
- 一覧カードは `<ul class="list slider cf">` 配下の `<li class="detail">`。
- 詳細URLは `/product/n2046/` のような形。
- 一覧サムネイルは `https://my.cdn.tokyo-hot.com/media/{movie_code}/list_image/.../220x124_default.jpg`。
- 一覧タイトルは `.description2 .title`。
- 一覧のProduct IDは `.description2 .actor` に `(Product ID: n2046)` の形で入る。

公式詳細:

- `https://my.tokyo-hot.com/product/n2046/` を確認。
- タイトルは `.pagetitle h2` または詳細部の `h2`。
- 出演者名は詳細の `Model` 行で取得できる。例: `Mitsuka Koizumi`, `Jun Shiina`。
- Product IDは詳細の `Product ID` 行で `n2046`。
- 詳細ページにはサンプル動画、jacket、vcap画像もあるが、今回のマスター必須項目は一覧サムネイルと詳細出演者名で足りる。

HIJAV:

- `https://hijav.net/category/jav-uncensored/tokyo-hot/page/128/` はHTTP 200。
- 投稿は `div[id^="post-"]`。
- page128には `Tokyo Hot n1083` だけでなく `k1214`、`k1213` も混在する。
- 投稿本文に `作品番号 n1083` のような番号行がある。
- 一覧ページではRapidgatorリンクがない投稿があり、詳細ページfallbackが必要。
- `https://hijav.net/tokyo-hot-n1083/` の詳細ページでは `rapidgator.net/file/.../n1083_...wmv.html` を確認。
- 4K表記はサイドバー等にも大量に出るため、Tokyo-Hot投稿本文またはタイトルに限定して判定する必要がある。

本実装の最初に、保存済みHTMLだけでなく最新HTMLに対しても小さいdry-runで以下を再確認する。

- `vendor=Tokyo-Hot` で公式一覧ページを取得できるか。
- 一覧から `nxxx`、タイトル、サムネイルURL、詳細URLが取れるか。
- 詳細ページから出演者名が取れるか。
- ページ70が実在し、ページ71が終端相当か。
- HIJAVの `tokyo-hot/page/{page}/` で投稿一覧が取れるか。
- HIJAV詳細ページfallbackでRapidgatorリンクが取れるか。
- 4K表記を投稿本文または投稿タイトルに限定して抽出できるか。

実HTML構造が上記と違う場合は、実装を止めてオーナーへ報告する。

## 実装順

### Phase 0. オーナー確認

この文書をオーナーに見せ、未確定事項のOKを得る。

確認対象:

- `site_key = tokyo_hot`
- `db_prefix = tokyo_hot`
- `master_no = m008`
- Q8フォルダの扱い
- DL参照の4K/HD別扱い
- リネーム禁止の範囲

### Phase 1. 公式マスター取得dry-run

目的: 公式HTML構造とキー抽出が実装可能か確認する。

作るもの:

- `apps/jobs/tokyo-hot-pipeline.js`

この段階ではDB変更しない。

確認する項目:

- 1ページだけ取得。
- `nxxx` の抽出。
- タイトル抽出。
- サムネイルURL抽出。
- 詳細URL抽出。
- 詳細ページから出演者名抽出。
- CSV/JSON preview 出力。

完了条件:

- 10件程度のサンプルで `movie_code`、title、actor、thumbnail_url、detail_url が確認できる。
- `n0183` のようなゼロ埋めコードを壊さない。

### Phase 2. SQL設計

目的: Tokyo-Hot用DB外郭を作る。

作る候補:

```text
ops/sql/140_tokyo_hot_site.sql
```

候補テーブル/View:

```text
cl.tokyo_hot_m008_master_collect_runs
cl.tokyo_hot_m008_master_page_logs
cl.tokyo_hot_m008_master_raw
cl.tokyo_hot_m008_master
cl.tokyo_hot_m008_thumbnail_assets
cl.tokyo_hot_owned_file
cl.tokyo_hot_owned_file_video_metadata
cl.tokyo_hot_dl_reference
cl.tokyo_hot_dl_reference_runs
cl.tokyo_hot_dl_reference_page_logs
cl.tokyo_hot_v_thumbnail_assets
cl.tokyo_hot_v_library_items
cl.tokyo_hot_v_completion_items
```

正式キー:

```text
movie_code text primary key -- 例: n1067
numeric_code integer        -- 例: 1067、補助ソート用
```

注意:

- `movie_code` は `n` + 数字を小文字正規化する。
- `n0183` と `n183` は同一扱いにするか、公式表記優先にするかをオーナー確認後に決める。公式一覧はゼロ埋め4桁の `n0001` 形式を持つ。
- 4K/HDはファイル名ではなく動画メタデータで判定する。ただしDL参照側の4K別リンクは別区分で保存する。

レビュー:

- DBレビュー必須。
- レビュー後、オーナーOKなしにSQLを実行しない。

### Phase 3. マスターDB投入

目的: 公式マスターをDBへ入れる。

順番:

1. `init-db` dry-run相当のSQL確認。
2. DBレビュー。
3. オーナーOK。
4. `init-db` 実行。
5. `--step master --max-pages 1 --limit 10` 相当で少量投入。
6. status確認。
7. 問題なければ `--max-pages 70` で全件取得。

完了条件:

- 公式マスター件数。
- raw/master件数。
- 出演者名取得件数。
- サムネイルURLあり件数。
- 重複キー件数。
- 取得失敗ページ件数。

### Phase 4. サムネイル取得

目的: 公式一覧から取得したサムネイルを本流保存する。

保存先候補:

```text
storage/thumbnails/tokyo_hot/master
```

手動補完先候補:

```text
P:\uncen\tokyo_hot_thumbnails
```

作る候補:

```text
apps/jobs/import-tokyo-hot-manual-thumbnails.js
ops/batches/tokyo_hot_manual_thumbnail_apply.bat
```

完了条件:

- 自動サムネイル取得件数。
- failed件数。
- 手動補完フォルダとバッチの配置確認。
- ブラウザ用thumbnail viewで参照できること。

### Phase 5. 共通マスター反映

目的: `site_master`、`actor_group_master`、`actor_name_master` へ反映する。

順番:

1. Tokyo-Hotの `site_master` 行を追加するSQLを確認。
2. actor抽出の区切りを実データで確認。
3. DBレビュー。
4. オーナーOK。
5. 反映。

完了条件:

- `site_master` に東京熱がある。
- 出演者名が `actor_name_master` に登録されている。
- 重複・空文字・区切り誤りがない。

### Phase 6. 所持ファイル収集・照合dry-run

目的: NAS内の既存所持ファイルを安全に候補化する。

このPhaseでは、検索範囲を `?:\uncen\tokyo_hot_new_mp4` や `?:\uncen\tokyo_hot` に限定しない。

質問票Q9の仕様どおり、既存所持ファイル検索はNAS全部を対象にする。`tokyo_hot_new_mp4` は将来の手動投入フォルダ候補であり、既存所持検索範囲ではない。

検索ルール:

- `n` だけでは拾いすぎるため、必ず `n` の後ろの番号まで読む。
- 動画拡張子だけ対象。
- `n1067`、`n1084_mizuki_kayama`、`n0183.4K`、`n0279` を読めるようにする。
- 区切り文字 `_`、`-`、空白、`.` を許容する。
- リネーム禁止。
- 対象NASは全部。
- 対象外フォルダも全部。
- `n` の後ろに番号が読めないものは、Tokyo-Hot候補として自動採用しない。
- ファイル名や配置がさまざまな前提で、候補抽出後にCSVで確認する。

特別フォルダ:

```text
G:\all\お気に入りD(F)\新規DL\月極\東熱
```

このフォルダの仕様:

- 例外所持フォルダではないが、通常のNAS全体検索とは別枠で明示的に扱う。
- 全部所持扱い。
- このフォルダ内のファイルには、一意値、タイトル、出演者が揃っている前提。
- 先頭の `n` と番号で照合する。
- ここにあるファイルはリネーム禁止。
- ここにあって公式マスターにないものは、ファイル名から一意番号、タイトル、出演者を取得して、確認CSV経由でマスター登録候補にする。
- 自動でDB登録しない。DB登録前にレビューとオーナー確認を挟む。

作る候補:

```text
apps/jobs/tokyo-hot-owned-operations.js
```

最初はdry-run / review CSVまで。

確認する対象:

```text
NAS全部
G:\all\お気に入りD(F)\新規DL\月極\東熱
```

完了条件:

- scan件数。
- NAS全部を検索したことが分かるドライブ別件数。
- 特別フォルダ件数。
- matched件数。
- missing_master件数。
- unreadable件数。
- duplicate_candidate件数。
- 移動候補件数。
- リネーム候補が0件であること。

### Phase 7. 所持ファイルapply

目的: オーナー確認済みの所持ファイルだけを登録する。

運用ルール:

- NAS内移動はOK。
- ストレージ間移動は禁止。
- リネーム禁止。
- 正規所持フォルダへ移す場合も元ファイル名維持。
- Q8の特別フォルダは全部所持扱いだが、DB登録前に確認CSVを出す。
- Q8の特別フォルダはリネーム禁止。
- Q8の特別フォルダ内で公式マスターにないファイルは、ファイル名から `movie_code`、タイトル、出演者を抽出し、確認CSV経由でマスター補完する。
- Q8以外のNAS全部検索で見つかった候補は、ファイル名や配置がさまざまな前提で照合し、曖昧なものは正式登録しない。

順番:

1. review CSV出力。
2. オーナー確認。
3. master補完が必要ならDBレビューとOK後に補完。
4. 再review。
5. apply。
6. 所持DB登録。
7. `collect-video-metadata.js --source tokyo_hot --step collect` 実行。

完了条件:

- 移動実施件数。
- 移動なし登録件数。
- DB登録件数。
- 未登録件数。
- ffprobe `ok` 件数。
- 4K/HD/LOW件数。

### Phase 8. DL参照

目的: 未所持作品のDL可能リンクをHIJAVから参照できるようにする。

URL:

```text
https://hijav.net/category/jav-uncensored/tokyo-hot/page/{page}/
```

最大ページ:

```text
128
```

ルール:

- N番号以外は混入候補として扱う。
- `nxxx` に焦点を当てる。
- 先頭またはタイトル上の `4K` 表記は `resolution_variant = 4k` として、同じ `movie_code` のHD/通常リンクと別扱いにする。
- Rapidgatorの表示URLとhref URLを保持する。
- 一覧でRapidgatorが取れない場合は詳細ページfallbackを使う。
- 2から5秒のランダムウェイトを入れる。

完了条件:

- DL参照件数。
- matched_master件数。
- missing_master件数。
- ignored件数。
- 4K別扱い件数。
- terminal page確認。

### Phase 9. Browser DB/View

目的: API/UIが既存標準のまま読めるViewを作る。

View要件:

- library viewは所持ファイル1件単位。
- completion viewはマスター1件単位で所持・未所持・DL可否を集約。
- 4K/HD/LOWは `tokyo_hot_owned_file_video_metadata` の `probe_status = 'ok'` だけで判定する。
- DL側の4Kリンクは、動画メタデータとは別のDL参照属性として扱う。

完了条件:

- `cl.tokyo_hot_v_library_items`
- `cl.tokyo_hot_v_completion_items`
- `cl.tokyo_hot_v_thumbnail_assets`
- APIが読む列と型が既存sourceと合う。

### Phase 10. API / Web

目的: 既存ブラウザに東京熱を追加する。

変更候補:

```text
apps/api/src/services/source-registry.js
apps/jobs/collect-video-metadata.js
apps/web/src/App.tsx
```

表示:

```text
UI表示名 = 東京熱
```

追加の列、絞り込み、操作はなし。

完了条件:

- Local Libraryで東京熱が選択できる。
- Completionで東京熱が選択できる。
- サムネイル表示。
- 動画を開ける。
- フォルダを開ける。
- DLリンクを開ける。
- 4K/HD/LOW表示がffprobe由来。

### Phase 11. 手動バッチ

目的: 今までと同じ手動バッチ運用にする。

作る候補:

```text
ops/batches/tokyo_hot_master_apply.bat
ops/batches/tokyo_hot_owned_apply.bat
ops/batches/tokyo_hot_manual_thumbnail_apply.bat
```

配置候補:

```text
P:\uncen\tokyo_hot_new_master\tokyo_hot_master_apply.bat
?:\uncen\tokyo_hot_new_mp4\tokyo_hot_owned_apply.bat
P:\uncen\tokyo_hot_thumbnails\tokyo_hot_manual_thumbnail_apply.bat
```

注意:

- `?:\uncen\tokyo_hot_new_mp4` は手動バッチで新規投入するためのフォルダ候補。
- 既存所持ファイルの初回検索範囲ではない。
- 初回の既存所持検索は、Phase 6 のとおりNAS全部。

manual master batchは差分運用とし、既存と同じく最新少数ページを既定にする。初回全件取得の `--max-pages 70` は手動差分バッチに入れない。

完了条件:

- `ops/batches` 内のbat確認。
- NAS実配置確認。
- `Select-String` でbat引数確認。
- 空フォルダreview実行。
- 空フォルダapplyが0件で安全に終了。

### Phase 12. レビューと最終検証

本実装前:

- DBレビュー。
- JSレビュー。
- 全体レビュー。
- レビュー指摘反映。
- オーナーOK。

本実装後:

- `node --check`。
- statusコマンド。
- DB件数確認。
- video metadata件数確認。
- PM2再起動が必要な場合は既存方式で再起動。
- ブラウザ確認。
- 動画再生確認。
- オーナー目線の最終レビュー。

## 本実装前の完了条件チェックリスト

- [ ] この仕様書をオーナーが確認した。
- [ ] `site_key` / `db_prefix` / `master_no` が確定した。
- [ ] Q8フォルダの扱いが確定した。
- [ ] リネーム禁止の範囲が確定した。
- [ ] DL参照の4K/HD別扱いが確定した。
- [ ] DBレビュー対象が確定した。
- [ ] JSレビュー対象が確定した。
- [ ] 実HTML dry-runでセレクタ確認することに合意した。

## 残リスク

- 公式一覧と詳細は今回の実測では静的HTMLとして取得できたため、初期実装はCheerioで可能。ただし将来構造が変わった場合はPuppeteer検討。
- 質問票に書かれた `vendor=東熱` URLは0件だったため、オーナー確認後に `vendor=Tokyo-Hot` へ置き換える必要がある。
- `source名:n` をそのまま使うと、検索語・DB名・UI表示・API sourceとして曖昧すぎる。
- `n` 検索はNAS全体では混入が多くなる可能性が高いため、抽出後の番号検証とCSV確認が必須。
- `n0183` と `n183` のゼロ埋め扱いは、公式データを見てから確定する必要がある。
- Q8フォルダからのマスター補完は、公式マスターにないものをDBへ追加するため、DBレビューとオーナーOKなしに実行しない。
- DL参照側の4K別扱いは、既存completion viewへどう表現するかDB/View設計で確認が必要。

## オーナー確認質問集

本実装前に、以下を1問1答で確認する。

### Q1. 実装上の `source / site_key` は何にしますか？

回答:着物提案通りに

### Q2. DB接頭語は何にしますか？

回答:君の提案通りに

### Q3. マスター番号は既存の続きとして `m008` でよいですか？

回答:ＯＫ

### Q4. 公式マスターURLは、実測で0件だった `vendor=東熱` ではなく、件数が取れた `vendor=Tokyo-Hot` を使ってよいですか？

回答:Ｏｋ

### Q5. 既存所持ファイル検索は、仕様どおりNAS全部を対象にしてよいですか？

回答:ＯＫ

### Q6. `対象NAS: 全部` の実ドライブ範囲は、既存運用の全NASドライブを実機確認して確定する形でよいですか？

回答:ＯＫ

### Q7. `対象外フォルダ: 全部` は、検索から除外するフォルダを事前に狭めない、という意味でよいですか？

回答:Ｏｋ

### Q8. `G:\all\お気に入りD(F)\新規DL\月極\東熱` は、特別フォルダとして全部所持扱いでよいですか？

回答:ＯＫ

### Q9. 特別フォルダ内のファイルは、一意値、タイトル、出演者が揃っている前提で、ファイル名からマスター登録候補を作ってよいですか？

回答:Ｏｋ

### Q10. 特別フォルダ内のファイルは、公式マスターにない場合もリネーム禁止でよいですか？

回答:ＯＫ

### Q11. Q8以外のNAS全部検索で見つかった候補は、ファイル名や配置がさまざまな前提で、曖昧なものを正式登録しない扱いでよいですか？

回答:ＯＫ

### Q12. `n0183` と `n183` のようなゼロ埋め違いは、公式マスターの `n0000` 形式へ寄せる方針でよいですか？

回答:ＯＫ

### Q13. DL参照で同じ番号のHDと4Kがある場合、別扱いにするDB列を追加してよいですか？

回答:ＯＫ

### Q14. 手動バッチ用の `?:\uncen\tokyo_hot_new_mp4` は、新規投入用フォルダであり、初回の既存所持検索範囲ではない、という理解でよいですか？

回答:ＯＫ

### Q15. 本実装は、DBレビュー、JSレビュー、全体レビューを挟んだ後に開始する形でよいですか？

回答:いえ、個の仕様書があるので、各本実装前に小さくレビュー（この仕様通りにできてるか確認）だけでよい。ただし実装後の動作確認はしっかり行い、そこで不具合が見つかれば修正するように
