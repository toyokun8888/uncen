# Site Master Registration Workflow

Manual thumbnail and per-NAS owned-file batch operations are documented in
[`manual-batch-operations.md`](manual-batch-operations.md).

This document records the agreed workflow for adding another source site to
Collection Ledger. Follow this order when a new site is added, so the work stays
separated into common parts and site-specific parts.

## Video Resolution Rule

All browser 4K/HD/LOW labels must come from real video metadata collected by
`apps/jobs/collect-video-metadata.js` with `ffprobe-static`.

Do not classify resolution from file names in browser views. Each site must
define an owned-file metadata table in this form:

```text
cl.{owned_table_name}_video_metadata
```

Examples:

```text
cl.paco_owned_file_video_metadata
cl.heydouga_4017_owned_file_video_metadata
cl.tenmusume_owned_file_video_metadata
cl.heyzo_owned_file_video_metadata
cl.onepondo_owned_file_video_metadata
```

The library and completion views must join that metadata table and evaluate
only rows with `probe_status = 'ok'` for `resolution_class`, `best_resolution_class`,
`has_4k`, and `has_hd`.

## 目的

新しいHPを追加するときは、いきなりブラウザ画面やAPIへ進まない。先にマスター、所持、DL参照のDBを整え、ブラウザが参照できる土台を作る。

共通思想は次の通り。

- 共通部品とサイト個別処理を分ける。
- ブラウザ/API用の処理と、実行ジョブ用JSを分ける。
- JSは手動実行できる形を残す。例: `node apps/jobs/xxxx.js ...`
- 本番投入前に必ず小さいドライランを行う。
- DBは `cl` スキーマ配下、小文字名で統一する。
- sequence の権限付与を忘れない。
- 正式テーブルへ入れる前に raw / staging / CSV などで確認できる段階を作る。
- 人が確認するCSVが必要な場面では、DB投入や移動より先にCSVを出す。

## 1. サイト追加前の設計

最初に以下を決める。

- source 名: 例 `paco`
- 正式サイト名: 例 `pacopacomama`
- テーブル接頭語: 例 `paco_`
- マスター番号: 例 `paco_m001_`
- 対象サイトURL、ページング方法、最大ページ数
- 1意キー候補: 例 `movie_code`
- サムネイル取得可否
- DL参照取得可否
- 所持ファイルの検索語
- NASや対象ディレクトリの範囲

この段階では、キーやカラムを決め打ちしすぎない。実データを小さく集めてから判断する。

### サイトごとに必ず確認する変数

次の項目はサイト追加のたびに変わる。過去サイトの値をそのまま流用しない。

| 項目 | PACOでの値 | 次サイトでの扱い |
| --- | --- | --- |
| source | `paco` | 必ず新しいsource名を決める |
| 正式サイト名 | `pacopacomama` | 表示名・正式名を確認する |
| テーブル接頭語 | `paco_` | サイト別に分ける |
| マスター番号 | `m001` | 追加順・管理単位を決める |
| 検索語 | `pacopaco` | 検索サイト側で実測する |
| 最大ページ数 | `119` | 手動で最終ページを確認する |
| 1ページ件数 | 約18件 | 実HTMLで確認する |
| 1意キー | `movie_code` | 実データで重複確認して決める |
| 詳細ページ取得 | 111ページ以降で必要 | 一覧にリンクがない場合の分岐を確認する |
| サムネイル | 元サイトから取得 | 取得可否、保存名、手動補完を確認する |
| NAS範囲 | D/E/F/G/H/I/J/K/L/N/P | 対象ドライブを毎回確認する |

### 固定ルール

次の項目はサイトが増えても原則として変えない。

- common と site-specific を分ける。
- API / UI と job JS を分ける。
- DBは `cl` スキーマ、小文字名で作る。
- sequence grant を入れる。
- raw / staging / master の確認段階を作る。
- ドライラン、CSV、人の確認を挟む。
- 上書きしない。
- リネームは正式マスター照合後に行う。
- ブラウザ/APIへ進むのはDB外郭が固まってからにする。

## 2. マスター取得

マスターは最初に作る。PACOでは以下の流れで進めた。

1. 対象サイトのHTML構造を確認する。
2. 1ページだけ取得して、取れる項目を確認する。
3. 10件程度のドライランでDB投入を確認する。
4. 重複や1意キーの見立てを確認する。
5. 問題がなければ全ページ取得する。

PACOでは日付だけでは1意にならず、`movie_code` を1意キーとして採用した。同じ日付の複数レコードが存在する可能性を前提にする。

マスター系テーブルは、サイトごとに分ける。PACOでは `paco_m001_` でマスター001番を表す形にした。

## 3. raw と staging の扱い

元サイトの形や判断前の値は、可能な限り残す。

- raw: 取得元の形を残す場所
- staging: 正式化前に整える場所
- master: ブラウザ/APIや後続処理が参照する正式テーブル

件数が小さいサイトでは raw を残すほうが後から原因確認しやすい。PACO規模では、元の形を残す方針にした。

## 4. サムネイル

サムネイルURLがサイトから取れる場合は、マスターDBにURLを保存する。画像ファイルの取得は別ジョブに分ける。

PACOでは以下に保存した。

```text
storage/thumbnails/paco/master
```

手動で補ったサムネイルがある場合も、最終的には本流のサムネイルディレクトリへ合流する。ブラウザ表示時に参照先が分かれないようにする。

ファイル名は原則としてキー名にする。例:

```text
111518_376.jpg
```

## 5. 所持ファイルの収集

所持ファイル収集は、在庫照合とは責務を分ける。

最初の収集ジョブは「対象ファイルを寄せるだけ」にする。PACOでは、各NAS直下に以下のようなディレクトリを作成した。

```text
N:\uncen\paco
```

ルール:

- ストレージ間の移動は禁止。
- 各ストレージ内だけで移動する。
- 上書きは禁止。
- 同名があれば `(1)` などを付けて退避する。
- 収集段階ではリネームしない。
- 収集段階では所持DBへ正式登録しない。

この段階でリネームしない理由は、元ファイル名を失うと人間が確認できなくなるため。

## 6. 所持ファイルとマスターの照合

ファイル収集後に、マスターと照合できるかを確認する。

順番は以下。

1. 対象フォルダ内の全ファイル名を読む。
2. ファイル名からキー候補を抽出する。
3. マスターDBにキーが存在するか確認する。
4. 照合結果CSVを作る。
5. 人がCSVを確認する。
6. 読み取れないものと、マスター未登録を切り分ける。

この時点ではDBの正式登録、移動、リネームはしない。

PACOでは、検索値が含まれていないものは `unmatched` に一時移動して、人が確認した。読み取れるようになったものは1階層上へ戻した。

## 7. マスター未登録の補完

所持ファイル側には存在するが、マスターにないものは、CSVで人がタイトル・出演者を調べて補完する。

PACOでは補完CSVを作り、人が `title` と `actor` を入力した後、マスターDBへ追加した。重複や不要行は人が確認してから削除した。

手動補完分のサムネイルは自動取得できない場合がある。その場合は手動サムネイル用ディレクトリに置き、最後に本流へ合流する。

## 8. リネーム

正式マスターと照合できる状態になってから、初めてリネームする。

PACOのリネーム規則:

```text
movie_code_title_actor.ext
```

例:

```text
121114_307_title_actor.mp4
```

ルール:

- 必ずドライランする。
- 前ファイル名、新ファイル名、移動元、移動先が分かるJSONを作る。
- 失敗時に戻せるようにする。
- 上書きは禁止。
- 正式マスターに存在しないものはリネーム対象にしない。

全件リネーム前に、少数の実ファイルでテストして確認する。

## 9. 共通マスター

サイト追加時に共通化するマスターは以下。

```text
cl.site_master
cl.actor_group_master
cl.actor_name_master
```

目的:

- サイト名をID化する。
- 出演者の物理名をサイト単位で保持する。
- 同一人物だがサイトごとに名前が違うケースに備え、group を持つ。

`actor_name_master` は物理名を保持し、`actor_group_master` は同一人物を束ねるためのグループとして使う。

## 10. 所持正式テーブル

所持は、ファイル本体テーブルと出演者紐付けテーブルの2テーブル構成を基本にする。

理由:

- 1ファイルに複数出演者を紐付けられる。
- 出演者なし、単体、複数に対応できる。
- actor name / group を正規化できる。
- 他HPでも同じ形で作れる。
- 後で view を作りやすい。

PACOでは、実ファイルパスを必須にする。ブラウザから直接開くため。

## 11. DL参照マスター

未所持でも取得可能なリンクをブラウザから開けるよう、DL参照DBを作る。

PACOでは HIJAV を検索元にした。

```text
https://hijav.net/page/{page}/?s={search_keyword}
```

PACO実績:

- search keyword: `pacopaco`
- max pages: `119`
- 1ページあたり約18件
- 110ページ付近までは一覧内にRGリンクあり
- 111ページ以降は詳細ページを開く必要あり

取得ルール:

- 一覧ページで RG が取れる場合は一覧から取る。
- 一覧にない場合は詳細ページを開く。
- ページ移動、詳細ページ移動ともに2から5秒のランダムウェイトを入れる。
- 人がクリックするURLとして、表示テキスト側の rapidgator URL を主に保存する。
- href 側のURLも保存する。例: `reuplinks.com`
- RGがない場合は `no_rapidgator` として記録する。
- PACO以外の検索混入は `ignored` にする。
- マスターにないPACOコードが出た場合は、マスターへ最小情報で追加する。

PACO実行結果:

```text
dl_reference_count: 2153
has_rapidgator_count: 2153
no_rapidgator_count: 0
matched_master_count: 2152
missing_master_count: 0
ignored_count: 1
page_log_count: 119
```

`ignored` の1件はPACOではない検索混入だったため、マスター追加対象外にした。

## 12. 検証順

新しいサイト追加時は、以下の順で進める。

1. HTML構造を読む。
2. 取得キー候補を広く見る。
3. 1ページ取得で構造確認する。
4. 10件程度でDBドライランする。
5. 重複、キー揺れ、同一日付などを確認する。
6. テーブル名、カラム、型を確定する。
7. DBサブエージェントにレビューさせる。
8. JSサブエージェントにレビューさせる。
9. init-db を実行する。
10. 小さい本番投入を実行する。
11. status で件数を確認する。
12. 全件取得する。
13. 例外、未登録、混入を整理する。
14. マスター完了後に所持、DL参照、ブラウザへ進む。

## 13. 実行コマンド例

PACOのDL参照:

```bash
node apps/jobs/dl-reference-pipeline.js --source paco --step init-db --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
node apps/jobs/dl-reference-pipeline.js --source paco --step collect --dry-run --search-keyword pacopaco --start-page 110 --max-pages 1 --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
node apps/jobs/dl-reference-pipeline.js --source paco --step collect --search-keyword pacopaco --max-pages 119 --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
node apps/jobs/dl-reference-pipeline.js --source paco --step status --show-missing --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
```

PACO以外に広げる場合は、`source`、`search_keyword`、ページ数、テーブル接頭語、抽出セレクタをサイト別に切り替える。

## 14. ブラウザ作成へ進む条件

ブラウザ/APIへ進むのは、以下が揃ってから。

- サイト別マスターが完成している。
- サムネイル参照先が整理されている。
- 出演者共通マスターが作成済み。
- 所持正式テーブルが作成済み。
- 所持とマスターのリレーションが取れている。
- 所持リスト view、非所持リスト view を作れる状態。
- DL参照DBが作成済み。
- RGリンクなし、未登録、混入の扱いが決まっている。

ここまで揃って初めて、バックエンドAPI、フロントエンドUI、UX設計へ進む。

## 15. 小規模サイトの手動バッチ運用

FC2既存プロジェクトより更新数、所持数が小さいサイトでは、PM2の定期自動実行ではなく、人が必要な時にバッチをダブルクリックして実行する運用を基本にする。

この構造はPACO以外でも使う。サイト追加時は、先頭にサイト用の変数名を決める。

例:

```text
site_key = hogehogehoge
```

この `site_key` から、以下の3ディレクトリを作る。

```text
P:\uncen\hogehogehoge_new_master
P:\uncen\hogehogehoge_new_mp4
P:\uncen\hogehogehoge_trash
```

PACOでは以下を使う。

```text
P:\uncen\paco_new_master
P:\uncen\paco_new_mp4
P:\uncen\paco_trash
```

### 15.1 新規マスター追加バッチ

目的:

- 最新ページを少量確認し、既存マスターとの差分だけ登録する。
- 登録時にサムネイルも取得する。
- 小規模更新を人が任意タイミングで実行できるようにする。

PACOの対象ページ:

```text
https://www.caribbeancom.com/listpages/paco/all1.htm
```

配置場所:

```text
P:\uncen\paco_new_master
```

運用ルール:

- 1ページを読み、既存マスターとの差分を登録する。
- サムネイルも同時に取得する。
- サムネイル取得は連続アクセスにせず、数秒の間隔を空ける。
- バッチファイルをダブルクリックして実行できるようにする。

### 15.2 所持判定・登録バッチ

目的:

- 指定フォルダ配下の新規ファイルを人がまとめて投入する。
- マスター照合、リネーム、移動、所持DB登録までを手動バッチで行う。
- ブラウザ表示の所持状態まで更新できる状態にする。

PACOの投入フォルダ:

```text
P:\uncen\paco_new_mp4
```

対象:

- `P:\uncen\paco_new_mp4` 配下の全階層。
- 配下が深くてもすべて巡回する。
- このフォルダにはPACOだけを入れる前提。

正規所持として照合できた動画:

```text
P:\uncen\paco
```

へ移動する。

照合できないもの、不要なもの:

```text
P:\uncen\paco_trash
```

へ移動する。

運用ルール:

- 正規所持と判定できたPACO動画だけ、マスターに合わせてリネームする。
- 正規所持と判定できたPACO動画だけ、所持DBへ登録する。
- `trash` 行きのファイルはリネームしない。
- `trash` 行きのファイルは仕分けしない。
- `trash` 行きのファイルは元ファイル名、元拡張子のまま、すべて同じ階層へ移動する。
- 投入フォルダ内の階層フォルダは保持しない。ファイルだけを判定対象にする。
- マスターにない動画ファイルがあった場合はCSVに記録し、そのCSVを `trash` 側へ出力する。
- CSVは人が後で確認するためのもの。自動でマスター追加しない。

### 15.3 今後のサイト追加時の変数化

今後のサイト追加では、以下を変数として扱う。

```text
site_key
new_master_dir = P:\uncen\{site_key}_new_master
new_mp4_dir    = P:\uncen\{site_key}_new_mp4
trash_dir      = P:\uncen\{site_key}_trash
owned_dir      = P:\uncen\{site_key}
```

PACO例:

```text
site_key       = paco
new_master_dir = P:\uncen\paco_new_master
new_mp4_dir    = P:\uncen\paco_new_mp4
trash_dir      = P:\uncen\paco_trash
owned_dir      = P:\uncen\paco
```

次サイト以降は、ディレクトリ作成から実施する。
