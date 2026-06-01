# Heydouga 4017 site design

この文書は、しろハメ / Heydouga 4017 を `collection-ledger` に追加するためのサイト固有設計案。
実装前の人間確認用であり、この文書だけではDB作成、SQL実行、ファイル移動、リネームを行わない。

## 確定事項

- 内部source名、DB接頭語、site_keyは `heydouga_4017` とする。
- 正式サイト/系列名は `Heydouga 4017` とする。
- UI表示名は `しろハメ` とする。
- ブラウザタブ名は `shirohame` とする。
- DBオブジェクト名はすべて小文字にする。
- マスター番号は `m002` とする。
- PM2自動実行は不要。枯れたサイトとして手動バッチ運用を基本にする。
- DL参照は今回不要。
- 今回はリネーム禁止。元ファイル名を保持して所持DBへ登録する。
- 実ファイル名に一意値が含まれない場合でも、今回ファイル名は変更しない。補助キーはCSV/DB側に持たせる。

## 取得元

主取得元:

```text
https://avjoy.me/search/videos/%E3%81%97%E3%82%8D%E3%83%8F%E3%83%A1?page=1
```

補助取得元:

```text
https://ggjav.com/ja/main/search?string=Heydouga%204017&type=all&page=1&order=pub_date
```

主取得元は、サムネイル、タイトル、一意キー候補が揃うが件数が少ない。
補助取得元は、件数補完とサムネイル補完に使う。ただしタイトルが完全でない可能性があるため、主取得元を優先する。

ページング:

- avjoy: `?page={page}`
- ggjav: URLSearchParams相当で既存 `page` を置換する。`page` を重複させない。

想定ページ数:

- avjoy: 52ページ、1ページ16件
- ggjav: 43ページ、1ページ24件

詳細ページ:

- avjoy、ggjavともに今回のマスター取得では詳細ページを見ない。

## HTML抽出方針

実HTMLを1ページ確認した時点の候補。
実装時に小さなdry-runで再確認する。

### avjoy

- レコード枠: 検索結果の動画カード
- タイトル: `span.content-title`
- サムネイルURL: `.thumb-overlay img` の `src`
- 作品URL: `a.search-video-click` の `href`
- 一意キー候補: タイトルから抽出

タイトル例:

```text
Heydouga 4017 PPV229-6 ...
```

### ggjav

- レコード枠: `div.columns.item.float-left`
- タイトル: `.item_title a`
- サムネイルURL: `img.item_image` の `src`
- 作品URL: `.item_title a` の `href`
- 一意キー候補: タイトルから抽出

タイトル例:

```text
Heydouga 4017-PPV250-8 ...
```

## 一意キー設計

一意キーは数値ではなくtextで扱う。

マスター側の標準キー:

```text
250-1
250-8
```

所持ファイル側で枝番なしの複数候補を人間確認で分ける場合の補助キー:

```text
250-a
250-b
250-c
```

`250-a` と `250-1` は所持照合上の別候補として扱う。
ただし、`250-a` などは原則として所持側の補助キーであり、サイト取得マスターの正式キーとして自動登録しない。

マスターには、一意キーとは別に枝番なし番号を持たせる。

```text
unique_key = 250-8
base_no    = 250
branch_no  = 8
```

これにより `base_no = 250` でグループ化できる。

## キー抽出ルール

タイトルから次の形を広く拾う。

```text
Heydouga 4017 PPV229-6
Heydouga 4017-PPV250-8
Heydouga_4017_PPV250_8
Heydouga4017_243
Heydouga4017-243
Heydouga4017-243_4K
```

正規化の基本:

- `Heydouga 4017`、`Heydouga4017`、`4017` を許容する。
- `Heydouga4037` や `Heydouga4044` などは別サイト扱いであり、4017として拾わない。
- 4017は固定条件にする。4017以外は混入候補として除外または確認CSVへ出す。
- `PPV` はキー抽出時に除去する。
- 区切り文字は `-` に限らない。空白、`_`、`.`、全角空白などを許容する。
- 最終的な `unique_key` は `{base_no}-{branch_no}` 形式にする。
- 抽出結果の `base_no` と `branch_no` はtextとして保持する。

正規化の固定ルール:

- まず `heydouga` と `4017` の組み合わせがある行だけを対象にする。
- `4017` の直後または近傍にある `ppv` は無視する。
- `base_no` と `branch_no` は、`4017` の後方近傍からだけ抽出する。
- `4017` より前に出る日付、画質、時間、別サイト番号はキー候補にしない。
- `base_no` は `4017` と任意の `ppv` の後に現れる数字列とする。
- `branch_no` は `base_no` の直後に区切り文字を挟んで現れる数字列、または人間確認済みアルファベットとする。
- `base_no` が読めない、または `branch_no` の前に別の数字列が混じる場合は `needs_review` にする。
- 区切り文字は抽出時だけ許容し、保存時は必ず半角ハイフン1つへ正規化する。
- `250 8`、`250_8`、`250.8` はすべて `250-8` に正規化する。
- `250-a`、`250_b` のようなアルファベット枝番は、人間確認済みの所持補助キーとしてだけ許容する。
- 自動抽出でアルファベット枝番を作らない。

安全策:

- 枝番が読めないファイルは自動で `250-a` などにしない。
- 同じ `base_no` に複数の枝番なし候補がある場合、人間確認CSVで `250-a`、`250-b`、`250-c` を割り当てる。
- `base_no` だけ一致する所持ファイルは `needs_review` とする。
- 自動登録対象は、`unique_key` が明確に読め、マスターに存在し、人間確認済みのものだけにする。
- `250-a` などの手動キーは、原則として所持側の揺れを扱うための補助キーとして使う。
- マスター側にサイト由来の枝番付き正式レコードがある場合は、その正式レコードを優先する。
- マスターへ登録するのは、サイト取得マスターまたは人間確認済みのマスター欠損補完だけにする。

## rawの保持方針

rawは、加工前の取得値を後から確認するために残す。

保持候補:

- 取得元サイト名。例: `avjoy`, `ggjav`
- source_page_url
- page_number
- row_index_in_page
- raw_title
- raw_thumb_url
- raw_detail_url
- extracted_unique_key
- extracted_base_no
- extracted_branch_no
- raw_payload jsonb
- last_run_id

## マスターDB案

PACOの `paco_m001_master_*` と同じ段階を持つ。

候補テーブル:

```text
cl.heydouga_4017_m002_master_collect_runs
cl.heydouga_4017_m002_master_page_logs
cl.heydouga_4017_m002_master_raw
cl.heydouga_4017_m002_master_staging
cl.heydouga_4017_m002_master
```

主なカラム案:

```text
staging_id bigserial primary key
candidate_unique_key text
candidate_base_no text
candidate_branch_no text
confirmed_unique_key text
confirmed_base_no text
confirmed_branch_no text
title text
detail_url text
thumbnail_url text
source_site text not null
source_priority integer not null
raw_id bigint
review_status text
note text
last_run_id text
```

stagingは複数raw由来の候補を潰さない。

- avjoyとggjavの同一キー候補は、stagingでは複数候補として保持できるようにする。
- rawは全保存する。
- stagingは `staging_id` を主キーにし、`raw_id`、`source_site`、`last_run_id` を追える形にする。
- 曖昧候補を扱うため、candidate系はNULLを許容する。
- 人間確認後にconfirmed系へ確定値を入れる。
- 正式マスターへ昇格する段階でのみ `unique_key` を一意にする。
- 承認状態は `review_status` に寄せる。`approved` boolean は持たない。
- `review_status` は `pending`、`approved`、`rejected`、`needs_review` のようにCHECK制約で固定する。

正式マスター:

```text
unique_key text primary key
base_no text not null
branch_no text not null
title text not null
detail_url text
thumbnail_url text
thumbnail_file_path text
primary_source_site text not null
primary_staging_id bigint
review_status text not null
note text
created_at timestamptz
updated_at timestamptz
```

正式マスターへの昇格条件:

- 人間確認済みCSVで `review_status = approved` になっている。
- `unique_key`、`base_no`、`branch_no`、`title` が確定している。
- 同一 `unique_key` の複数候補がある場合、avjoy優先を基本にしつつCSVで採用行を確認する。
- DBレビュー後、確認済み行だけ正式マスターへ登録する。
- 正式マスターだけが、所持正式テーブルからのFK参照先になる。
- `unique_key` のUNIQUE/PRIMARY KEY制約は正式マスターにだけ置く。

重複統合:

- `unique_key` が同じ場合は同一マスター候補として扱う。
- avjoyを主、ggjavを補助として扱う。
- 両方に同じ `unique_key` がある場合、タイトルはavjoyを優先する。
- サムネイルはavjoyを優先し、avjoyにない場合だけggjavを補完候補にする。
- ggjavにだけある `unique_key` は補助由来の候補として `review_status = pending` にする。

DB書き込み境界:

- HTML取得dry-runではDBへ書かず、CSV/JSONだけ出す。
- init-db SQLはDBレビューと人間OK後にだけ実行する。
- raw投入、staging投入、正式昇格、補完登録、更新、差分反映は、それぞれ別applyとして扱う。
- 各applyごとにdry-run出力、対象件数、SQL内容、確認済みCSV、実行承認を必須にする。
- 正式マスター登録は、確認済みCSVとDBレビュー後にだけ行う。
- 更新は差分CSVで承認された列だけに限定し、既存値の無確認上書きはしない。

## サムネイル

マスターDBにサムネイルURLを保存する。
画像取得は別ジョブに分ける。

raw取得保存先:

```text
storage/thumbnails/heydouga_4017/raw/{source_site}
```

本流保存先:

```text
storage/thumbnails/heydouga_4017/master
```

raw段階のファイル名:

```text
{source_site}_{raw_id}.{ext}
```

承認済みmasterに紐づく本流ファイル名候補:

```text
{unique_key}.{ext}
```

本流サムネイルは正式マスター `unique_key` 限定で保存する。
所持側補助キー `250-a` などでは本流サムネイルを作らない。
手動補完が必要な場合も、最終的には同じ本流ディレクトリへ合流する。

上書き禁止:

- 既存の本流サムネイルがある場合は上書きしない。
- avjoyとggjavで同じ `unique_key` のサムネイルが違う場合は差分候補としてCSV/JSONへ出す。
- 拡張子はURLまたはContent-Typeから判断し、jpg決め打ちにしない。
- URL拡張子とContent-Typeが矛盾する場合は、rawへ保存して確認候補にする。
- 同じ `unique_key` で拡張子違いの本流候補が出た場合は、既存本流を優先し、差分CSVへ出す。
- 既存本流と新規候補の拡張子が異なる場合、併存可否は差分CSVで人間確認する。
- 壊れ画像の再取得も、既存ファイルを上書きせず別名で保存して人間確認に回す。

## 所持ファイル設計

今回のサイトではリネームしない。
元ファイル名が貴重な情報を含むため、正式名への変換は行わない。

候補テーブル:

```text
cl.heydouga_4017_owned_file_raw
cl.heydouga_4017_owned_file_staging
cl.heydouga_4017_owned_file
```

出演者が取得できない可能性が高いため、初期設計では出演者リンクテーブルは作らない。
ただし、将来出演者情報を取得または補完できるようになった場合に、PACOと同じ2テーブル構成へ拡張できる余地を残す。

主な保持情報:

- source_site_id
- master_unique_key
- owned_manual_key
- candidate_base_no
- candidate_branch_no
- original_file_path
- current_file_path
- normalized_current_file_path
- file_name
- file_ext
- drive_letter
- file_size_bytes
- file_mtime
- content_hash
- match_status
- match_note
- last_seen_at

重要ルール:

- `current_file_path` はユニーク。
- Windowsパスは正規化した `normalized_current_file_path` でもユニークにする。
- 正式所持の `master_unique_key` は `cl.heydouga_4017_m002_master(unique_key)` を参照する。
- `owned_manual_key` は所持側の補助キーであり、FKにはしない。
- raw/stagingでは `needs_review` を保持できるが、正式所持テーブルには未確定行を入れない。
- リネームしない。
- 正規フォルダへの移動が必要な場合も、ファイル名は維持する。

所持キー検証:

- `master_unique_key` は正式マスターに存在するキーだけ許可する。
- アルファベット枝番を含む `250-a` などは、原則として `owned_manual_key` にだけ入れる。
- `master_unique_key` にアルファベット枝番が入った場合は、正式マスター補完済みであることを検証する。

所持側の段階:

- raw: スキャンしたファイル/ディレクトリの元情報をそのまま保存する候補。DB投入前にdry-run CSV/JSONを出す。
- staging: キー抽出、match_status、移動候補、人間確認欄、`owned_manual_key`、`master_unique_key` を持つ確認用候補。
- owned_file: 人間確認済みで、正式マスターと照合できた所持だけを登録する正式テーブル。

## 所持ファイル収集

検索語の表記揺れが大きいため、自動収集候補と人間の手動確認を併用する。
今回の初期実装範囲では移動applyを作らず、dry-run候補CSV/JSONまでに絞る。

注意点:

- ディレクトリ名だけで対象が分かる場合がある。
- 動画ファイル単体だけを安易に移動しない。
- ディレクトリ単位の移動が必要なケースを別扱いする。
- 最初はdry-runで候補一覧CSV/JSONだけ出す。
- ストレージ間移動は禁止。各NAS内だけで移動する。
- `4017` と枝番などが付いていて明らかなものは、移動候補CSVに出す。
- 明らかでないものは移動せず、候補CSVに出す。
- 本移動は全件確認後の別手順にし、別設計レビューと明示OK後にだけ作る。

将来apply移動を作る場合の安全条件:

- apply前に、移動元と移動先の解決済み絶対パスをCSV/JSONへ出す。
- 移動元と移動先が同じドライブまたは同じNAS root配下であることを機械的に検証する。
- ストレージ間移動は禁止する。
- 上書きは禁止する。
- 既存同名がある場合はapply対象から外し、衝突CSVへ出す。
- 空パス、ドライブ直下、親ディレクトリ、許可root外への移動は禁止する。
- ディレクトリ単位移動では、対象ディレクトリが許可root内にあり、移動先も許可root内であることを確認する。
- 今回はリネーム禁止のため、移動後ファイル名やディレクトリ名を変えない。
- 移動が実質的な別名変更になる場合はapply対象から外す。

Windowsパス正規化:

- ドライブ文字は大文字へ寄せる。
- 区切り文字は `\` へ寄せる。
- 末尾区切りは取り除く。
- 大文字小文字差だけの別パスは同一候補として扱う。
- UNC、短縮名、シンボリックリンク、ジャンクションが疑われるものは `needs_review` にする。

候補ディレクトリ:

```text
?:\uncen\heydouga_4017
P:\uncen\heydouga_4017_new_master
P:\uncen\heydouga_4017_new_mp4
P:\uncen\heydouga_4017_trash
P:\uncen\heydouga_4017
```

## 所持照合

照合は何度かトライアンドエラーする前提にする。

流れ:

1. 対象フォルダをスキャンする。
2. ファイル名と親ディレクトリ名からキー候補を抽出する。
3. 明確な `unique_key` が読めるか判定する。
4. `base_no` だけ読めるものは `needs_review` にする。
5. 枝番なし候補は人間確認CSVで `250-a` などを割り当てる。
6. マスターに存在するか確認する。
7. CSV/JSONを出す。
8. 人間確認済みのものだけ正式所持DBへ登録する。

枝番なし候補の扱い:

- まずdry-runで候補を出す。
- 人間がCSVの `owned_manual_key` や `master_unique_key` に `250-a` などの一意値を記入する。
- ファイル名は変更しない。
- 再度dry-runし、CSV/DB側の補助キーで抽出と照合が通ることを確認する。
- すべてのdry-runとトライアンドエラーが通ってから、本登録する。
- この補助キーは原則として所持側の揺れを処理するためのものと考える。
- `250-a` などを理由に、マスターへ自動補完登録しない。

マスター欠損の扱い:

- 実ファイルはあるがマスターに存在しないものは、`missing_master` として候補CSVに出す。
- 人間がCSVにタイトル、一意キー、必要な補足を加筆する。
- 補完登録に必要な最小項目は `unique_key`、`base_no`、`branch_no`、`title` とする。
- DBレビュー後、確認済み行だけマスターへ補完登録する。
- マスター補完後に、所持照合を再dry-runする。
- マスター欠損補完は、所持側補助キーの自動昇格ではなく、人間が確認した別フローとして扱う。

今回の照合ステータス候補:

```text
matched
needs_review
missing_master
unreadable
duplicate_candidate
manual_key_required
```

## DL参照

今回は作らない。

DB、ジョブ、UIともにDL参照追加は対象外とする。
ブラウザのCompletion ViewでDL可能列が必要な場合は、NULLまたはfalse相当で扱う。
DL参照なしサイトのView列型と既存UI期待値はDBレビューで確定する。

## ブラウザ/UI

ブラウザ/APIへ進む前に、DB/Viewを先に揃える。
実処理は `apps/jobs` に閉じ、API/UIからDB更新やファイル移動を直接行わない。

サイト固有の追加列、絞り込みは現時点ではなし。

UI表示:

- 表示名: `しろハメ`
- タブ名: `shirohame`
- サイドバー名: `しろハメ`

## 実装前レビューが必要なもの

DBレビュー:

- `heydouga_4017_m002_master_*` SQL
- `heydouga_4017_owned_file` SQL
- 共通マスター反映SQL
- 所持View、非所持View

JSレビュー:

- avjoy / ggjav スクレイピング
- 主取得元と補助取得元の統合処理
- 所持ファイルスキャン
- ディレクトリ単位移動を含む収集dry-run
- 所持照合のキー抽出

全体レビュー:

- 今回だけリネーム禁止にする運用差分
- DL参照なしのBrowser DB/View
- 出演者なしサイトとしての共通マスター反映

## 次に決めること

- 実HTMLのdry-run結果で、avjoyとggjavの件数、重複、補完差分を確認する。
- 所持ファイル収集dry-runで、移動候補CSVと確認CSV候補の分かれ方を確認する。
- マスター欠損候補CSVの列を決める。
- 出演者情報が将来取得できた場合の拡張タイミングを、DBレビュー時に再確認する。

## run / page log 最低限カラム

dry-run、再実行、差分確認のため、collect runとpage logには最低限次を持たせる。

collect run:

- run_id
- source_name
- mode
- params jsonb
- started_at
- finished_at
- status
- error_message
- rows_collected
- rows_inserted
- rows_updated

page log:

- run_id
- source_site
- page_number
- fetched_url
- http_status
- content_hash
- row_count
- status
- error_message
