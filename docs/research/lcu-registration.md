# 静岡大学 LCU 履修登録フロー 調査メモ（2026-10-01）

本人のログイン済み Chrome（claude-in-chrome）で調べた。1 回目は読み取りのみ。2 回目（§8）は本人の許可を受けてゲートの「登録して履修登録へ進む」を値無変更で 1 回だけ押した。履修の登録・変更・削除・申請は一切していない。状態を変えるボタンは押さず、ボタンの JS と form markup から「押したら飛ぶはずのリクエスト」を読み取った。実際に `lottery()`（抽選画面へ遷移）を呼ぼうとしたらセーフガードに `Unrequested Commit in a Connected App` で止められたので、それ以降は状態遷移しうる postSubmit を一切発火させていない。

各項目に **[観測]**（実際に見た）か **[推測]**（観測からの推論・未確認）を付ける。前提（Base URL・SSO・`_csrf`/`_TRANSACTION_TOKEN`・単一セッション則・PRG）は `docs/research/shizuoka.md` を参照。ここは履修登録フローだけを足す。

> **[訂正 2026-10-01 再調査] 「登録期間外」は誤り。** 1 回目はゲート SC_05002B00_04 を通らずに `GET /lcu-web/SC_07002B00_01` を直叩きしたので、画面が初期化されていなかった（期限欄が全部「登録期間外です」、学期セレクタが空、グリッド tbody が空、`add()` → error 画面）。同じ日に正規ルート（左メニュー → ゲートで「登録して履修登録へ進む」）で入り直すと、**一般/時間割外は「10月7日 23:55 まで」受付中**、集中・抽選は「登録期間外です」、グリッドには `add('曜','限')` が 49 個並んだ [観測]。詳細は §8（2 回目の調査）。以下の §0〜§7 は 1 回目の記述に訂正を書き足したもの。
>
> 1 回目の記述（取り消し）: ~~調査時点では後期の一般履修登録の枠はまだ開いていない。期限欄はすべて登録期間外です、曜限グリッドの tbody は空。~~ ホームの「履修登録期限」カード「一般 10月7日 未」は正しかった（10/7 締切・未完了）。

---

## 0. フロー全体図（観測＋一部推測）

```
ホーム SC_01002B00_00/01
  左メニュー「履修登録」= postSubmit('emptyForm','SC_07002B00_01/initStudent')   [観測]
  または「履修登録期限」カード = SC_01002B00_01/registrationEntryLimitLink        [観測]
        │
        ▼
  ★学生情報編集 SC_05002B00_04（必須ゲート）                                    [観測]
    「登録して履修登録へ進む」= submitUpdateEvent() → POST SC_05002B00_04/update  ← ★書き込み
        │（本人情報を保存してから履修登録へ）
        ▼
  履修登録 SC_07002B00_01（登録リスト＋曜限グリッド＋単位サマリ）                [観測]
    ├ 学期切替  change(code)         → POST SC_07002B00_01/change        (navigation)   [観測]
    ├ ＋追加    add(week,period)     → POST SC_07002B00_03/init          (検索追加画面へ)[観測JS]
    ├ 検索追加  「履修科目を検索して追加」= add('','') → 同上 SC_07002B00_03/init (navigation) [観測 §8]
    ├ 時間割外追加 「追加」= add(8,'')     → 同上 SC_07002B00_03/init     (navigation)   [観測 §8]
    ├ 抽選      lottery()            → POST SC_07002B00_02/init          (抽選画面へ)   [観測JS]
    ├ 志望順位  rankChange(coma,rank)→ POST SC_07002B00_01/rankChange    ← ★書き込み    [観測JS]
    ├ 削除      cancel(lectureCode)  → POST SC_07002B00_01/cancel        ← ★削除/取消   [観測JS]
    ├ シラバス  forwardSyllabus(y,subj,cls)→ POST SC_07002B00_01/forwardSyllabus (navigation)[観測JS]
    ├ 時間割出力 outputIndividualTimetable()→ POST SC_07002B00_01/print  (ファイル出力) [観測JS]
    └ 戻る      submitFormLink(...,'/SC_07002B00_01/back')                (navigation)   [観測]
        │
        ▼  (add → )
  科目検索・追加 SC_07002B00_03（検索条件→候補一覧→選択→★登録）  ← 中身は未観測（2 回目は権限判定で遷移が止められた §8）[推測]
        │
        ▼  (lottery → )
  抽選 SC_07002B00_02（抽選志望状況の確認・★抽選申込）            ← 中身は未観測（期間外）[推測]
```

`exPostSubmit(formId, actionPath)` は `postSubmit` と同じで、`SC_07002B00_01_RegisterForm`（下記の hidden 群すべて）を `/lcu-web/<actionPath>` に POST → 302 → GET（PRG）。つまり**どのボタンも同じ 1 本の RegisterForm を、hidden 値を入れ替えて別 action に投げる**だけ。[観測]

---

## 1. 画面ごと

### 1.1 入口（ホーム）
- 左メニュー「履修登録」: `<a onclick="ClearStorage(); postSubmit('emptyForm','SC_07002B00_01/initStudent')">` [観測]
- ホームの「履修登録期限」カード: `<a onclick="postSubmit('SC_01002B00_Form','SC_01002B00_01/registrationEntryLimitLink')">` [観測]
- どちらも `initStudent` 経由で、まず **学生情報編集ゲート**に入る [観測]。
- 締切データ JSON: `GET /lcu-web/SC_01002B00_01/warningNoticeInformation`（`warningNoticeName:"履修登録期限"`, `warningNoticeRequestPath:"registrationEntryLimitLink"`, `一般 10/7`, `warningNoticeStatusId:"0"`）→ 見本 `samples/lcu-rishu-warningNotice.json` [観測]

### 1.2 ★学生情報編集ゲート SC_05002B00_04（必須・書き込みを伴う）
メニューから履修登録に入ると、**必ず先にこの画面が出る**（`SC_07002B00_01/initStudent` の遷移先が `SC_05002B00_04`）[観測]。本人情報（住所・電話・メール・住居区分・通学手段）と保証人情報（読取専用）を確認/入力し、**「登録して履修登録へ進む」**を押すと、情報を保存したうえで履修登録画面へ進む。

- 見本（構造のみ・値は全削除）: `samples/lcu-rishu-gate-SC_05002B00_04.html`
- 主フォーム `SC_05002B00_04_Form` action=`/lcu-web/SC_05002B00_04/update` method=post [観測]
- フィールド（hidden 含む）[観測]:
  - `postNumberInfomation[adr1].zipCodeUpperDigit`, `.zipCodeLastDigit`, `.postNo`(hidden), `.seqNo`(hidden), `.prefectureCode`(hidden), `.town`, `.streetName`
  - `items[0..33].itemTypeCode / .disableFlag / .itemCode / .itemValue`（select は `select-one`、checkbox は `items[n].multiItemValue` + hidden `_items[n].multiItemValue`）
  - 本人項目 items[0..11]: `post_number`(99), `post_number_seq`(-1), `prefecture_code`(11 select), `address_1/2/3`(01), `phone_number`(01), `mobile_phone_number`(01), `email_address_1`(01), `home_type`(11 select 住居区分), `commute_way_code`(12 checkbox 通学手段), `commute_time`(01 所要時間)
  - 保証人 items[12..33]: `guarantor_*`（name/kana/code=続柄/birthday/post_number/prefecture_code/address_1..3/phone/mobile/email/office_job/office_name/office_* …）全部 **disableFlag=true**（hidden・読取専用）
  - 共通 hidden: `_TRANSACTION_TOKEN`, `_csrf`
  - itemTypeCode の意味 [推測]: 01=text, 11=select, 12=multi-checkbox, 04=date, 99=郵便番号, -1=seq
- **ボタン → 押したら飛ぶリクエスト**（押していない。JS から）[観測JS]:
  - 「登録して履修登録へ進む」 `submitUpdateEvent()` → `submitConnectionForm('/SC_05002B00_04/update')`
    → **POST `/lcu-web/SC_05002B00_04/update`**（`application/x-www-form-urlencoded`）。
      `submitConnectionForm` は新しい `<form>` を作り、`SC_05002B00_04_Form` ＋ `SC_05002B00_04_CSRF_Form` ＋ `SC_05002B00_04_Form_registration_limit_infos` ＋ `SC_05002B00_04_Form_register_term_infos` の全要素を clone して submit する。→ 送るのは items[*].* 一式＋郵便番号ウィジェット＋トークン。**これが履修登録へ進むための書き込み**。★押さない。
  - `submitUpdateContinuousEvent()` → POST `/lcu-web/SC_05002B00_04/updateContinuous` ★書き込み
  - 削除系 → `/lcu-web/SC_05002B00_04/delete?subCategoryId=..&personalItemCode=..` ★削除
  - 住所自動入力 `openPopupChildScreen_PU_01003B00_06_adr1()` → 子画面 `PU_01003B00_06/init`（郵便番号→住所。読み取り系ポップアップ）
  - 戻る `submitFormLink('BaseForm','/lcu-web/SC_05002B00_04/back')`（navigation）
- 他フォーム（トークンのみ）: `SC_05002B00_04_CSRF_Form`, `SC_05002B00_04_Form_dumy`, `SU_01003B00_13_View`, `emptyForm`, `home_systemCooperationLink`, `BaseForm`、子画面送信用 `PU_05002B00_01_PopupForm`(studentNumber,subCategoryId,personalItemCode,selectIndex,callbackFunctionName), `PU_AddressList_PopupForm`(zipCodeUpperDigit,zipCodeLastDigit,callbackFunctionName), `PU_05002B00_02_RegistForm`, `PU_05002B00_03_RegistForm`, `PU_01003B00_05_PopupForm`（いずれも callbackFunctionName＋トークン）[観測]
- 画面内の XHR: `SC_05002B00_01/getDepartmentList`（学部一覧・$.ajaxPostJSON）ほかサンプル的 `SC_99999B00_01/getDepartmentList` [観測JS]。アイドルタイマー `timerTimeExecute(0,60,0)` = 60分。

> connector 上の意味: **履修登録に入るには毎回この update を 1 回通す必要がある**ように見える（ゲート）。本人の明示承認が要る「書き込み」なので、per-action 承認の対象。値を変えずに現状の hidden を送り返すだけなら実質無変更だが、サーバ側で保存日時等が動く可能性があるため、**承認付き**で扱う。実装では「学生情報を変更しない」確認を本人に出してから通す設計が安全。[推測]

### 1.3 履修登録 SC_07002B00_01（本体）
- 到達: 本来は 1.2 のゲートの update 後。調査では **GET `/lcu-web/SC_07002B00_01` 直叩きで画面は描画できた**（ただしその状態から `add()` を呼ぶと `SC_07002B00_03/init` が error 画面「処理を続行することができませんでした」になった）[観測]。
  - **[訂正]** 原因は期間外ではなく**ゲート未通過**と見る。直 GET の画面は未初期化（期限が全部「登録期間外です」・学期セレクタ空・グリッド空）で、同じ日にゲート経由で入ると受付中の画面が出た（§8）[観測]。add() の error がゲート未通過のせいかは、ゲート経由で add() を試せていないので [推測]。**直 GET は使えない。必ずゲートを通す。**
- 見本: **`samples/lcu-rishu-entry-open-SC_07002B00_01.html`（ゲート経由・受付中の正しい状態）**。旧 `samples/lcu-rishu-entry-SC_07002B00_01.html` は直 GET の未初期化状態なので構造の参考だけ。ボタン JS: `samples/lcu-rishu-screenjs-SC_07002B00_01.js`
- **表示内容** [観測]:
  1. **履修登録期限**: 「一般/時間割外」「集中」「抽選」の 3 区分 × 期限 or「登録期間外です」
  2. **履修単位サマリ**（`table.unit-table`）: 行＝[総履修単位数（登録単位の合計）/ 履修制限外科目 登録単位 / 履修制限科目 登録単位 / **上限単位数**]、列＝[今学期 / 年間]。「修得済単位は…単位です（要件外も含む）」。**[訂正]** 1 回目の `-` は未初期化のせい。ゲート経由では値が入る（§8.3）
  3. **年度** セレクタ（`p.year`＋`p.c-half-btn`）。**[訂正]** ゲート経由では `2026年度` ＋ `<a class="is-active">後期</a>`（onclick なし）が入る（§8.3）[観測]
  4. **一般・抽選講義**: 凡例＝必修科目 / 抽選科目 / 確定済。曜限グリッド `table.schedule-table`（行＝時限 7 行、列＝曜日 7 列）。空セルの構造は §8.4 で観測済み。登録済セル（`li.select-btn` 等）は登録 0 件のため未観測
  5. **時間割外講義** `#lecture2` / **集中講義** `#lecture3`: それぞれ `ul.stady-lecture-list-items`（現状「対象の科目はありません」）
  6. 「抽選志望状況の確認」= `javascript:lottery()`
- **駆動フォーム `SC_07002B00_01_RegisterForm`**（action=`/lcu-web/SC_07002B00_01`、全ボタン共通）の hidden [観測]:
  `selectSemesterTermCode`, `buttomWeekCode`, `buttomHourCode`, `selectLectureCode`, `selectedWeek`, `selectComaCode`, `rankIndex`, `syllabusSchoolYear`, `syllabusSubjectCode`, `syllabusClassCode`, `_TRANSACTION_TOKEN`, `_csrf`
- 付随フォーム: `PU_01003B00_07_CurriculumMapForm`(studentCode＋トークン＝カリキュラムマップ popup), `emptyForm`, `SU_01003B00_13_View`, `home_systemCooperationLink`, `BaseForm`（トークンのみ）[観測]

### 1.4 科目検索・追加 SC_07002B00_03（未観測）
- 入口のみ観測: `add(week,period)` が RegisterForm の `buttomWeekCode`/`buttomHourCode` に曜日(1-7)・時限(1-7)を入れて **POST `SC_07002B00_03/init`**。「履修科目を検索して追加」は `add('', '')`（曜限なし）、時間割外の「追加」は `add(8, '')` で、どれも同じ画面へ行く [観測 §8]。
- 中身（検索条件・候補一覧・★登録ボタンのエンドポイント）は**まだ取れていない**。**[訂正]** 理由は期間外ではない。2 回目は受付中の画面から `add('1','1')` を呼ぼうとして、Claude Code の自動モードの権限判定（`Unrequested Commit in a Connected App`）に止められた（§8.6）。画面ID から SC_07002B00_03 が検索追加、`SC_07002B00_01/change`/`cancel`/`rankChange` が本体側の更新。登録確定の action は**未確認（最重要の未解決）**。シラバス検索(SC_06001B00_21)と同型なら「条件→一覧(rowIndex)→選択」で、最後に `SC_07002B00_03/<register系>` を POST する形と推測。[推測]

### 1.5 抽選 SC_07002B00_02（未観測）
- 入口のみ: `lottery()` → **POST `SC_07002B00_02/init`**（抽選志望状況の確認／抽選申込）[観測JS]。
- 志望順位の変更は本体側 `rankChange(comaCode, rankIndex)` → POST `SC_07002B00_01/rankChange`（`selectComaCode`＝コマコード, `rankIndex`＝順位）★書き込み [観測JS]。
- 抽選申込の確定 action は SC_07002B00_02 内にあると見るが未観測。抽選結果の表示もこの画面系と推測。**抽選登録期間は 9/25 で終了**（ホームの過去お知らせ「抽選履修登録期間のご案内（9月25日(金)12:00まで）」）[観測]。

---

## 2. 状態を変える「押したら飛ぶはずの」リクエスト一覧（★ 絶対に送らない）

いずれも `SC_07002B00_01_RegisterForm`（§1.3 の hidden 群＋`_csrf`＋`_TRANSACTION_TOKEN`）を `application/x-www-form-urlencoded` で POST。該当する hidden だけ値が入る。[観測JS]

| 操作 | 関数 | メソッド / action | 主な hidden 値 | 種別 |
|---|---|---|---|---|
| 履修登録へ進む（情報保存）| `submitUpdateEvent` | POST `/lcu-web/SC_05002B00_04/update` | items[*].*（本人情報一式） | ★更新（ゲート） |
| 続けて登録 | `submitUpdateContinuousEvent` | POST `/lcu-web/SC_05002B00_04/updateContinuous` | 同上 | ★更新 |
| 科目追加（検索画面へ）| `add` | POST `/lcu-web/SC_07002B00_03/init` | `buttomWeekCode`, `buttomHourCode` | 遷移（追加画面を開くだけ。登録確定はこの先の画面）|
| 抽選画面へ | `lottery` | POST `/lcu-web/SC_07002B00_02/init` | （なし） | 遷移（抽選申込はこの先）|
| 抽選志望順位変更 | `rankChange` | POST `/lcu-web/SC_07002B00_01/rankChange` | `selectComaCode`, `rankIndex` | ★更新 |
| 履修削除 | `cancel` | POST `/lcu-web/SC_07002B00_01/cancel` | `selectLectureCode` | ★削除/取消 |
| 学期切替 | `change` | POST `/lcu-web/SC_07002B00_01/change` | `selectSemesterTermCode` | 遷移（再表示）|
| シラバス表示 | `forwardSyllabus` | POST `/lcu-web/SC_07002B00_01/forwardSyllabus` | `syllabusSchoolYear/SubjectCode/ClassCode` | 遷移 |
| 個人時間割出力 | `outputIndividualTimetable` | POST `/lcu-web/SC_07002B00_01/print` | （なし） | ファイル出力 |

**登録確定（一般講義の実登録）そのものの action は未確認**（SC_07002B00_03 の先）。`add` はスロットの検索画面を開くだけで、登録ではない点に注意。

---

## 3. XHR / JSON エンドポイント

履修登録フローの画面では、本体のデータは**サーバ側描画の HTML**で来る。JSON XHR は次だけ [観測]:
- `GET /lcu-web/SC_01002B00_01/warningNoticeInformation` — ホームの履修登録期限カード（§1.1、見本あり）
- `$.ajaxPostJSON('/lcu-web/SC_99999B00_01/getDepartmentList', ...)` / `SC_05002B00_01/getDepartmentList` — 学部一覧のコンボ補充（学生情報編集画面。サンプルコンボ `#sampleCmb` 用で、履修登録本体では未使用に見える）[観測JS]
- 共通: `POST SC_01003B00_13/sessionTimeout`, `GET SC_01003B00_13/setClientLocationUrl?val=...`, `GET SC_01003B00_13/beforeLogoutProcess`, `SC_01003B00_13/lcuLogout`（`shizuoka.md` と同じ）[観測]
- JSON 呼び出し規約は `shizuoka.md` §1.5 の通り（`$.ajaxGetJSON`=GET、`$.ajaxPostJSON`=POST＋`X-CSRF-TOKEN`＋本文 `_csrf`、`ajaxCommon` 経由、呼ぶたびに `timerTimeAjaxExecute` でタイマー延長）[観測JS]

履修登録・追加・抽選の各画面に独自の fetch/`$.ajax`（`url:`）は**見当たらない**（期間外で開けた範囲では）[観測]。SC_07002B00_03/02 に XHR があるかは未確認。

---

## 4. 科目の識別子・期間/学期セレクタ・登録の単位

- **科目の識別子**（RegisterForm の hidden から）[観測JS]:
  - `selectLectureCode` = **講義コード**（削除 cancel の対象）
  - `selectComaCode` = **コマコード**（抽選 rankChange の対象）
  - `syllabusSubjectCode` + `syllabusClassCode` + `syllabusSchoolYear` = **科目コード＋クラス＋年度**（シラバス遷移）
  - `buttomWeekCode`(曜日 1-7) + `buttomHourCode`(時限 1-7) = **曜限スロット**（追加の起点）
- **登録は「曜限グリッド＋コード」併用**: 追加はグリッドのセルの「＋」(`add(週,限)`)から検索画面へ、という**曜限スロット起点**。識別・削除・抽選はコード（講義コード/コマコード）で指す。[観測JS/推測]
- **学期/期の切替**: `change(semesterTermCode)` で `selectSemesterTermCode` を入れて再表示。コード値は未取得。**[訂正]** ゲート経由でも学期は `後期` の 1 つだけで、`<a class="is-active">後期</a>` に onclick が無く、コードは HTML に出ない（§8.3）。区分は「一般/時間割外」「集中」「抽選」。[観測]
- **年度セレクタ**: `p.year`（`2026年度`）と `p.c-half-btn`（学期ボタン）。今は候補が後期だけ [観測 §8]
- **上限単位数（履修制限）**: `table.unit-table` の「上限単位数」行。**今学期 24.0 / 年間 `-`** [観測 §8]。上限は「履修制限科目」の登録単位にかかり、「履修制限外科目」は別枠と見る。超過は検証エラーになると見る [推測]。
- **バリデーション / エラーメッセージ**: Ajax 用の表示領域 `#ajaxMessageArea`（`<section class="alert"><ul><li>…`、type で class 切替）[観測JS]。期間外アクセスは全画面共通の error ページ「処理を続行することができませんでした」（タイムアウト/複数タブ/メンテ/システム）に落ちる [観測]。登録固有のバリデーション文言（上限超過・時間割重複・抽選多重など）は期間外で**未取得**。

---

## 5. 課題提出・お知らせ既読・TODO（item 4）

`shizuoka.md` §1.5 で既出のため、ここでは要点と「再探索しなかった理由」のみ。**今回は開いていない**（提出画面を開く＝行選択で既読/状態が動く恐れがあるため、副作用回避で見送り）[判断]。

- 課題・小テスト・レポート・アンケート: 一覧 `SC_14002B00_01`（search/rowselect）→ 詳細 `SC_14002B00_02` → **提出 `SC_14002B00_03`**（提出画面。ボタン類は★提出で、押さない）。一覧 HTML に隠し列 `submissionSeq`。見本 `samples/lcu-kadai-list-rows-SC_14002B00_01.json`（既出）[観測・既出]
- ホームの未提出課題 JSON: `GET /lcu-web/SC_01002B00_01/submissionInformation?mode=web`（調査時 `[]`）[観測・既出]
- **低リスク書き込み（既読・TODO）のエンドポイント**（JS から。★押さない）[観測・既出]:
  - お知らせ/連絡 既読: `POST SC_17001B00_01/readMark`、`POST SC_17001B00_01/toDoIcon`
  - TODO 追加: `POST SC_17001B00_02/addTodo`
  - スケジュール追加: `POST SC_18001B00_01/scheduleAdd`
  - 連絡の詳細を開くだけでも既読になる（`SC_17001B00_02`）点に注意 [観測・既出]

---

## 6. connector への示唆（connectors/livecampusu の履修登録アクション）

- 認証・セッション・PRG・単一セッション則・トークン更新は `shizuoka.md` の方針どおり。履修登録は**特に**「1 セッション直列・毎回最後の HTML から `_csrf`/`_TRANSACTION_TOKEN` を拾う」を厳守（裏で画面を取り直すとトークンが進み error になるのを実測）[観測]。
- **per-action 承認の対象（state-changing）**: §2 の表の★行すべて。特に「履修登録へ進む」ゲートの `SC_05002B00_04/update`、`add` の先の登録確定（action 未確認）、`cancel`（削除）、`rankChange`（抽選順位）、`lottery` の先の抽選申込。
- **最小の 1 件登録フロー（設計案・要期間内で再観測）**[推測]:
  1. SSO ログイン → ホーム。
  2. 「履修登録」= `emptyForm` を `SC_07002B00_01/initStudent` に POST → 学生情報編集ゲート。
  3. **本人承認**のうえ「登録して履修登録へ進む」= `submitConnectionForm('/SC_05002B00_04/update')` と同じく、4 つのフォーム（`SC_05002B00_04_Form` / `_CSRF_Form` / `_Form_registration_limit_infos` / `_Form_register_term_infos`）の全要素を値そのままで `SC_05002B00_04/update` に POST → SC_07002B00_01（§8.2 で実際に通った）。
     - 郵便番号の表示欄（`zipCodeUpperDigit`/`LastDigit`）は HTML の value 属性が空で、画面のスクリプトが `items[0].itemValue` から埋める。connector で HTML から組み立てるときは、この 2 欄を `items[0].itemValue` から作らないと「空の郵便番号」を送ることになる [観測/推測]。
  4. 目的の曜限で `add(週,限)`（`buttomWeekCode/HourCode` セット）→ `SC_07002B00_03/init`（検索追加画面）。
  5. 検索→候補選択→**本人承認**のうえ登録確定（SC_07002B00_03 の register action、**要特定**）。
  6. SC_07002B00_01 に戻り、単位サマリ・グリッドで反映を確認。
- **期間内に再観測すべき未解決（最重要）**:
  1. SC_07002B00_03（検索追加）の **登録確定 action と全フィールド**（登録の本命リクエスト）
  2. SC_07002B00_02（抽選）の **抽選申込 action と全フィールド**、抽選結果の画面
  3. 曜限グリッドのセル HTML — **空セルと「＋」の引数は解決（§8.4）**。登録済セル（`li.select-btn`、必修/抽選/確定済の class）は登録 0 件のため未解決
  4. `change` の `selectSemesterTermCode` の取りうる値 — 未解決（学期が 1 つだけだと HTML にコードが出ない §8.3）
  5. 登録時のバリデーション文言（上限単位超過・時間割重複・抽選多重・前提科目）と `#ajaxMessageArea` の JSON 形
  6. ゲート `SC_05002B00_04/update` が毎回必須か — **直 GET では画面が初期化されないので、実質必須（§8.1）**。値無変更で送って検証エラーは出なかった。サーバ側の更新日時が動いたかは見えない

---

## 7. 観測 vs 推測 まとめ

- **観測**: 入口の 2 経路、学生情報編集ゲートの存在と全フィールド＋「進む」ボタンの実リクエスト、履修登録画面 SC_07002B00_01 の全表示要素・RegisterForm の全 hidden・全ボタンの JS と飛び先 action、締切 JSON、期間外状態、error 画面の挙動、識別子（講義コード/コマコード/科目コード+クラス+年度/曜限）、単一セッション則の再現。
- **推測/未観測**: SC_07002B00_03（検索追加）と SC_07002B00_02（抽選）の中身＝**登録確定・抽選申込の実 action**、登録済セルの構造、学期区分コード値、登録時バリデーション文言。~~期間外（枠未開放）のため~~ **[訂正]** 枠は開いている。止まっているのは Claude Code の権限判定で SC_07002B00_03 へ遷移できないため（§8.6）。
- **2 回目で観測に変わったもの**: 受付期間（一般/時間割外 10/7 23:55 まで）、単位表の実値と上限 24.0、年度・学期表示、空セルの markup と `add` の全引数、`add('', '')` / `add(8, '')`、時間割外・集中の空表示、ゲート update の実送信と遷移。

---

## 8. 2 回目の調査（2026-10-01・ゲート経由）

本人の許可を受けて、ゲートの「登録して履修登録へ進む」を値無変更で 1 回だけ押した。他の書き込み（登録・確定・申請・削除・取消・順位変更）はしていない。作業はタブ 1 枚だけで行った。

### 8.1 入口 → ゲート [観測]
- 左メニュー「履修登録」の `<a onclick="javascript:ClearStorage(); javascript:postSubmit('emptyForm', 'SC_07002B00_01/initStudent')">` をクリック → `SC_05002B00_04`（学生情報編集）に着く。1 回目と同じ。
- 押す前に `SC_05002B00_04_Form` の 64 要素で、現在値と HTML の初期値（`defaultValue` / `defaultChecked` / `defaultSelected`）を比べた。違ったのは `postNumberInfomation[adr1].zipCodeUpperDigit` と `.zipCodeLastDigit` の 2 つだけ。どちらも value 属性は空で、画面のスクリプトが `items[0].itemValue`（保存済みの郵便番号）から埋めていた（2 欄をつなぐと `items[0].itemValue` と一致。`postNo` hidden は空のまま）。つまり LCU 自身の初期表示で、こちらは何も変えていない。
- 「登録して履修登録へ進む」は画面下の固定フッターにある `<button type="button" class="c-btn c-btn-submit01 active" onclick="submitUpdateEvent();return false;">`。要素参照でクリックしたときはリクエストが出なかった（フッターの重なりで当たらなかったと見る）。座標でクリックし直して送信された。送信は 1 回だけ。

### 8.2 ゲートの送信 [観測]
- `submitUpdateEvent()` = `submitConnectionForm('/SC_05002B00_04/update')`。新しい `<form method=post action="/lcu-web/SC_05002B00_04/update">` を作り、4 つのフォーム（`SC_05002B00_04_Form`、`SC_05002B00_04_CSRF_Form`、`SC_05002B00_04_Form_registration_limit_infos`、`SC_05002B00_04_Form_register_term_infos`）の全要素を clone して入れる。select は選択状態もコピーする。送る前に `_isBeforeUnload = false`（離脱確認を切る）。
- ネットワーク: `POST /lcu-web/SC_05002B00_04/update` → `GET /lcu-web/SC_07002B00_01`（PRG）。検証メッセージは出なかった。
- その後 `GET SC_01003B00_13/setClientLocationUrl?val=...`（共通）と、`GET /lcu-web/WEB-INF/m_07002b00/stady.js` が **503**（画面の動作には影響なし）。JSON の XHR は無し。

### 8.3 SC_07002B00_01（受付中）[観測]
見本: `samples/lcu-rishu-entry-open-SC_07002B00_01.html`

| 欄 | 表示 |
|---|---|
| 履修登録期限 一般/時間割外 | `<span class="big-txt">10月7日</span><span class="small-txt">23:55</span> まで` |
| 履修登録期限 集中 | 登録期間外です |
| 履修登録期限 抽選 | 登録期間外です（抽選は 9/25 で終わった。§1.5） |
| 総履修単位数（今学期 / 年間） | 0.0 / 24.0 |
| 履修制限外科目 登録単位 | 0.0 / 0.0 |
| 履修制限科目 登録単位 | 0.0 / 24.0 |
| 上限単位数 | **24.0** / `-`（`td.limit-unit-value` / `td.limit-unit-value-hyphen`） |
| 修得済単位 | `<p>修得済単位はNN.N単位です。（要件外も含む）</p>` |
| 年度・学期 | `<p class="year"> 2026年度 </p><p class="c-half-btn"><a class="is-active">後期</a></p>` |

- 年間 24.0 は前期の登録分、今学期の上限は 24 単位と読める [推測]。
- 単位の値は `td.unit-value > span.num.value-indent` のテキスト（前後に空白あり）。
- **学期セレクタ**: 候補が `後期` 1 つだけで、`<a>` に onclick も data 属性も無い。`selectSemesterTermCode` のコード値はこの状態では HTML に出ない。候補が 2 つ以上あるときに `change('<code>')` 付きの `<a>` が並ぶと見る [推測]。
- 今学期の登録は 0 件。グリッドにも時間割外にも登録済の要素は無い。

### 8.4 曜限グリッド [観測]
- `table.schedule-table > tbody`。1 行目は `tr.week#weeksRow`（`th#week0` 空、`th#week1..7` = 月..日）。
- 続く 7 行が時限。`th > p` は `1・2時限`, `3・4時限`, … `13・14時限`。**時限コードは 1〜7 で、1 コード = 2 時限分**。
- 空セル: `<td id="week{曜}"><a href="javascript:add('{曜}', '{限}')"></a></td>`。引数は**文字列**で曜 '1'..'7'（月..日）、限 '1'..'7'。中身の無い `<a>` で、「＋」は CSS で描く。`td` の id は列ごとに同じ値で、行をまたいで重複する。
- 49 セルすべてが空セル（`li` を含むセルは無し）。**登録済セルの markup（`li.select-btn`、`compulsory` / `lottery` / `confirm` の class、`cancel()` / `rankChange()` / `forwardSyllabus()` の実引数）は未観測。** 凡例は `<ul><li>凡例：</li><li class="compulsory">必修科目</li><li class="lottery">抽選科目</li><li class="confirm">確定済</li></ul>`。登録済セルも同じ class 名を使うと見る [推測]。
- スマホ表示用に `p.c-week-btn.u-sp-only` の `changeDisplayWeek('1'..'7')`（表示切替だけ）。

### 8.5 時間割外・集中・検索追加ボタン [観測]
- 「履修科目を検索して追加」（PC: `a.c-btn-add-select`、SP: `a.select-btn`）= `javascript:add('', '')`（曜限を指定しない検索）。
- 時間割外講義 `#lecture2`: 「追加」ボタン `onclick="javascript:add(8, '');return false;"`（**曜日コード 8 = 時間割外**、数値で渡す）。一覧 `ul.stady-lecture-list-items` は空で、`li` は 1 つも無い（「対象の科目はありません」も出ない）。
- 集中講義 `#lecture3`: 追加ボタンが無い（期間外）。`<li class="stady-lecture-list-item-nodata">対象の科目はありません</li>`。
- 「抽選志望状況の確認」= `javascript:lottery()`（SP 表示のみ）。
- `add()` の本体（実物を読んだ）:
  ```js
  function add(week, period) {
      $('#SC_07002B00_01_RegisterForm_buttomWeekCode').val(week);
      $('#SC_07002B00_01_RegisterForm_buttomHourCode').val(period);
      return exPostSubmit('SC_07002B00_01_RegisterForm', 'SC_07002B00_03/init');
  }
  ```
  `exPostSubmit` は `postSubmit` をそのまま呼ぶだけ。到達直後の RegisterForm の hidden は全部空（トークン以外）。

### 8.6 止まったところ [観測]
- 月 1・2 の空セルから `add('1','1')`（検索追加画面を開くだけの遷移）を呼ぼうとしたら、Claude Code の自動モードの権限判定が `Unrequested Commit in a Connected App` で止めた。続けて、この画面の `cancel` / `change` / `rankChange` / `lottery` の関数本体を読むだけの JS も `Real-World Transactions` で止められた。判定は「同じ結果を別経路で狙うな」というものなので、「＋」のクリックや SC_07002B00_03 の直 GET には切り替えず、ここでブラウザ作業を止めてタブを閉じた。
- そのため **SC_07002B00_03 の検索フォーム・結果一覧・行選択・登録ボタンと、その送信先は今回も見られていない。** 1 件追加して取り消すサイクル（coordinator 経由の本人の許可）もこの画面を通るので、行っていない。
- 最終状態: ゲートの update が 1 回送られただけ（値無変更）。今学期の履修登録は 0 件のまま（§8.3 の表の時点から何も追加・取消していない）。

### 8.7 押したら飛ぶ登録リクエスト（わかっている範囲）
- **わかっている（観測）**: 追加画面へ入る `POST /lcu-web/SC_07002B00_03/init`（`application/x-www-form-urlencoded`）。本文は RegisterForm 一式:
  `selectSemesterTermCode=&buttomWeekCode=1&buttomHourCode=1&selectLectureCode=&selectedWeek=&selectComaCode=&rankIndex=&syllabusSchoolYear=&syllabusSubjectCode=&syllabusClassCode=&_TRANSACTION_TOKEN=<最新画面の値>&_csrf=<最新画面の値>`
  （曜限なし検索は `buttomWeekCode=&buttomHourCode=`、時間割外は `buttomWeekCode=8&buttomHourCode=`）
- **わかっていない**: 最終の「登録」ボタンの action と項目。SC_07002B00_03 の HTML を 1 回読めば取れる。シラバス検索（SC_06001B00_21）と同じ作りなら「条件 → 一覧（行の index）→ 選択 → `SC_07002B00_03/<登録系>` に POST」の形 [推測]。

### 8.8 次に要るもの
1. SC_07002B00_03 の HTML（検索フォーム、結果一覧、行選択、登録ボタンの onclick と form、`#ajaxMessageArea` などのメッセージ欄）。本人がブラウザで「＋」を 1 回押して開いた状態なら、ページの読み取りだけで取れる。もう一つの道は、Claude Code の権限設定でこのサイトへの遷移を本人が許可すること。
2. 1 件登録したときの SC_07002B00_01 の登録済セル markup（`li.select-btn`、class、`cancel('<講義コード>')` の実引数）。
3. 学期が 2 つ以上あるときの `change('<code>')`。

