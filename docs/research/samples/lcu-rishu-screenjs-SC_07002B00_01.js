/*
 * Inline screen JS of 履修登録 SC_07002B00_01 (観測 2026-10-01).
 * Verbatim function bodies (markers decoded). These are the handlers behind every button
 * on the registration screen. STATE-CHANGING handlers are flagged; a connector that
 * registers/drops/reorders would send exactly the POST each one builds.
 *
 * exPostSubmit(formId, actionPath) === postSubmit: sets
 *   document.forms[formId].action = '/lcu-web/' + actionPath; .method='post'; .submit();
 * i.e. the WHOLE SC_07002B00_01_RegisterForm (all hidden fields above) is POSTed to actionPath.
 */

/* 学期切替 — navigation (reloads SC_07002B00_01 for the chosen semester/term). */
function change(semesterTermCode) {
  $('#SC_07002B00_01_RegisterForm_selectSemesterTermCode').val(semesterTermCode);
  return exPostSubmit('SC_07002B00_01_RegisterForm', 'SC_07002B00_01/change');
}

/* 「＋」追加ボタン — navigation: opens the search/add screen for a given 曜日(week 1-7)×時限(period 1-7) slot.
   NOT itself a registration; it posts to SC_07002B00_03/init which renders the course search+add screen. */
function add(week, period) {
  $('#SC_07002B00_01_RegisterForm_buttomWeekCode').val(week);
  $('#SC_07002B00_01_RegisterForm_buttomHourCode').val(period);
  return exPostSubmit('SC_07002B00_01_RegisterForm', 'SC_07002B00_03/init');
}

/* 抽選登録ボタン / 抽選志望状況の確認 — opens lottery screen SC_07002B00_02.
   (view of 抽選 wishes; the actual 抽選申込 confirm button lives ON SC_07002B00_02 — not captured, period closed) */
function lottery() {
  return exPostSubmit('SC_07002B00_01_RegisterForm', 'SC_07002B00_02/init');
}

/* ★STATE-CHANGING★ 抽選志望順位変更 — reorders a lottery preference. Would POST RegisterForm with
   selectComaCode=<コマコード>, rankIndex=<順位> to SC_07002B00_01/rankChange. */
function rankChange(selectComaCode, rankIndex) {
  showLoading();
  $('#SC_07002B00_01_RegisterForm_selectComaCode').val(selectComaCode);
  $('#SC_07002B00_01_RegisterForm_rankIndex').val(rankIndex);
  return exPostSubmit('SC_07002B00_01_RegisterForm', 'SC_07002B00_01/rankChange');
}

/* ★STATE-CHANGING (削除/取消)★ 削除ボタン — drops a registered course. Would POST RegisterForm with
   selectLectureCode=<講義コード> to SC_07002B00_01/cancel. DO NOT CALL. */
function cancel(lectureCode) {
  $('#SC_07002B00_01_RegisterForm_selectLectureCode').val(lectureCode);
  return exPostSubmit('SC_07002B00_01_RegisterForm', 'SC_07002B00_01/cancel');
}

/* シラバス遷移 — navigation: open syllabus detail for a course. */
function forwardSyllabus(schoolYear, subjectCode, classCode) {
  $('#SC_07002B00_01_RegisterForm_syllabusSchoolYear').val(schoolYear);
  $('#SC_07002B00_01_RegisterForm_syllabusSubjectCode').val(subjectCode);
  $('#SC_07002B00_01_RegisterForm_syllabusClassCode').val(classCode);
  return exPostSubmit('SC_07002B00_01_RegisterForm', 'SC_07002B00_01/forwardSyllabus');
}

/* 個人時間割出力 — file output (POST SC_07002B00_01/print). */
function outputIndividualTimetable() {
  return postSubmit('SC_07002B00_01_RegisterForm', 'SC_07002B00_01/print');
}

/* ポップアップ: カリキュラムマップ (PU_01003B00_07/init), window.open by POST. */
function openPopup_PU_01003B00_07(studentCode) {
  $('#PU_01003B00_07_CurriculumMapForm_StudentCode').val(studentCode);
  exPostPopup('PU_01003B00_07_CurriculumMapForm', 'PU_01003B00_07Win',
              '/lcu-web/PU_01003B00_07/init',
              'location=yes,...,width=1400,height=650,...');
  return false;
}

/* コンボボックス: 学部一覧取得 — XHR via $.ajaxPostJSON (sample/dev artifact; endpoint is SC_99999B00_01). */
function chengeSampleCmb() {
  var url = "/lcu-web/SC_99999B00_01/getDepartmentList";
  $.ajaxPostJSON(url, "", function(json) { setComboBox($("#sampleCmb"), json); });
}
