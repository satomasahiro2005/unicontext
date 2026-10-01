// Generates the synthetic 成績 fixtures. The markup reproduces the real pages observed on
// 2026-10-01 (SC_10004B00_01 成績情報, SC_10004B00_02 単位修得情報) element for element; every value
// (codes, titles, teachers, evaluations, credits, dates) is invented. Run: node make-grade-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, '../../../../docs/research/samples');

const TH = [
  ['subjectCode', '科目コード', true, '', ''],
  ['subjectKanaName', '', false, '', ''],
  ['subjectName', '科目名', true, 'subjectKanaName', 'include'],
  ['teacherCode', '', false, '', ''],
  ['staffName', '担当教員', true, 'teacherCode', ''],
  ['kubunDispOrder', '', false, '', 'html-num'],
  ['kubunName', '科目区分', true, 'kubunDispOrder', ''],
  ['subjectReqCode', '', false, '', ''],
  ['reqName', '単位区分', true, 'subjectReqCode', ''],
  ['unit', '単位', true, '', 'html-num'],
  ['sortScore', '', false, '', 'html-num'],
  ['score', '得点', true, 'sortScore', 'include'],
  ['markCode', '', false, '', ''],
  ['marks', '評価', true, 'markCode', 'include'],
  ['subjectGp', '科目GP', true, '', 'html-num'],
  ['reportYearSemesterTerm', '成績報告時期', true, '', ''],
  ['reportDate', '入力年月日', true, '', 'date'],
  ['replaceKana', '', false, '', ''],
  ['replaceName', '読替前科目名', true, 'replaceKana', 'include'],
  ['examTypeCode', '', false, '', ''],
  ['examType', '試験種別', true, 'examTypeCode', ''],
];

function thead() {
  return TH.map(([id, label, visible, sortKey, type]) => {
    const cls = visible ? 'title  -center u-w60-pc u-w80-sp' : 'title  ';
    return `<th class="${cls}" id="${id}" \n\t\t\t\t\t\t\t\t_visible="${visible}" \n\t\t\t\t\t\t\t\t_sortKey="${sortKey}" \n\t\t\t\t\t\t\t\t_sortKey2="" \n\t\t\t\t\t\t\t\t_sortable="true" \n\t\t\t\t\t\t\t\t_type="${type}" ><p>${label}</p></th>`;
  }).join('\n');
}

const RIGHT = new Set(['unit', 'score', 'subjectGp']);
const LABEL = Object.fromEntries(TH.map(([id, label]) => [id, label]));

function cell(id, value, wrap) {
  const cls = `content is-source ${RIGHT.has(id) ? '-right' : ''}`;
  const inner = wrap ? `<span class="${wrap}">${value}</span>` : value;
  return `<td class="${cls}" id="content" data-label="${LABEL[id]}">${inner}</td>`;
}

// Invented attempts. red = the page wraps the title, score and evaluation in span.fontBoldRed
// (observed for 不可/否/再試); yellow = interim result (span.backYellow, 「中間点」).
const ROWS = [
  // A course failed three times (retake history).
  { code: '90000001', kana: 'サンプルニュウモン', name: 'サンプル入門', t: '10000001', staff: '教員 一郎', ko: '1001', kubun: '必修', rc: '1', req: '必', unit: '2.0', ss: '9.00', score: '9', mc: '05', mark: '不可', gp: '0.00', term: '2024年度 前期 前期後半', date: '2024/08/20', ec: '1', exam: '本試験', red: true },
  { code: '90000001', kana: 'サンプルニュウモン', name: 'サンプル入門', t: '10000001', staff: '教員 一郎', ko: '1001', kubun: '必修', rc: '1', req: '必', unit: '2.0', ss: '30.00', score: '30', mc: '05', mark: '不可', gp: '0.00', term: '2025年度 前期 前期後半', date: '2025/08/21', ec: '1', exam: '本試験', red: true },
  { code: '90000001', kana: 'サンプルニュウモン', name: 'サンプル入門', t: '10000001', staff: '教員 一郎', ko: '1001', kubun: '必修', rc: '1', req: '必', unit: '2.0', ss: '45.00', score: '45', mc: '05', mark: '不可', gp: '0.00', term: '2026年度 前期 前期後半', date: '2026/08/19', ec: '1', exam: '本試験', red: true },
  // Failed, then passed the next year.
  { code: '90000002', kana: 'サンプルエンシュウ', name: 'サンプル演習', t: '10000002', staff: '教員 二郎', ko: '1001', kubun: '必修', rc: '1', req: '必', unit: '2.0', ss: '20.00', score: '20', mc: '05', mark: '不可', gp: '0.00', term: '2024年度 前期 前期後半', date: '2024/08/22', ec: '1', exam: '本試験', red: true },
  { code: '90000002', kana: 'サンプルエンシュウ', name: 'サンプル演習', t: '10000002', staff: '教員 二郎', ko: '1001', kubun: '必修', rc: '1', req: '必', unit: '2.0', ss: '85.00', score: '85', mc: '02', mark: '優', gp: '3.50', term: '2025年度 前期 前期後半', date: '2025/08/22', ec: '1', exam: '本試験' },
  // Online course (marker +), pass/fail evaluation without score or GP.
  { code: '90000003', kana: 'オンラインキョウヨウ', name: '+オンライン教養', t: '10000003', staff: '教員 三郎', ko: '100', kubun: '数理ＤＳ', rc: '1', req: '必', unit: '1.0', ss: '', score: '', mc: '07', mark: '合', gp: '', term: '2024年度 前期 前期後半', date: '2024/08/01', ec: '1', exam: '本試験' },
  { code: '90000004', kana: 'キャリアサンプル', name: '+キャリアサンプル', t: '10000004', staff: '教員 四郎', ko: '120', kubun: 'キャリア形成科目', rc: '1', req: '必', unit: '1.0', ss: '', score: '', mc: '10', mark: '否', gp: '', term: '2024年度 前期 前期後半', date: '2024/08/02', ec: '1', exam: '本試験', red: true },
  { code: '90000004', kana: 'キャリアサンプル', name: '+キャリアサンプル', t: '10000004', staff: '教員 四郎', ko: '120', kubun: 'キャリア形成科目', rc: '1', req: '必', unit: '1.0', ss: '', score: '', mc: '07', mark: '合', gp: '', term: '2024年度 後期 後期後半', date: '2025/02/10', ec: '1', exam: '本試験' },
  { code: '90000005', kana: 'サンプルスウガク', name: 'サンプル数学', t: '10000005', staff: '教員 五郎', ko: '1001', kubun: '必修', rc: '1', req: '必', unit: '2.0', ss: '95.00', score: '95', mc: '01', mark: '秀', gp: '4.50', term: '2024年度 後期 後期後半', date: '2025/02/12', ec: '1', exam: '本試験' },
  { code: '90000008', kana: 'サンプルジッケン', name: 'サンプル実験', t: '10000008', staff: '教員 八郎', ko: '1003', kubun: '選択', rc: '4', req: '選択', unit: '1.0', ss: '72.00', score: '72', mc: '03', mark: '良', gp: '2.20', term: '2025年度 後期 後期前半', date: '2025/12/01', ec: '1', exam: '本試験' },
  // Waiting for the re-exam, and a re-exam result.
  { code: '90000006', kana: 'サンプルトウケイ', name: 'サンプル統計', t: '10000006', staff: '教員 六郎', ko: '1002', kubun: '選択必修Ａ', rc: '5', req: '選必', unit: '2.0', ss: '', score: '', mc: '06', mark: '再試', gp: '', term: '2026年度 前期 前期後半', date: '2026/08/25', ec: '1', exam: '本試験', red: true },
  { code: '90000007', kana: 'サンプルリロン', name: 'サンプル理論', t: '10000007', staff: '教員 七郎', ko: '1001', kubun: '必修', rc: '1', req: '必', unit: '2.0', ss: '5.00', score: '5', mc: '05', mark: '不可', gp: '0.00', term: '2026年度 前期 前期後半', date: '2026/09/28', ec: '3', exam: '再試験', red: true },
  // Labels not observed on 2026-10-01, to exercise the classification: 認定 and an unknown one.
  { code: '90000009', kana: 'サンプルガイコクゴ', name: 'サンプル外国語', t: '', staff: '', ko: '110', kubun: '英語 選択', rc: '4', req: '選択', unit: '2.0', ss: '', score: '', mc: '08', mark: '認定', gp: '', term: '2025年度 前期 前期後半', date: '2025/05/01', ec: '1', exam: '本試験', replace: 'サンプル検定' },
  { code: '90000010', kana: 'サンプルトクロン', name: 'サンプル特論', t: '10000010', staff: '教員 十郎', ko: '1003', kubun: '選択', rc: '4', req: '選択', unit: '2.0', ss: '', score: '', mc: '99', mark: '評価保留中', gp: '', term: '2025年度 後期 後期後半', date: '2026/02/20', ec: '1', exam: '本試験' },
];

// Only in the 履修中含む view: a registered course without an evaluation, and an interim result.
const IN_PROGRESS_ROWS = [
  { code: '90000011', kana: 'サンプルコウキ', name: 'サンプル後期科目', t: '10000011', staff: '教員 十一', ko: '1001', kubun: '必修', rc: '1', req: '必', unit: '2.0', ss: '', score: '', mc: '', mark: '', gp: '', term: '2026年度 後期 後期後半', date: '', ec: '', exam: '' },
  { code: '90000012', kana: 'サンプルチュウカン', name: 'サンプル中間', t: '10000012', staff: '教員 十二', ko: '1003', kubun: '選択', rc: '4', req: '選択', unit: '2.0', ss: '70.00', score: '70', mc: '03', mark: '良', gp: '', term: '2026年度 後期 後期前半', date: '2026/09/30', ec: '1', exam: '本試験', yellow: true },
];

function row(r, i) {
  const red = r.red ? 'fontBoldRed' : r.yellow ? 'backYellow' : undefined;
  return `<tr class="is-unread" _index="${i}">${[
    cell('subjectCode', r.code),
    cell('subjectKanaName', r.kana),
    cell('subjectName', r.name, r.red ? 'fontBoldRed' : undefined),
    cell('teacherCode', r.t),
    cell('staffName', r.staff),
    cell('kubunDispOrder', r.ko),
    cell('kubunName', r.kubun),
    cell('subjectReqCode', r.rc),
    cell('reqName', r.req),
    cell('unit', r.unit),
    cell('sortScore', r.ss),
    cell('score', r.score, red),
    cell('markCode', r.mc),
    cell('marks', r.mark, red),
    cell('subjectGp', r.gp),
    cell('reportYearSemesterTerm', r.term),
    cell('reportDate', r.date),
    cell('replaceKana', ''),
    cell('replaceName', r.replace ?? ''),
    cell('examTypeCode', r.ec),
    cell('examType', r.exam),
  ].join('')}</tr>`;
}

function gradesPage({ view, rows, comment }) {
  const earned = view === 'earned';
  const tabs = earned
    ? `<a class="is-active">修得成績</a>\n                    \n                    \n                  \n                \n                  \n                    \n                    \n                      <a href="javascript:changeSeisekiKind(1)">履修中含む</a>`
    : `<a href="javascript:changeSeisekiKind(3)">修得成績</a>\n                    \n                    \n                  \n                \n                  \n                    \n                    \n                      <a class="is-active">履修中含む</a>`;
  return `<!-- ${comment} -->
<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>成績情報</title></head><body>
<script>
function changeSeisekiKind(seisekiKind) {
    $('#SC_10004B00_SearchForm_seisekiKind').val(seisekiKind);
    return exPostSubmit('SC_10004B00_SearchForm', 'SC_10004B00_01/changeSeisekiKind');
}
function changeRequirementtype() {
	return exPostSubmit("SC_10004B00_SearchForm", "SC_10004B00_01/changeRequirementtype");
}
$(function() {
	popupMenuForReport();
	$("td:has(span.backYellow)").addClass("backYellow");
});
</script>
<main class="c-container">
<div class="c-contents">
  <div class="c-breadcrumbs"></div>
  <div class="c-heading-h1-container">
    <h2 class="c-heading-h1">
       成績情報
    </h2>
        <p class="c-heading-description">成績情報は以下の通りとなります。<br>得点、評価の背景が黄色のものは中間点です。</p>
    <p class="c-heading-description">科目名の先頭にある成績マーカーについては、<a style="color: #0000EE;" target="_blank" href="https://gakujo.shizuoka.ac.jp/lcu-web/pdf/seisekiMarkerList.pdf">《成績マーカー一覧表》</a>をご確認ください。</p>
  </div>
  <div class="c-expands">
    <div class="c-expand">
      <form id="SC_10004B00_SearchForm" class="h-adr" action="/lcu-web/SC_10004B00_01" method="post">
        <div class="c-heading-container -all-over">
          <div class="c-heading-contents -between">
            <div class="c-heading-h3-container">
              <h3 class="c-heading-h3">
                学籍番号&nbsp;:&nbsp;S0000000
              </h3>
              <h3 class="c-heading-h3">
                学生氏名&nbsp;:&nbsp;学生 太郎
              </h3>
            </div>
            <div class="side-left">
              <p class="c-half-btn">
                      ${tabs}
                <input type="hidden" id="SC_10004B00_SearchForm_seisekiKind" name="seisekiKind" value="" />
              </p>
            </div>
            <div class="side-right u-w100per-sp">
              <div class="c-form-box u-w100per-sp">
                  要件：
                    <div class="select_wrapper u-w100per-sp"><select id="requirementTypeCode" name="requirementTypeCode" class="select u-w260-pc u-w100per-sp js-select" onchange="changeRequirementtype()"><option value="01" selected="selected">卒業要件（学士課程）</option><option value="ZZ">履修カルテ用教職要件</option></select></div>
              </div>
            </div>
          </div>
        </div>
      <div>
<input type="hidden" name="_csrf" value="00000000-0000-0000-0000-000000000000" />
</div></form>
      <div class="c-box-shadow">
          <div class="seiseki-marker-contents-body -small">
            <table class="c-table nowrap c-table-pd-narrow c-table-omitted hover no-footer" style="width:auto">
              <thead>
                <tr>
                  <th class="title -center" tabindex="0" aria-controls="02" style="width:auto"><p>成績マーカー</p></th>
                  <th class="title -center" tabindex="0" aria-controls="02" style="width:auto"><p>上限単位数</p></th>
                  <th class="title -center" tabindex="0" aria-controls="02" style="width:auto"><p>合計単位数</p></th>
                </tr>
              </thead>
              <tbody>
                  <tr class="is-unread odd" _index="0">
                    <td class="content is-source " id="content">+オンライン科目</td>
                    <td class="content is-source " id="content" style="text-align: right;">10.0</td>
                    <td class="content is-source " id="content" style="text-align: right;">2.0</td>
                  </tr>
              </tbody>
            </table>
          </div>
<form id="BaseForm" action="/lcu-web/SC_10004B00_01" method="post"><div class="c-table-scroll"><table id="02" class="c-table nowrap c-table-pd-narrow c-table-omitted hover" style="visibility: hidden;"><thead><tr>${thead()}
</tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div><input type="hidden" id="BaseForm_rowIndex" name="rowIndex" value="" /><input type="hidden" id="BaseForm_viewRowIndexArray" name="viewRowIndexArray" value="" /><div>
<input type="hidden" name="_csrf" value="00000000-0000-0000-0000-000000000000" />
</div></form>
		<button type="button" onclick="submitFormButtonForReport($(this), '/lcu-web/SC_10004B00_01/report');return false;"formId="BaseForm" loading="false" class="c-btn c-btn-submit01" fileType="report" ><span class="c-btn-link"><span class="c-btn-text c-icon-submission">成績通知表印刷</span></span></button>
		<button type="button" onclick="submitFormButton($(this), '/lcu-web/SC_10004B00_01/forward', '', '');return false;"formId="BaseForm" class="c-btn c-btn-submit01" ><span class="c-btn-link"><span class="c-btn-text ">単位修得情報照会</span><i class="c-icon-arrow-right c-color-base" aria-hidden="true"></i></span></button>
      </div>
    </div>
  </div>
</div>
</main>
</body></html>
`;
}

// ---- 単位修得情報 (SC_10004B00_02) ----

const E = (n) => '&emsp;'.repeat(n);
function sumRow(depth, name, required, expected, status) {
  const badge =
    status === '充足'
      ? '<span class="satisfaction-badge">充足</span>'
      : status === '不足'
        ? '<span class="lack-badge">不足</span>'
        : '';
  return `<tr>
  <td class="title" title-label="要件区分（科目名）">${E(depth)}${name}</td>
  <td class="title -right" title-label="必要単位">${required}</td>
  <td class="title -right" title-label="修得見込単位">${expected}</td>
  <td class="title -center" title-label="充足状況">
        ${badge}
  </td>
</tr>`;
}
function groupRow(depth, name, type, toggle, required, expected, status, courses) {
  const badge =
    status === '充足'
      ? '<span class="satisfaction-badge">充足</span>'
      : '<span class="lack-badge">不足</span>';
  const head = `<tr>
  <td class="title" title-label="要件区分（科目名）">
    <div class="c-form-box">
      <div class="inner-side-left">${E(depth)}${name}</div>
      <div class="inner-side-center">${type}</div>
      <div class="inner-side-right"><a href="" class="c-btn-toggle small js-accordion is-open" onclick="$('tr.${toggle}').toggle();"></a></div>
    </div>
  </td>
  <td class="title -right" title-label="必要単位">${required}</td>
  <td class="title -right" title-label="修得見込単位">${expected}</td>
  <td class="title -center" title-label="充足状況">
        ${badge}
  </td>
</tr>`;
  const rows = courses.map(
    ([title, ctype, credits, result]) => `<tr class="${toggle} SC_10004B00_02_toggle" style="display: none;">
    <td class="title" title-label="要件区分（科目名）">
      <div class="c-form-box">
        <div class="inner-side-left">${E(depth + 1)}${title}</div>
        <div class="inner-side-center">${ctype}</div>
        <div class="inner-side-right"></div>
      </div>
    </td>
    <td class="title -right" title-label="単位">${credits}</td>
    <td class="-center">
          ${result}
    </td>
    <td class="none" title-label="充足状況"></td>
  </tr>`,
  );
  return [head, ...rows].join('\n');
}

function requirementsPage() {
  const body = [
    sumRow(0, '卒業要件（学士課程）', '124.0', '30.0', '不足'),
    sumRow(0, '教養科目', '30.0', '8.0', '不足'),
    sumRow(1, '教養基礎科目', '10.0', '4.0', '不足'),
    sumRow(2, '教養基礎科目', '', '4.0', ''),
    groupRow(3, 'サンプル基礎', '必', 'topToggle90011', '2.0', '2.0', '充足', [
      ['+オンライン教養', '必', '1.0', '合格'],
      ['+キャリアサンプル', '必', '1.0', '合格'],
    ]),
    groupRow(3, 'サンプル選択群', '選必', 'topToggle90021', '4.0', '0.0', '不足', [
      ['サンプル統計', '選必', '2.0', ''],
      ['サンプル選択Ａ', '選必', '2.0', '不合格'],
      ['サンプル選択Ｂ', '選必', '2.0', ''],
    ]),
    sumRow(0, '専門科目', '94.0', '22.0', '不足'),
    sumRow(1, '学科専門科目／必修', '40.0', '22.0', '不足'),
    sumRow(2, '学科専門科目／必修', '', '22.0', ''),
    groupRow(3, '必修', '必', 'topToggle90031', '40.0', '22.0', '不足', [
      ['サンプル入門', '必', '2.0', '不合格'],
      ['サンプル演習', '必', '2.0', '合格'],
      ['サンプル数学', '必', '2.0', '合格'],
      ['サンプル後期科目', '必', '2.0', ''],
    ]),
  ].join('\n');
  return `<!-- UniContext fixture (SYNTHETIC values, real structure). 単位修得情報 SC_10004B00_02, reached by POST SC_10004B00_01/forward (「単位修得情報照会」). Observed 2026-10-01: one table, columns 要件区分（科目名）/必要単位/修得見込単位/充足状況; nesting = leading &emsp;; requirement groups carry a toggle link to their course rows (tr.topToggleNNNNN, hidden). -->
<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>単位修得情報</title></head><body>
<main class="c-container">
<div class="c-contents">
  <div class="c-heading-h1-container">
    <h2 class="c-heading-h1">
       単位修得情報
    </h2>
  </div>
  <div class="c-expands">
    <div class="c-expand">
      <form id="SC_10004B00_SearchForm" class="h-adr" action="/lcu-web/SC_10004B00_02" method="post">
        <input type="hidden" id="SC_10004B00_SearchForm_seisekiKind" name="seisekiKind" value="" />
        <div class="select_wrapper u-w100per-sp"><select id="requirementTypeCode" name="requirementTypeCode" class="select u-w260-pc u-w100per-sp js-select" onchange="changeRequirementtype()"><option value="01" selected="selected">卒業要件（学士課程）</option><option value="ZZ">履修カルテ用教職要件</option></select></div>
        <input type="hidden" name="_csrf" value="00000000-0000-0000-0000-000000000000" />
      </form>
      <div class="c-box-shadow">
        <div class="c-contents-body -small">
          <table class="dataTable c-table c-table-card c-table-pd-narrow c-table-omitted SC_10004B00_02_table">
            <thead>
              <tr>
                <th class="title -center u-w562-pc u-w240-sp">要件区分（科目名）</th>
                <th class="title -center u-w60-pc u-w80-sp">必要単位</th>
                <th class="title -center u-w60-pc u-w80-sp">修得見込単位</th>
                <th class="title -center u-w60-pc u-w80-sp">充足状況</th>
              </tr>
            </thead>
            <tbody>
${body}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>
</main>
</body></html>
`;
}

const NOTE =
  'UniContext fixture (SYNTHETIC values, real structure). 成績情報 SC_10004B00_01 from 成績ダッシュボード SC_15005B00_01 POST SC_15005B00_01/gredeInformation, observed 2026-10-01. Tabs 修得成績 (changeSeisekiKind(3), default) / 履修中含む (changeSeisekiKind(1)); both list failed attempts and re-exams. Grade table id="02" has 21 columns, 8 of them hidden (_visible="false": sort keys and codes). Failing evaluations are wrapped in span.fontBoldRed; interim results in span.backYellow. 認定 and 評価保留中 were not on the real page; they test the classification.';

writeFileSync(
  join(here, 'lcu-grades-SC_10004B00_01.synthetic.html'),
  gradesPage({ view: 'earned', rows: ROWS, comment: NOTE }),
);
writeFileSync(
  join(here, 'lcu-grades-inprogress-SC_10004B00_01.synthetic.html'),
  gradesPage({
    view: 'includingInProgress',
    rows: [...ROWS, ...IN_PROGRESS_ROWS],
    comment: `${NOTE} 履修中含む view: adds registered courses without an evaluation.`,
  }),
);
const shape = gradesPage({
  view: 'earned',
  rows: [],
  comment:
    'UniContext fixture (STRUCTURE ONLY, no grade values). 成績情報 SC_10004B00_01 as observed 2026-10-01 with every row removed (the real page had 69). See lcu-grades-SC_10004B00_01.synthetic.html for synthetic rows.',
});
writeFileSync(join(here, 'lcu-grades-shape-SC_10004B00_01.html'), shape);
writeFileSync(join(samples, 'lcu-grades-shape-SC_10004B00_01.html'), shape);
writeFileSync(join(here, 'lcu-credit-requirements-SC_10004B00_02.synthetic.html'), requirementsPage());
writeFileSync(
  join(samples, 'lcu-credit-requirements-SC_10004B00_02.synthetic.html'),
  requirementsPage(),
);
