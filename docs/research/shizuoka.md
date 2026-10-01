# 静岡大学 調査メモ（2026-10-01）

本人の Chrome（ログイン済み）と、認証の要らない公開ページへの curl で調べた。読み取りだけで、登録・送信・設定変更はしていない。

各項目に **[観測]**（実際に見た）か **[推測]**（観測からの推論・未確認）を付ける。

---

## 0. まとめ

| 機能 | どこにあるか | 認証 | connector 方針 |
|---|---|---|---|
| 時間割・掲示・授業連絡・課題・小テスト・成績・試験（本人分） | LiveCampusU `https://gakujo.shizuoka.ac.jp/lcu-web/` [観測] | Shibboleth SSO（idp.shizuoka.ac.jp）→ 上流で M365 認証 [観測/推測] | 認証はブラウザ。データは JSON の XHR が 5 本あるのでそれを優先し、残りは HTML のフォーム遷移（§1.7 API surface） |
| シラバス | 同じ LCU の公開画面 `SC_06001B00_21`/`_22` [観測] | 不要 [観測] | Native HTTP（HTML 解析） |
| 休講（全学・公開） | LCU 公開画面 `SC_90002szu_01` [観測] | 不要 [観測] | Native HTTP（HTML 解析） |
| 学部の時間割表・期末試験時間割・行事予定 | 学生教務ポータル（WordPress）の PDF [観測] | 不要 | WP REST＋PDF 取り込み |
| 全学のお知らせ | 学生教務ポータル `wp-json/wp/v2/posts` [観測] | 不要 | Native HTTP（JSON） |
| Teams / Outlook / OneDrive / Forms | M365 テナント `shizuoka.ac.jp`（初期ドメイン `scii.onmicrosoft.com`）[観測] | Entra ID（Managed）＋MFA [観測] | Graph（自前アプリ登録は可、同意ポリシーは未確認） |
| Google Classroom | 大学が公式に案内 [観測] | 静大専用 Google アカウント [観測（案内文）] | 未着手 |
| EdStem / Moodle | 大学の案内に出てこない。Moodle らしいホストは DNS に無い [観測] | — | 対象外（授業単位で使われる可能性はある） |

**本人に頼むこと（needs user）**
1. **LCU の属性送信同意**: 初回の調査では、IdP の「Information Release／送信属性の選択」画面がログインのたびに出た（§1.2）。その後、本人が「同意」を押してくれたので、ログイン後の画面を調べた（§1.5, §1.7）。こちらから「同意」は一度も押していない。2 回目のログインでは同意画面が出なかった（§1.8）。
2. **Graph の同意ポリシー**: Graph Explorer のサインインで、こちらのタブ外にポップアップが開いた。中身は見ていない（同意画面だったかどうかも分からない）。その後、ポップアップの代わりに authorize URL を自分のタブで直接開こうとしたが、自動判定で止められた。なので「ユーザー同意が許可されているか」は**未確認**。本人が Graph Explorer か自前アプリでサインインして、出た画面（「管理者の承認が必要」か、権限一覧の同意画面か）を確かめる必要がある。

---

## 1. 学務情報システム（LiveCampusU / LCU-Web）

### 1.1 製品とURL
- 製品: **LiveCampusU** [観測]（ログイン画面のロゴ、パス `/lcu-web/`）
- Base URL: `https://gakujo.shizuoka.ac.jp/lcu-web/` [観測]（`https://gakujo.shizuoka.ac.jp/` は `/lcu-web/` にリダイレクト）
- サーバ IP: 133.110.250.206 [観測]
- 画面は**サーバ側描画の HTML**。画面IDの形は `SC_<8文字>_<2桁>`（例 `SC_01001B00_01`, `SC_06001B00_21`）。静大独自の画面は `szu` が入る（`SC_90002szu_01`）[観測]
- 画面遷移はすべて `<form>` の POST。`submitFormButton($btn, '/lcu-web/<画面ID>/<action>')` が `formId` 属性のフォームの action を書き換えて submit する。POST のあとは **302 → GET /lcu-web/<画面ID>**（PRG）[観測]
- 一覧から詳細へは `TableForm` に `rowIndex` を入れて `/<画面ID>/linkselect` に POST する。**詳細画面は固定 URL を持たず、セッションの直前の検索結果に依存する** [観測]
- ログイン前の画面には JSON API が見当たらない。ログイン画面とシラバス画面の XHR は `GET /lcu-web/csrf`（CSRF トークンを text で返す）と `/<画面ID>/changeTitle`（シラバスのカテゴリ選択肢の取得）だけ [観測]。ログイン後の画面には JSON の XHR がある（§1.7）
- CSP: `connect-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'` [観測]
- 応答ヘッダに `X-Track: <32桁hex>`（リクエストごとの追跡 ID らしい）[観測]

### 1.2 ログインの流れ
1. `GET /lcu-web/` → ログイン画面（フォーム `SC_01001B00_01_Login_Form`、`POST /lcu-web/`）[観測]
   - フィールド: `account`, `password`（**非表示**）, `locale`, `_csrf` [観測]
   - 見えるボタンは `#btnSsoStart` だけ → `POST /lcu-web/shibbolethLogin/sso?lang=ja` [観測]
   - 隠しボタン `#btnLocale` → `/lcu-web/changeLocale` [観測]
   - ローカルログイン `/lcu-web/webLogin` と `/lcu-web/<prefix>/webLogin` のコードは残っているが、入力欄が隠れている。学生は使えない前提で扱う [観測/推測]
2. SAML 2.0 で `https://idp.shizuoka.ac.jp/idp/profile/SAML2/Redirect/SSO` に飛ぶ（Shibboleth IdP）[観測]
3. IdP は上流の IdP にさらに認証を回している。2 回目の試行で `https://idp.shizuoka.ac.jp/idp/profile/Authn/SAML2/POST/SSO` を通った [観測]。これは Shibboleth IdP の SAML プロキシ認証の受け口。大学の FAQ に「学務情報システムには Microsoft365 の ID とパスワードでログイン」「2要素認証が適用される」とあるので [観測（案内文）]、**上流は Entra ID** と見ている [推測]
4. 本人の Chrome にはすでに Entra のセッションがあったので、パスワードも MFA も聞かれずに IdP まで通った [観測]
5. **IdP の属性送信同意画面**（タイトル「送信属性の選択」、見出し「Information Release」、`?execution=e1s3`）[観測]
   - サービス表示: `gakujo.shizuoka.ac.jp / YourOrganizationDisplayName`（SP メタデータの表示名がひな形のまま）[観測]
   - 文面: 「本学が管理しているあなたに関する属性情報が、同じく本学が運営する当サービスへ送信されます。ご了解の上、いずれかの「同意方法」を選択してください。」
   - 選択肢: 「次回ログイン時に再度チェックします。」／「このサービスに送信する情報が変わった場合は、再度チェックします。」（既定）／「今後はチェックしません。」
   - ボタン: 「同意」「拒否」
   - **こちらでは押していない**。2 回試して 2 回とも出たので、このブラウザではまだ同意していない [観測]
6. 古い SAML フローのまま戻ると「ウェブログインサービス - 過去のリクエスト」エラーになる（IdP の stale request）[観測]

**connector への影響**: 本人が一度「今後はチェックしません」か「変わった場合は再度チェック」で同意すれば、以降は無操作で通るはず [推測]。最初の 1 回は人間がやるしかない。

### 1.3 Cookie（名前だけ）
| ホスト | 名前 | 属性 | 出所 |
|---|---|---|---|
| gakujo.shizuoka.ac.jp | `JSESSIONID` | `path=/lcu-web; HttpOnly; SameSite=Lax; secure`、期限なし（セッション Cookie） | [観測] 未認証で GET したときの Set-Cookie |
| idp.shizuoka.ac.jp | 未観測（Shibboleth IdP v4/v5 なら `shib_idp_session` 系）| — | [推測] |
| login.microsoftonline.com | `ESTSAUTH*` 等 | — | [推測] |

- `_csrf` は**フォームの hidden 項目**（Spring Security の既定名）。ヘッダ名は使っていない。トークンは UUID 形式・36 文字 [観測]。ページごとに新しい値を拾って次の POST に載せる
- Java / Spring MVC＋Spring Security 構成と見ている（`JSESSIONID`、`_csrf`、`;jsessionid=` の URL 書き換え）[推測]

### 1.4 セッションの寿命
- ログイン後のアイドル時間は 60 分（§1.5）
- エラー画面「処理を続行することができませんでした」の理由に「タイムアウトが発生した後に操作を行った」「**複数タブを開いて操作を行った**」が挙がっている [観測]。**1 セッションで並列に操作しないこと**
- FAQ: 「夜間に定期的な停止があります」[観測（案内文）]。時刻は書かれていない。同期は夜間を外す
- FAQ: 「CSRFトークンの検証に失敗しました」でログインできない場合の対処が載っている [観測（案内文）]。CSRF 不一致はよくある失敗として扱う

### 1.5 ログイン後の画面（本人の同意のあと 2026-10-01 に観測）
入口は `POST /lcu-web/<画面ID>/init`（左メニューは `postSubmit('emptyForm', '<画面ID>/init')`）。ログイン直後に着く画面は `SC_01002B00_00`、ホームは `SC_01002B00_01` [観測]。

| 機能 | 画面ID / エンドポイント | 形 | 見本 |
|---|---|---|---|
| ホーム | `SC_01002B00_01`（JSON の XHR 4 本、§1.7） | HTML＋JSON | `lcu-home-importantNotice.json`, `lcu-home-misc-xhr.json` |
| 連絡一覧（授業連絡・学内連絡・**休講/補講/試験/講義室変更**） | `SC_17001B00_01`（search / rowSelect）→ 詳細 `SC_17001B00_02` | HTML（全件をサーバが一度に出す。277 行） | `lcu-renraku-list-SC_17001B00_01.html`, `lcu-renraku-detail-SC_17001B00_02.html` |
| スケジュール（週表示のカレンダー） | `SC_18001B00_01`（`initFromHome`, `previousWeek`, `nextWeek`, `monthlyIndication`, `listDisplay`, `timeTable`, `scheduleSelect`, `datePickerSelect`） | FullCalendar。イベントは**インライン JS の `events: [...]`**（XHR なし）。今週は祝日と行事（`listType` = `Holiday` / `teachingevent`）だけで、授業は出なかった | — |
| **時間割（教室・曜限）** | `SC_18001B00_13`（スケジュールの「時間割」ボタン = POST `SC_18001B00_01/timeTable`。学期の切り替えは `javascript:change(1|2)` → POST `SC_18001B00_13/change`） | HTML `table.schedule-table`。セルは `li.select-btn` で、h4=科目、p[0]=教員、p[1]=`<単位>単位 <ナンバリング>`、p[2]=`<キャンパス> <教室>`。`onclick=displayPopup(…, 曜日1-7, 時限1-7, …, 年度, 科目コード, クラス)` | `lcu-timetable-SC_18001B00_13.html` |
| 試験時間割 | `SC_18001B00_19`（POST `SC_18001B00_13/testTimeTable`。学期の切り替えは `SC_18001B00_19/change`） | HTML。2026 前期は「対象の科目はありません」 | — |
| 課題・小テスト・レポート・アンケート | 一覧 `SC_14002B00_01`（search / rowselect）→ 詳細 `SC_14002B00_02`、提出画面 `SC_14002B00_03` | HTML（DataTables）。`submissionSeq` が隠し列にある | `lcu-kadai-list-rows-SC_14002B00_01.json` |
| 受講科目の一覧 | `POST /lcu-web/SubjectInformationSearch/getClassSubjectList` | **JSON** | `lcu-getClassSubjectList.json` |
| 出欠 | `SC_13002B00_01`（search / linkselect）。列は 講義名, 学期/曜日・時限, 公開状況, 出席, 欠席, 遅刻, 早退, 公欠, 無効 | HTML | —（値は個人データなので取っていない） |
| 成績 | `SC_15005B00_01`（成績ダッシュボード。グラフはインラインのデータ）→ `SC_10004B00_01`（成績情報。POST `SC_15005B00_01/gredeInformation`） | HTML。**値は記録していない** | `lcu-grades-shape-SC_10004B00_01.html`（列だけ） |
| 授業参考情報 | `SC_12001B00_01/initFromHome` | 未観測（この画面への移動は自動判定で止められた） | — |
| その他（予約申込 `SC_18001B00_04`, 履修登録 `SC_07002B00_01`, シラバス `SC_06001B00_01`, 活動記録 `SC_15003B00_01`, 学修成果シート `SC_15004B00_01`, 履修カルテ `SC_15006B00_03`, 学生情報 `SC_05002B00_01`, 個人システム設定 `SC_04001B00_01`, マイグループ `SC_04002B00_01`, 授業料免除 `SC_90001szu_01`, コミュニケーション掲示板 `SC_19003B00_01`, 各種申請 `SC_19006B00_01`, 学内FAQ `SC_19002B00_01`, 学内共有ファイル `SC_19001B00_01`） | 左メニューの ID だけ控えた。中は見ていない | — | — |

**連絡の種別コード**（連絡一覧の `contactTypeCondition` の選択肢）[観測]: U01 休講, U02 補講, U03 試験, U04 講義室変更, U05 学内連絡, U06 教員連絡, U07 安否確認, U08 個別質問コメント通知, U09 欠席回数警告通知, U11 各種申請結果通知, U13/U14 学修成果差戻し/確認済み, U15 スケジュール登録通知, U16 予約受付結果通知, U18/U19 履修カルテ差戻し/確認済み, U21 申請連絡受付通知, U23 小テスト登録通知, U24 レポート登録通知, U25 授業アンケート登録通知, U26 小テスト催促通知, U27 レポート催促通知, U28 授業アンケート催促通知。
**休講・補講・教室変更・試験の本人分は、この連絡（U01–U04）で届く。** 実際に U04 講義室変更の連絡があり、`targetDate`（対象日）が入っていた [観測]。

**共通の仕組み** [観測]
- どのフォームにも hidden の `_csrf` と **`_TRANSACTION_TOKEN`** がある。TERASOLUNA のトランザクショントークンと見ている [推測]
- **画面を裏で GET し直すとトークンが進み、開いているページのフォームが古くなる。** 実際に fetch で画面を取り直したあと、次のメニュー移動が「処理を続行することができませんでした」になり、セッションが切れた [観測]。connector は 1 セッションで直列に動かし、毎回、最後に受け取った HTML のトークンを使う
- JSON の XHR は `$.ajaxGetJSON`（GET、ヘッダの追加なし）と `$.ajaxPostJSON`（POST、`Content-Type: application/json;charset=utf-8`、ヘッダ `X-CSRF-TOKEN`、本文の JSON にも `_csrf`）。トークンは画面の HTML に埋め込まれている
- 一覧から詳細へ: `datatablesSubmitLinkForm('dataTable01','TableForm','<画面ID>/rowselect|rowSelect|linkselect', <_index>, true)` → `TableForm` の `rowIndex` に `_index` を入れて POST → 302 → 詳細画面の GET
- 一覧はサーバが全行を一度に出し、DataTables がページを分けているだけ。HTML を 1 回取れば全件ある（連絡 277 行、課題 62 行）。サーバ側の `<td>` には隠し列（`submissionSeq`, `statusCode`, `contactTypeOrder`, `subjectCode` = 年度＋科目コード＋クラス）も入っている
- 状態を変える操作（**呼んではいけない**）: `SC_17001B00_01/toDoIcon`, `SC_17001B00_01/readMark`, `SC_17001B00_02/addTodo`, 提出画面 `SC_14002B00_03` のボタン類、`SC_18001B00_01/scheduleAdd`, `*/report`（出力ファイルのダウンロード）
- **連絡の詳細を開くと既読になる**。未読のものは開かず、既読の連絡で構造を見た（連絡一覧の「未読のみ」で 162 件が未読）[観測]
- 添付ファイル: `GET /lcu-web/fileUploadDb/download/<prefix>/<temporaryId>/?<headers>` または `/lcu-web/fileUpload/download/...`（`fileupload.js` / `fileuploadDb.js`）。詳細画面では `POST /lcu-web/fileUpload/load/submit`（JSON、`X-CSRF-TOKEN`）で一時 prefix をもらってから一覧を出す [観測（スクリプト）]
- アイドル時間: ヘッダに「タイムアウトまであと 59:xx」と出る。スクリプトは `timerTimeExecute(0, 60, 0)` → **60 分** [観測]。XHR を呼ぶたびに伸びる（`timerTimeAjaxExecute`）
- セッション共通の XHR: `POST SC_01003B00_13/sessionTimeout`, `GET SC_01003B00_13/setClientLocationUrl?val=<origin>/`, `GET SC_01003B00_13/beforeLogoutProcess`, ログアウトは `SC_01003B00_13/lcuLogout`

### 1.6 バージョンの手がかり
フッターに製品のバージョン表記は**無い** [観測]。バージョン判定には次を使う。
- 同梱プラグインのパス: `jquery/v3.5.1`, `jquery-ui/v1.12.1`, `datatables/v1.10.20`, `modaal/v0.4.4`, `dropzone/v5.7.0`, `smooth-scroll/v16.1.2`, `jquery.stickybits/v3.7.3`, `jquery.matchHeight/v0.7.2`, `object-fit-images/v3.2.3`, `jquery.ui.datepicker-ja/v1.10.4`。`desvg`・`tablesorter`・`toastr`・`inview`・`datetimepicker` はパスが `vX.X.X`（文字どおり）[観測]
- 自前のスクリプト: `/lcu-web/js/common.js`（27,988 B）、`/lcu-web/js/fileupload.js`（18,945 B）、`/lcu-web/js/viewport.js` [観測]
- 画面IDの体系（`SC_01001B00_01` = ログイン、`SC_06001B00_21/22` = シラバス検索・詳細）[観測]
- 提案: `testedVersion` は `common.js` と `fileupload.js` の SHA-256、ログイン画面のフォーム ID の組で持つ
- ログイン後は `/lcu-web/js/fileuploadDb.js`（18,988 B）も読み込まれる [観測]

### 1.7 API surface（データの種類ごと。JSON を最優先）
調べ方: 各画面で (a) インラインスクリプトの `$.ajax` / `$.ajaxGetJSON` / `$.ajaxPostJSON` / `url:` / `fetch(` を grep した。(b) 画面が実際に出した XHR を `read_network_requests` と `performance.getEntriesByType('resource')` で見た。(c) 静的 JS（`common.js`, `fileupload.js`, `fileuploadDb.js`, `viewport.js`）を grep した。
**注意**: 本人の Chrome には Tampermonkey の userscript（`docs/research/lcu-web-enhancer.user.js`）が入っている。これは `fetch` と XHR を横取りし、`submissionInformation` の `mode` パラメータを消す。なので下の「呼び出し元」は LCU の HTML にある元の呼び方で書いた。JSON を確かめるときは、userscript に触られていない iframe の `fetch` を使った。

| データ | 一番良い入口 | 方式 | 状態 |
|---|---|---|---|
| 重要なお知らせ（授業連絡・学内連絡・課題/小テスト登録や催促・講義室変更。151 件） | `GET /lcu-web/SC_01002B00_00/importantNotice` | **JSON**（配列。`contactSeq, contactDate, contactTime, contactTypeCode, contactTypeTitle, importanceCategory, subjectClassSemesterWeekHour, targetDate, title`） | [観測] 呼び出し元は `$.ajaxGetJSON(url, {})`。本文は無いので、詳細は HTML（`SC_01002B00_00/importantNoticeLink` か `SC_01003B00_13/importantNoticeLink/<contactSeq>`）で取る |
| 未提出課題 | `GET /lcu-web/SC_01002B00_01/submissionInformation?mode=web` | **JSON**（配列） | [観測] 呼び出し元は `"/lcu-web/" + requestMapping + "/submissionInformation?mode=web"`。調査時点では `mode` あり・なしとも `[]` だった。中身の形（`submissionSeq` など）は userscript に書いてある内容で、こちらでは未確認。詳細は `setSubmissionInformationSelectRowIndex(submissionSeq)` のあと `postSubmit('SC_01002B00_Form','SC_01002B00_00/submissionInformationLink')` |
| 締切の警告（履修登録期限など） | `GET /lcu-web/SC_01002B00_01/warningNoticeInformation` | **JSON** | [観測] |
| 利用者名・ブックマーク画像 | `GET /lcu-web/SC_01002B00_00/userInformation` | **JSON** | [観測]（中身は個人データ。形だけ記録） |
| 受講科目（年度・学期ごと） | `POST /lcu-web/SubjectInformationSearch/getClassSubjectList` | **JSON**（`[{value:"<科目コード>_<クラス>", label, optGroupflg}]`）。`X-CSRF-TOKEN` が要る | [観測] |
| 週の予定（`scheduleInformation`） | `/lcu-web/SC_01002B00_NN/scheduleInformation` | — | `SC_01002B00_01/02/03` とも **404**。この大学のホーム画面には無い [観測]（userscript には載っている） |
| 時間割（教室・曜限） | `SC_18001B00_13` の HTML | HTML | [観測] XHR なし |
| 学年暦・祝日・行事 | `SC_18001B00_01` のインライン `events: [...]` | HTML に埋め込まれた JSON の配列 | [観測] |
| 連絡の一覧・本文・添付 | `SC_17001B00_01` → `SC_17001B00_02` | HTML。添付は `fileUpload*/download` | [観測]。一覧は JSON（importantNotice）で代わりがきく |
| 休講・補講・教室変更・試験（本人分） | importantNotice / 連絡一覧の U01–U04 | **JSON**（importantNotice の `contactTypeCode` で分ける） | [観測] U04 は観測した。U01–U03 は種別の定義だけ見た（実物は 0 件） |
| 課題・小テスト・レポートの一覧 | `SC_14002B00_01` の HTML（全行入り） | HTML | [観測] |
| 試験時間割 | `SC_18001B00_19` の HTML | HTML | [観測] |
| 出欠 | `SC_13002B00_01` の HTML | HTML | [観測] |
| 成績 | `SC_10004B00_01` の HTML | HTML | [観測]（値は記録していない） |
| シラバス | §3（公開） | HTML | [観測] |

**ICS / RSS / 携帯版 / 公開 API**
- `/lcu-web/api`, `/lcu-web/sp`, `/lcu-web/rss`, `/lcu-web/ical`, `/lcu-web/swagger-ui.html`, `/lcu-web/actuator` はどれも 200 の `<title>error`（中身の無い 404）。`/lcu-api`, `/lcu-sp`, `/lcu-app` は 404。`/lcu-web/api/v1`, `/lcu-web/v2/api-docs` も 404 [観測]
- 画面の中に iCal/ICS の出力も RSS も見当たらない。時間割画面の「個人時間割出力」と、成績の `report` はファイル出力。押していないので形式は分からない [観測]
- 公式のスマホアプリ「LiveCampus U」（NTT データ九州、iOS App Store id1545098139）がある。お知らせ・成績・履修登録・プッシュ通知を扱う、と説明にある [観測（ストアの説明）]。アプリ用の API がある [推測]。`submissionInformation?mode=web` の `mode` もアプリ向けに別の値がある名残に見える [推測]。静大がアプリを有効にしているか、API の形はどうかは**未確認**（アプリの解析はしていない）
- 静大の学生教務ポータルは WordPress の REST と RSS がある（§4）

### 1.8 IdP consent automation
- 初回の調査（本人が同意する前）: `https://idp.shizuoka.ac.jp/idp/profile/SAML2/Redirect/SSO?execution=e1s3` に「送信属性の選択 / Information Release」が出た。選択肢は 3 つ（文面は §1.2）。既定は「このサービスに送信する情報が変わった場合は、再度チェックします。」。ボタンは「同意」「拒否」[観測]
- 本人が「同意」を押したあと、こちらのタブで LCU のセッションが切れたので（§1.5 のトークンの件）、`/lcu-web/` → `#btnSsoStart` でログインし直した。**このときは同意画面が出ず、そのまま `SC_01002B00_00` に入った** [観測]。本人によると「今後はこの確認をしない」を選んでも毎回出るとのこと。今回出なかったのは、IdP のセッションが残っていたからかもしれない [推測]
- そのため、同意フォームの HTML（action・hidden 項目・ラジオの value・IdP のバージョン）は**取れていない**。Shibboleth IdP v4/v5 の標準どおりなら、POST 先は同じ `execution` の URL で、項目は `_shib_idp_consentIds`（チェックボックス）、`_shib_idp_consentOptions`（`_shib_idp_doNotRememberConsent` / `_shib_idp_rememberConsent` / `_shib_idp_globalConsent`）、送信ボタンは `_eventId_proceed` / `_eventId_AttributeReleaseRejected`、それに `csrf_token` [推測（製品の既定）]
- 同意を覚えない理由の候補 [推測]: (1) IdP が同意の記録をサーバ側に持たず、クライアント側（Cookie `shib_idp_persistent_ss` か、localStorage `shib_idp_ls_*` の書き込み）に置いている。Cookie が消えるか、localStorage の読み書き画面（JS が自動 POST する `shib_idp_ls_success.*` / `shib_idp_ls_value.*`）が失敗している。(2) 送る属性の値が毎回変わり、「変わったら再確認」が効いている（例えばセッションごとの ID を送っている）。こちらの道具では Cookie と localStorage の名前を読めず（読み取りが遮断される）、確かめていない
- **検出方法**（connector 用）: ホストが `idp.shizuoka.ac.jp`、パスが `/idp/profile/SAML2/Redirect/SSO`、クエリに `execution=e1sN`、`<title>送信属性の選択</title>`、本文に「Information Release」。Playwright のフローでこの画面になったら、本人が事前に許可した方針に従ってフォームを送る（実装時に、実際のフォームを一度記録してから合わせる）
- 古い SAML の要求のまま戻ると `/idp/profile/Authn/SAML2/POST/SSO` で「ウェブログインサービス - 過去のリクエスト」になる。その場合は `/lcu-web/` から始め直す

---

## 2. 公開の休講案内（LCU）
- URL: `GET https://gakujo.shizuoka.ac.jp/lcu-web/SC_90002szu_01`（学生教務ポータルの「休講情報」リンク）[観測]
- 認証なし。全学の休講が出る（本人の分だけではない）[観測]
- `<main>` の中の `table.c-table`。列は「授業科目」「休講日」（`MM/DD`、年なし）「時限」（`3・4` のような表記）「担当教員」。行は `tr.is-unread` [観測]
- 授業科目のセルは `<科目名> (<クラス名>)`。表の下に `<div align="right">YYYY年MM月DD日HH:MM現在</div>` [観測]
- 補講・教室変更は載っていない [観測]
- 見本: `samples/lcu-kyuko-SC_90002szu_01.html`

## 3. シラバス（LCU 公開画面）
- 入口: `GET /lcu-web/SC_06001B00_21/init` → 302 → `GET /lcu-web/SC_06001B00_21`（大学サイト「シラバス検索」のリンク先）[観測]
- 認証なし。Cookie は `JSESSIONID` だけ [観測]
- 検索: `POST /lcu-web/SC_06001B00_21/search`（`application/x-www-form-urlencoded`、**UTF-8**）→ 302 → GET。項目 [観測]:
  `title`（年度×学部。例 `2243` = 2026年度 情報学部 [IN-B]、`2250` = 2026年度 全学教育科目（静岡））, `category`, `jikanwariSubjectName`, `staffName`, `practitionerFlag`（''/1/0）, `semester`（''/1 前期/2 後期）, `term`（3〜6）, `subjectCode`, `numbering`, `subjectName`, `subjectType`（00 講義/01 演習/02 実験実習実技/03 その他）, `week`（1〜7=月〜日, 8=時間割外, 9=集中講義）, `period`（1=1・2時限 … 7=13・14時限）, `freeword`, `_csrf`
- `title` を変えるとカテゴリを取り直す: `/lcu-web/SC_06001B00_21/changeTitle`（XHR、応答の形は未確認）[観測（スクリプト）]
- 結果: `#dataTable01`。`td[data-label]` の値は 講義名, 担当教員, クラス, タイトル, カテゴリ, 科目コード, ナンバリング, 学年, 開講学期, 曜日・時限（例 `木3・4`）。行は `tr[_index]` [観測]
- 詳細: `POST /lcu-web/SC_06001B00_21/linkselect`（`rowIndex`, `viewRowIndexArray`, `_csrf`）→ 302 → `GET /lcu-web/SC_06001B00_22`（タイトル「シラバス詳細」）[観測]
  - 項目: 科目ナンバリング, 授業科目名（英文）, クラス, 担当教員名（英文）, 所属, 研究室, 分担教員名, 対象学年, 開講キャンパス, 開講学期, 開講時期, 曜日・時限, **教室**, 必修選択区分, 単位数, キーワード, 授業の目標, 学修内容, 授業計画（回ごと）, 受講要件, テキスト, 参考書, 予習・復習, 成績評価の方法･基準, オフィスアワー, 担当教員からのメッセージ, アクティブ・ラーニング, 実務経験, 教職科目区分, 授業実施形態（対面/オンライン）[観測]
  - 和文・英文の切り替えボタンがある [観測]
- **1 科目を直接開く固定 URL は無い** [観測]。connector は「`title`＋`subjectCode` で検索 → 該当行の `rowIndex` で linkselect」を 1 セッションの中で順番に回す。同じ科目コードが学科・カテゴリ違いで複数行になる（例: 77403030 が 2 行）ので、`科目コード＋クラス＋タイトル` で重複を除く
- curl から日本語を送ると Windows では文字コードが崩れた（Git Bash の引数が Shift_JIS になる）。実装では UTF-8 でエンコードした body を送る（Python の urllib では通った）[観測]
- 見本: `samples/lcu-syllabus-search-form-SC_06001B00_21.html`, `samples/lcu-syllabus-search-result-SC_06001B00_21.html`, `samples/lcu-syllabus-detail-SC_06001B00_22.html`

## 4. 学生教務ポータル（WordPress）
- `https://wwp.shizuoka.ac.jp/acad-affairs-portal/`（WordPress 5.2.21、テーマ Iconic One）[観測]
- REST: `GET /acad-affairs-portal/wp-json/wp/v2/posts`（`application/json`、`X-WP-Total`/`X-WP-TotalPages`。調査時点で 21 件）、`/wp-json/wp/v2/categories`（「全学向け情報」など）。RSS は `/acad-affairs-portal/feed` [観測]
- 学部ページ `student_e/inf`（情報学部）に PDF へのリンク: 「情報学部・情報学専攻 R8時間割 前期/後期」「令和８年度前期末試験時間割」「令和8年度行事予定表」「読替表」「README 2026」。PDF のファイル名はハッシュ（`wp-content/uploads/sites/502/YYYY/MM/<md5>.pdf`）で、版が変わると URL も変わる（後期時間割が 2026/08 と 2026/09 の 2 本ある）[観測]
- 見本: `samples/portal-wp-posts.json`

## 5. Microsoft 365
- テナント: `shizuoka.ac.jp`、テナント ID `e0d7dc00-4621-4fe0-90b1-df7b1b40b351`、初期ドメイン `scii.onmicrosoft.com`、SharePoint は `scii.sharepoint.com`、地域 AS [観測（公開メタデータ）]
- `getuserrealm`: `NameSpaceType: Managed`（フェデレーションではない）。ブランド名 "Shizuoka University" [観測]
- アカウント名の形式: `姓.名.入学年度2桁@shizuoka.ac.jp`（大学の例は `shizuoka.tarou.23@shizuoka.ac.jp`。2017年度以前の入学者は別形式）[観測（案内文）]
- MFA: 2022年3月から全学で必須。Authenticator のコードと電話。通知タップ方式と SMS は使えない [観測（案内文）]。学内ネットワークからは MFA が省かれる記述がある [観測（案内文）]
- 本人は Chrome で `myaccount.microsoft.com` にサインイン済み [観測]
- My Apps に割り当てられているアプリ: Bookings, Clipchamp, Connections, Copilot Studio, Engage, Excel, Forms, Kaizala, Learning Activities, Lists, Loop, MicrosoftAzureActiveAuthn, OneDrive, OneNote, **Outlook**, Planner, Power Apps, Power Automate, Power Pages, PowerPoint, Reading Coach, Reflect, SharePoint, SUSUsignalsnotebook, Sway, **Teams**, To Do, Visio, Whiteboard, Word, アドイン, 予定表, 連絡先 [観測]
- 授業での Teams 利用: 大学の教員向け案内に「Teams クラスの作成」「授業タブ」「Forms で課題・小テスト」がある。チーム名は「yyyy年度（科目・クラス名等）」と決められている [観測（案内文）]。identity resolution に使える
- **Entra 管理センター（閲覧のみ）**
  - 学生アカウントで `entra.microsoft.com` を開ける（「Microsoft Entra 管理センターへのアクセスを制限する: いいえ」）[観測]
  - ユーザー設定「**ユーザーはアプリケーションを登録できる: はい**」「管理者以外のユーザーによるテナントの作成を制限する: いいえ」「ユーザーはセキュリティ グループを作成できる: はい」[観測]
  - アプリの登録の「新規登録」ボタンは押せる表示 [観測]（押していない）
  - 「エンタープライズ アプリ > 同意とアクセス許可 > ユーザーの同意設定」は **401「アクセス許可がありません」** で見られない [観測]
- **Graph Explorer**: サインインを押すとこちらのタブ外にポップアップが開き、状況が分からなかった。ポップアップはその後、誰も触らないまま閉じた。authorize URL を自分のタブで直接開く案は自動判定で止められたので、**同意ポリシーは未確認** [観測]

**自前アプリで Graph を使えるか**: アプリ登録は許可されている [観測]。ただ、委任権限（`Calendars.Read`, `Mail.Read`, `Team.ReadBasic.All`, `ChannelMessage.Read.All`, `Files.Read` など）に**ユーザー本人が同意できるか**は確かめられていない。日本の大学テナントでは「確認済み発行元のアプリだけ・低リスク権限だけ」や「管理者の承認が必要」にしていることが多い。`ChannelMessage.Read.All` は管理者の同意が必要な権限なので、どの設定でも本人だけでは通らない [推測（一般知識）]。結論は「アプリ登録は可、同意は本人が 1 回試して確かめる」。

## 6. その他の LMS
- **Google Classroom**: 大学の公式案内あり（「Googleアカウント（静大専用）でClassroomに参加する」）[観測（案内文）]。Chrome の既定 Google アカウントでは Classroom のホームが開き、クラスは 0 件 [観測]。静大専用アカウントでは確かめていない
- **Zoom**: 双方向型の授業で使う、と案内文にある [観測（案内文）]
- **EdStem**: `edstem.org/us/dashboard` はログイン画面に飛んだ（未ログイン、US リージョン）。メール欄に大学ドメインのアドレスがあらかじめ入っていた（ブラウザの自動入力か以前の入力）[観測]。大学の案内には出てこない [観測]。他のリージョン（au 等）は見ていない
- **Moodle**: `moodle.shizuoka.ac.jp`, `lms.shizuoka.ac.jp`, `cms.shizuoka.ac.jp`, `moodle.inf.shizuoka.ac.jp`, `lms.inf.shizuoka.ac.jp` はどれも DNS に無い [観測]。全学の Moodle は無いと見ている [推測]
- LCU 自体が LMS の役（授業連絡・課題・小テスト・授業トピック）。案内文に「オンライン授業は基本的に学務情報システムを活用」とある [観測（案内文）]

---

## 7. connector の方針

### connectors/livecampusu（profiles/shizuoka-university）
- **JSON を先に使う**（§1.7）: `importantNotice`（連絡と、休講・補講・試験・教室変更）、`submissionInformation?mode=web`（未提出課題）、`warningNoticeInformation`、`getClassSubjectList`（受講科目）。差分は `contactSeq` / `submissionSeq` で取る。JSON で取れないもの（時間割・教室、課題の全件、連絡の本文と添付、出欠、成績、試験時間割）は HTML のフォーム遷移で取る
- **auth: `saml` 方式（ブラウザで取る）**。Playwright の永続コンテキストで、人が 1 回ログインと属性送信同意を済ませる。以降は `/lcu-web/` → `#btnSsoStart` → IdP → Entra SSO → `/lcu-web/...` が無操作で通るか確かめる。Entra のセッションが切れたら `auth_required` にする
- **データ取得: Native HTTP＋HTML 解析**。ブラウザのコンテキストから `JSESSIONID` を借り、Node の HTTP クライアントで画面遷移を順番に再生する。シラバスで同じ再生（init → search → linkselect）がそのまま通ることを確かめた [観測]
  - 毎回、直前の HTML から `_csrf` を拾う
  - PRG なので 302 を追う
  - **1 セッションに 1 本の直列キュー**（複数タブ扱いのエラーを避ける）
  - `rowIndex` 依存の詳細は「検索 → 詳細 → 検索…」の順で回す
  - Cookie パスは `/lcu-web`。`;jsessionid=` の URL 書き換えにも対応する
  - 夜間停止を避けるスケジュール。エラー画面（`<title>error`、「処理を続行することができませんでした」）を見分けて、セッション失効として扱う
- profile に置くもの: Base URL、SSO 開始パス `/lcu-web/shibbolethLogin/sso?lang=ja`、IdP ホスト、画面ID の対応表（`syllabusSearch: SC_06001B00_21`, `syllabusDetail: SC_06001B00_22`, `publicCancellations: SC_90002szu_01`。ログイン後の画面は未記入）、`title` の年度×学部コード（年度ごとに変わる。例 2026 情報学部 = `2243`）
- metadata: `{apiStability: "unofficial", risk: "unsupported", testedVersion: <common.js と fileupload.js のハッシュ>}`

### connectors/syllabus
- LCU の公開画面を Native HTTP で取る（認証なし）。1 日 1 回。本人の履修科目（LCU 時間割から）だけを `title`＋`subjectCode` で引く。全件を舐めない
- 教室は `room` の Fact として `origin: authoritative`、出所は `syllabus`（優先度は academic-system より下）

### 休講（公開）
- `SC_90002szu_01` を Native HTTP で 15 分ごとに取る。科目名＋クラス名＋時限で本人の CourseOffering に寄せる。日付は年が無いので、取得日の年と前後関係で補う

### 学生教務ポータル
- WP REST（posts、`modified_gmt` で差分）＋情報学部ページの PDF リンクを見張る（URL が変わったら新版）

### connectors/microsoft365
- 方針は SPEC どおり（Graph、Authorization Code＋PKCE、公開クライアント）。テナントは `e0d7dc00-…` を固定、authority は `https://login.microsoftonline.com/shizuoka.ac.jp`
- 最初に、本人が自前アプリで `User.Read Calendars.Read Mail.Read Files.Read` に同意できるかを試す。「管理者の承認が必要」が出たら、Teams/Outlook はブラウザ adapter（Outlook on the web・Teams web）に切り替える
- `ChannelMessage.Read.All` は管理者同意が要る。Teams の投稿は「参加チームの一覧（`Team.ReadBasic.All`）＋ファイル（SharePoint）」までに絞るか、ブラウザ adapter で取る

---

## 8. 未解決
1. 授業参考情報 `SC_12001B00_01`、掲示板 `SC_19003B00_01`、学内共有ファイル `SC_19001B00_01` の中身（未観測）
2. IdP の SSO セッションの寿命（LCU のアイドル時間は 60 分と観測済み）。同意フォームの実物（§1.8）と、同意を覚えない理由
2a. `submissionInformation` の項目の形（調査時点では空）と `mode` の値ごとの違い。公式アプリ用の API の有無
3. IdP の上流が本当に Entra か（SAML プロキシの宛先）。`/idp/profile/Authn/SAML2/POST/SSO` を通ることまでは観測済み
4. Entra のユーザー同意ポリシー（Graph Explorer／自前アプリ）。本人が試す
5. 静大専用 Google アカウントでの Classroom の利用状況
6. EdStem を使っている授業があるか（US 以外のリージョンも含めて）
7. シラバスの `changeTitle` XHR の応答形式
8. 補講・教室変更がどこに出るか（LCU 授業連絡か、学部掲示か）

## 9. 見本ファイル（`docs/research/samples/`）
| ファイル | 中身 |
|---|---|
| `lcu-login-SC_01001B00_01.html` | ログイン画面の全文（公開、`_csrf` を伏せ字） |
| `lcu-kyuko-SC_90002szu_01.html` | 休講案内の `<main>`（担当教員を「教員 花子」に置換） |
| `lcu-syllabus-search-form-SC_06001B00_21.html` | シラバス検索フォーム（選択肢は実物） |
| `lcu-syllabus-search-result-SC_06001B00_21.html` | 検索結果の `TableForm`（2026 情報学部、「データベース」） |
| `lcu-syllabus-detail-SC_06001B00_22.html` | シラバス詳細の `<main>`（教員名・研究室番号を置換） |
| `portal-wp-posts.json` | 学生教務ポータルの WP REST posts（2 件、本文は 400 字で切った） |
| `m365-getuserrealm.json` | `getuserrealm.srf` の応答（ダミーのアドレス） |
| `m365-openid-configuration.json` | テナントの OIDC メタデータ（抜粋） |
| `lcu-home-importantNotice.json` | ホームの重要なお知らせの JSON（7 件。contactSeq を置換） |
| `lcu-home-misc-xhr.json` | submissionInformation / userInformation / warningNoticeInformation の JSON（userInformation は値を置換） |
| `lcu-getClassSubjectList.json` | 受講科目の JSON（3 件） |
| `lcu-renraku-list-SC_17001B00_01.html` | 連絡一覧の表（2 行。隠し列を含む） |
| `lcu-renraku-detail-SC_17001B00_02.html` | 連絡詳細の `<main>`（件名と本文を置換） |
| `lcu-timetable-SC_18001B00_13.html` | 時間割の表（2 時限分。教員名を置換） |
| `lcu-kadai-list-rows-SC_14002B00_01.json` | 課題一覧の行（サーバの `<td>` の中身。4 行） |
| `lcu-grades-shape-SC_10004B00_01.html` | 成績情報の列だけ（値はすべて削除。学籍番号は S0000000、氏名は 学生 太郎） |

公開ページの見本は未認証で取った。ログイン後の見本は、学籍番号・氏名・教員名・トークン・成績の値を置き換えるか削った。
