# 静岡大学 情報学部 VPN ファイル共有 調査メモ（2026-10-05）

本人のログイン済み Chrome（claude-in-chrome）で、新しいタブを開いて読み取りだけ調べた。
一覧・閲覧のみ。アップロード・削除・リネーム・フォルダ作成・設定変更・サインアウトはしていない。
Cookie / トークン / 学籍番号・アカウント名 / 個人名 / ファイル中身は本メモに書かない（構造を示すのに必要なフォルダ名だけ、個人名を伏せて最小限）。

各項目に **[観測]**（実際に見た）か **[推測]**（観測からの推論・未確認）を付ける。

---

## 0. まとめ

| 項目 | 結論 |
|---|---|
| 製品 | **Ivanti Connect Secure**（旧 Pulse Secure）SSL-VPN の Web ポータル。React 製 end-user UI（`reactPsal`）。appliance `25.1.3.1-23681` [観測] |
| ホスト | `vpn.inf.shizuoka.ac.jp`（情報学部独自。全学の LCU/M365 とは別系統）[観測] |
| 対象リソース | `resource_1423533946.487706.3` = Windows(SMB/CIFS) ファイル共有ブックマーク **「FS share」**[観測] |
| 中身の構造 | 共有直下に `class` / `report` / `student` / `submit` と `.DS_Store`。`class` が**講義資料の配布領域**（年度＋科目名のフォルダ 114 件以上）。他は本人は 403 [観測] |
| 認証 | LCU の Shibboleth/M365 SSO とは**別の Ivanti ポータルログイン**（realm パス `url_3`）。本人は既にログイン済み。ログイン画面は観測せず（既ログインのため）[観測/推測] |
| セッション Cookie | `DSID`（本体）, `DSFirstAccess`, `DSLastAccess`, `DSSIGNIN`, `DSBrowserID` ほか（名前のみ）[観測] |
| セッション寿命 | `DSmaxTimeout = 3600`（最長 60 分）、`DSLastAccess` が毎リクエスト更新＝アイドルタイムアウトあり [観測] |
| 一覧 API | `GET /api/v1/fb/list?...`（JSON）。Cookie だけの素の GET で読める [観測] |
| **重大な注意** | SMB バックエンドが**非常に不安定**。同じ `class` が 114 件返った直後に数分間 `403 ファイル参照エラー` を連発し、たまに `200` 空を返す。正規 UI 経由でも同じ [観測] |
| connector 方針 | browser profile（LCU と**別**）を使い、ログイン済みページの**同一オリジン GET**（`page.evaluate(fetch)`）で読む read-only connector（teams-web のミラー/ダウンロード/抽出を流用）。**ポータルが唯一の経路**。|
| フル VPN クライアント | **未検証・おそらく使えない**。本人が Microsoft Store の Pulse/Ivanti アプリを試したが接続できなかった（2026-10-05 報告）。本メモの旧「案B（直 SMB）」は**推奨を取り下げ**、ポータル JSON API だけを前提にする。|
| 探索の原則（重要） | AI は **UniContext のローカル索引から探索**する（live に毎回当たらない）。browse/search/recent はすべて保存済みツリーから即答し、各フォルダの「最後に成功して一覧できた時刻」を見せる。背景同期がフォルダ単位で増分更新（リトライ+バックオフ、中断地点から再開、失敗時は直近の良い一覧を保持）。|

**本人に頼むこと（needs user）**
1. ログイン方式の確認: 既ログインだったため sign-in 画面を見ていない。Ivanti ポータルのログインが
   情報学部アカウント（`cs`+数字の演習サーバ系アカウント）のパスワード単体か、MFA 付きか未確認。
   新規ログインが必要になりパスワード/MFA を要求されたら、こちらでは入力せず止める。
2. 同時セッション上限の確認（§2.4）: daemon がログインすると本人の対話セッションを蹴る恐れがある。

---

## 1. リソースとポータルの構造

### 1.1 対象リソース（FS share）
- `v = resource_1423533946.487706.3`、ブックマーク名「FS share」、`type: win`（Windows 共有）、workgroup `INF` [観測]
- 共有直下（`dir=`）[観測]:

  | 名前 | 種別 | 備考 |
  |---|---|---|
  | `class` | フォルダ | 講義資料。年度×科目のサブフォルダ 114 件以上 |
  | `report` | フォルダ | 本人アクセスは 403（権限 or バックエンド不調、区別つかず） |
  | `student` | フォルダ | 同上 403 |
  | `submit` | フォルダ | 同上 403（名前から提出用と推測）|
  | `.DS_Store` | ファイル | macOS が残したゴミ（約 14KB）|

- `class` の中身は **`<年度><科目名>` のフォルダ**。構造を示す無害な例のみ: `2024コンピュータ入門`,
  `2024データ処理演習`, `2025Webシステム設計演習`, `2023情報処理DS演習` のような命名 [観測]。
  2023〜2025 年度が大半で、**多くは末尾に担当教員の姓が括弧書き**で付く（本メモでは伏せる）。
  → つまり `class` は**学部全体の授業資料を年度・科目単位で配る共有**で、本人分だけでなく他科目も見える。
- 一段深い一覧は `dir=class`、さらに `dir=class/<科目フォルダ名>` と `dir` を伸ばせば取れる構造 [観測/推測]。

### 1.2 ポータルにある他のブックマーク
- System File Bookmarks（管理者定義の SMB 共有）は 12 件 [観測]:
  - `FS share`（上記）
  - `FS`（DFS ルート。`list-shares` で share 名 `1910, 2015〜2029, DefaultUser, old-share2023, share, stdeng` を列挙）[観測]
  - **`2017年度生 fs home` 〜 `2026年度生 fs home`**（年次別の個人ホーム領域。各 `resource_<id>` が別共有に対応）[観測]
- Web ブックマーク（管理者定義、`/dana/home/launch.cgi?url=...` 経由のリバースプロキシ）[観測]:
  技術部 Web、研究室配属システム（`mng01.inf.in.shizuoka.ac.jp/labentry`）、情報学部演習サーバ
  （`edu.inf.in.shizuoka.ac.jp/pub/lectures`）、研究室フォーラム（`labforum.inf.in...`）。
- HTML5 ターミナル/RDP セッションの設定は無し（count 0）。`allowUserBookmarks = 0`（利用者は自前ブックマーク追加不可）[観測]。
- 左パネルは `Welcome / Files / Web Bookmarks` の 3 つ [観測]。

### 1.3 ポータルページ（React SPA）
- ランディング情報は `GET /api/v1/enduser/landing-page`（JSON。ブックマーク一覧・ユーザ表示名・各種フラグ）[観測]。
- 共有列挙 `GET /api/v1/fb/list-shares?...`、一覧 `GET /api/v1/fb/list?...`（§3）。
- 画面 URL の形: `/files/list/windows/<resourceId>?dirPath=<相対パス>`。クエリの `dirPath` に
  フルの `https://vpn.inf.../dana-na/auth/url_3/welcome.cgi` が入っていたのは**パンくず表示用のゴミ**で、
  実際の一覧は `dir=`（空＝共有直下）で動く。元 URL の長い dirPath は無視してよい [観測]。

---

## 2. 認証・セッション

### 2.1 ログインの系統
- LCU（学務）の Shibboleth→M365 とは**別物**。これは情報学部が持つ Ivanti VPN ポータルで、realm/role の
  パスは `url_3`（`/dana-na/auth/url_3/welcome.cgi`）[観測]。
- 表示ユーザ名は `cs`＋数字の**情報学部アカウント**（演習サーバ系）で、M365 の学籍アカウントとは別 [観測、値は伏せる]。
- 本人の Chrome は既にログイン済みで、sign-in 画面は出なかった → ログインが
  情報学部アカウントのパスワード単体か MFA 付きか、ローカル LDAP/AD かは**未確認** [推測]。
  **新規ログインでパスワード/MFA を要求されたら、こちらでは入力しない。**

### 2.2 Cookie（名前だけ）
`DSID`（セッション本体、通常 HttpOnly）, `DSFirstAccess`, `DSLastAccess`, `DSSIGNIN`, `DSBrowserID`,
`SUPPORTCHROMEOS`, `HC_HMAC_VERSION_COOKIE` [観測]。値は記録しない。

### 2.3 セッション寿命
- `DSmaxTimeout = 3600`（最長セッション 60 分）、セッションタイマー表示あり [観測]。
- `DSLastAccess` が毎リクエスト更新 → アイドルタイムアウトで切れる（Ivanti 標準）[観測/推測]。
- 書き込み系 API には `xsauth`（32 文字）と `nonce_token` が要る（`ui_vars` に入る）。
  **一覧（read）は Cookie だけで通り、xsauth 不要** [観測]。

### 2.4 同時セッション上限（重要・未確定）
- Ivanti Connect Secure は役割設定で「ユーザあたり最大セッション数」「同時ユーザ数制限」を持つのが普通で、
  新規ログインが**既存セッションを蹴る**ことがある [推測]。今回は直接観測していない。
- daemon がバックグラウンドでログインすると本人の対話セッションを失わせる（逆も）恐れ → §5 の設計で回避する。

---

## 3. HTTP での一覧・ダウンロード

### 3.1 ディレクトリ一覧
```
GET /api/v1/fb/list?t=p&v=<resourceId>&si=0&ri=0&pi=0&dir=<相対パス>&bmtype=1&bmname=<ブックマーク名>&sb=<sort>&so=<asc|desc>
```
- 応答 JSON（成功時）[観測]:
  ```
  { files: [ { isFile:"yes|no", size:"14.00 KB"|"0", timestamp:"Mon Oct  5 09:13:03 2026\n",
               attrs:"A", name:"class" }, ... ],   // 先頭に "." ".." が入る
    sharePath: "<a href=...>FS share</a>",
    DirEntries: [],
    ui_vars: { xsauth, nonce_token, workgroup:"INF", smb_url_prefix:"/dana/fb/smb",
               wfb_upload:"/dana/fb/smb/wu.cgi", wfb_new_folder:"/dana/fb/smb/wnf.cgi", ... } }
  ```
- `dir` は共有ルートからの相対パス（`class`、`class/<科目>` と伸ばす）。`si/ri/pi` はページング用インデックス [観測/推測]。
- 共有列挙は `GET /api/v1/fb/list-shares?...` → `{ shares:[{share_name, smb_url}] }`（DFS ルート用）[観測]。
- 旧 CGI `/dana/fb/smb/wfb.cgi?...` も同じ閲覧（HTML 版）だが、今回はエラーページを返した [観測]。

### 3.2 ダウンロード（未実行）
- `ui_vars.smb_url_prefix = /dana/fb/smb`。Ivanti 標準のダウンロードは
  `/dana/fb/smb/wfd.cgi?...&dir=<path>&file=<name>`（`$value` 相当）[推測]。今回は**ダウンロードしていない**。
- **使ってはいけない**書き込み系: `wu.cgi`（アップロード）, `wnf.cgi`（新規フォルダ）[観測、叩いていない]。

### 3.3 どう叩くか（同一オリジン GET を採用）
- `/api/v1/fb/list` は Cookie 付きの素の GET で JSON を返す同一オリジン API [観測]。素の Node fetch でも
  DSID を持たせれば呼べる見込みだが、`DSID` は HttpOnly でブラウザ外に出す必要があり、Ivanti は
  セッションをクライアント IP / User-Agent に縛ることがある [推測]。
- **採用**: teams-web と同じく、ログイン済みの headless ページ内から `page.evaluate(fetch(url,{credentials:'same-origin'}))`
  で読む。利点: HttpOnly Cookie を**ブラウザの外に出さない**（最もプライバシー保護的・`cookieUrls:[]`）、
  UA と送信元 IP が本人セッションと自動的に一致、セッション蹴りも起きにくい。ダウンロード（`wfd.cgi`）も
  同じく同一オリジン GET をストリームする（teams-web の DOWNLOAD_OPEN/READ/CLOSE 流用）。
- 非 GET は context の route で**すべて遮断**（teams-web の `installReadOnlyRoute` と同型）。
  `wu.cgi`/`wnf.cgi`/削除系は xsauth/nonce が要るうえ、そもそも送らない。

### 3.4 ★ バックエンドの不安定さ（最重要）
- 同一の `dir=class` が **一度は 114 件**を返した後、**数分にわたり `403 {"err_msg":"ファイル参照エラー"}`** を
  連発し、間に一度だけ `200` で**空（files 0 件）**を返した。root（`dir=`）も同様に 200(7件)→403→200(空)→403 と揺れた [観測]。
- これは自分の fetch だけでなく**正規の React UI でページを開き直しても同じ**（「ファイル参照エラー」/「No Data Available」）[観測]。
  → ゲートウェイ裏の SMB マウント/資格情報が落ちて張り直している挙動 [推測]。
- `report/student/submit` は一貫して 403 だが、上記の揺れと混ざるため**「権限なし 403」と「一時失敗 403」が区別できない** [観測]。
- **設計上の帰結**: 403 や「200 だが空」を**失敗＝リトライ対象**として扱い、**絶対に「空になった＝削除」と解釈しない**。
  成功した `200 かつ entries あり` のときだけ一覧を信用して差分を取る。

---

## 4. 他の到達手段（検証結果：ポータルが唯一）

| 手段 | 内容 | 判定 |
|---|---|---|
| Web ポータル SMB 閲覧（本調査） | `/api/v1/fb/list` + `wfd.cgi` を同一オリジン GET で | **これだけ**（§3.4 の不安定・60 分上限はあるが、唯一到達できる）|
| フル VPN クライアント＋直 SMB | Ivanti/Pulse Secure クライアントで学内へトンネル→ 直 SMB2 | **使えない**。本人が Microsoft Store の Pulse アプリを試したが接続失敗（2026-10-05）。clientless Web ポータルのみ提供の構成とみられる [本人報告]。|
| 学内ネットワーク＋直 SMB | 学内の有線/無線から VPN 無しで同じ共有へ | 学外では不可。daemon の常時経路にはならない。|

- 旧版にあった「案B（直 SMB が最も堅牢）」は**取り下げ**。フル VPN クライアントは未検証かつおそらく
  使えないので、設計は**ポータル JSON API だけ**を前提にする。
- ポータルが不安定で唯一の経路である以上、**AI は毎回 live に当たらず、UniContext のローカル索引から探索**する
  のが要（§5・§7）。live へ行くのは背景同期（増分・低頻度）とオンデマンドのダウンロードだけ。

---

## 5. connector 設計（採用・`connectors/shizuoka-vpn-files`）

browser profile 流用の read-only connector。teams-web のダウンロード/ミラー/抽出をそのまま流用し、
一覧は同一オリジン GET（§3.3）。実装は Option A のみ（Option B は取り下げ、§4）。

### 5.1 認証・セッション
- adapter-browser の browser profile を **LCU/teams-web と共有しない別プロファイル**（別ホスト・別セッション系統）。
- `unicontext login shizuoka-vpn-files` で本人が Ivanti ポータル（realm `Student-Realm`, path `url_3`,
  form `frmLogin`→`login.cgi`）に一度サインイン。パスワード/MFA は**本人**が行う。背景同期は headless で
  既存プロファイルのセッションを引き継ぐ（`refresh`/`withPage`）。
- **第 2 セッションを作らない**（セッション蹴り回避）。クレデンシャル/MFA 画面に到達したら headless は
  `auth_required` で止める（adapter-browser が credential フィールドを検出して自動入力を拒否）。
- HttpOnly Cookie は**ブラウザの外に出さない**（`cookieUrls: []`）。全読み取りはページ内 fetch。

### 5.2 ツリー全体を歩く（科目名で絞らない）
- 変則的なディレクトリ構造のため、**enrolled 科目タイトル一致でクロールを絞らない**。アクセスできる
  ツリー全体（`class` と他の読める root）を **DFS・深さ/件数上限つき**で歩き、メタデータのみ
  （フルパス・名前・サイズ・timestamp・isFile）を取る。403 の root は**スキップして記録**（削除扱いにしない）。
- 各フォルダ → raw `szvpn.folder`（`path`/`listedAt`/`status`/子件数、**成功時のみ**上書き）、
  各ファイル → raw `szvpn.file` → canonical `document`+`material`（`path`=ツリー全体のパス）。
- 科目対応は **best-effort で絞り込みに使わない**:
  - 年度プレフィックス＋タイトル類似＋担当教員で、フォルダ→科目の**未確認 identity 候補**を提案（本人が
    confirm/override）。teams-web と同じ `IdentityResolver`（title-only candidate, 同年度・完全一致で +0.2）。
  - config の明示 `courseMap`（`path`→`course`）も受ける。
  - 対応が付かないフォルダも**見え続ける**（browse / search / recent / `list_course_files` の path 引数）。

### 5.3 探索はローカル索引から（live に毎回当たらない）
- browse / search / recent / get-meta はすべて**保存済みツリー**から即答（context-engine 新モジュール
  `vpn-files.ts`、MCP は `apps/mcp` に読み取り専用ツール追加、remote surface でも読める）。
- 各フォルダの「最後に成功して一覧できた時刻」（`szvpn.folder.listedAt`）を見せる。

### 5.4 背景同期（増分・堅牢）
- フォルダ単位の増分。cursor.extra に **frontier（未訪問パス）＋ per-folder の子 index/listedAt＋backoff**。
  中断地点から**再開**。frontier が尽きたら間隔を置いて root から再 walk。
- `403 ファイル参照エラー`・空 200 は**リトライ対象**（指数バックオフ）。**失敗/空を削除と解釈しない**。
  削除は「**成功して再一覧できたフォルダ**から子が消えたとき」だけ明示 deletion（§3.4）。
- 失敗時は**直近の良い一覧を保持**（`szvpn.folder` を上書きしない。失敗は cursor 側に記録）。
- 低頻度（既定日次・夜間を避ける）。1 リクエストずつ・大きめの間隔。

### 5.5 ダウンロード/ミラー（a55ebd4 流用）
- オンデマンド `download_course_file`（document id で解決）→ `wfd.cgi` を同一オリジン GET で
  `.part` にストリーム→リネーム。取得済みは cache に残り、以後の読み取りは**ポータルに触れない**。
- 版判定は **timestamp+size**（SMB に cTag 相当なし）。PDF/DOCX/PPTX/TXT/MD の本文抽出→document chunks。
- 任意の prefetch: 本人がマーク / 現年度の科目に対応するフォルダの小さいファイルをミラーに先読み
  （generic mirror 流用、既定オフ）。

### 5.6 metadata / profile / リスク
- metadata: `apiStability: unofficial`, `risk: unsupported`, `adapter: browser`,
  `defaultAuthority: collaboration`（講義資料の配布領域）。`testedVersion` = appliance 世代。
- profile: resource ID・realm path `url_3`・bookmark 名・歩く root を `profiles/shizuoka-university`。
- リスク: ①バックエンド不安定（§3.4・索引 first で緩和）②60 分セッション/蹴り（§2.4・単一セッション）
  ③ToS（自動化はグレー・本人の明示依頼で read-only 限定）④`class` は他人の科目も見える（絞り込みはしないが
  **既定無効**・本人が有効化。所有権は本人のアカウントで見えている範囲のみ）。

---

## 6. 未確認
- ログイン方式の詳細（パスワード単体か MFA か、local/LDAP/AD）。form は `frmLogin`→`login.cgi`,
  realm `Student-Realm`、hidden `tz_offset`/`clientMAC`/`realm`（2026-10-05 再確認・サインインはせず）[§2.1]。
- 同時セッション上限と「新規ログインで既存を蹴るか」[§2.4]。
- 深い階層一覧の実挙動と `wfd.cgi` の厳密なパラメータ [§3.2]（実データ再取得は本人ログイン後に）。
- `report/student/submit` が恒久的に権限なしか、§3.4 の一時失敗だったか。

## 7. ツリー構造の所見（サニタイズ）
§1.1 の `class/<年度><科目名>` 以外に、ツリーは**層の深さがフォルダごとに不揃い**なことを前提にする
（本人の「変則的なディレクトリ構造」）。観測・推測される不規則さ [観測=§1、他は推測]:
- `class` 直下は `<年度><科目名>`（例の形式: `2024コンピュータ入門`、末尾に担当教員の姓が括弧書き）。
  その下は科目ごとにばらばら: 直接ファイルが置かれる科目、`資料/` `課題/` `slides/` のような小分け、
  `第1回`〜`第N回` の回別、年度内に別日程のサブフォルダ、など**深さが一定でない**。
- root 直下に `class` のほかに `report`/`student`/`submit`（本人は 403）と `.DS_Store`。403 は記録のみ。
- System File Bookmarks には `FS`（DFS ルート、`list-shares` で複数 share）や
  `2017〜2026年度生 fs home`（年次別の個人ホーム）もある。歩く root は profile で明示列挙し、
  既定は `FS share` の `class`（＋本人が許可すれば該当年次 `fs home`）。
- 命名ゆれ: 全角/半角・年度の付き方（`2024` と `2024年度`）・教員名の有無・英日混在。
  → 絞り込みには使わず、**パス/名前そのまま**を索引し、科目対応は best-effort（§5.2）。

**固定フィクスチャはこの構造を模した合成データ**（実名・学籍番号・Cookie は含めない）。

## 8. 2026-10-05 の再訪メモ
- ログイン画面のみ再確認（form 構造・realm・DSID Cookie 名）。**サインインはしていない**。
- 本人の Chrome の VPN セッションは**失効**（`/dana/home/index.cgi` が `welcome.cgi` にリダイレクト、
  `/api/v1/enduser/landing-page` も未認証）。60 分アイドルの想定どおり。ライブのツリー再取得は
  本人の再ログインが要るため行わず、§1・§7 の既存所見で設計を確定した。
