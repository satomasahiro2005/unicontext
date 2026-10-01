import type { LcuDeploymentProfileInput } from '../core/deployment.js';

/**
 * 静岡大学 学務情報システム (LiveCampusU, https://gakujo.shizuoka.ac.jp/lcu-web/).
 * Source: docs/research/shizuoka.md §1 (observed 2026-10-01). Values marked "unverified" there are
 * marked here too.
 */
export const SHIZUOKA_DEPLOYMENT = {
  id: 'shizuoka',
  name: '静岡大学 学務情報システム',
  profileIds: ['shizuoka-university'],
  baseUrl: 'https://gakujo.shizuoka.ac.jp/lcu-web/',
  auth: {
    // Login page: form SC_01001B00_01_Login_Form; the only visible button starts Shibboleth SSO.
    ssoStartSelector: '#btnSsoStart',
    ssoStartPath: 'shibbolethLogin/sso?lang=ja',
    idpHosts: ['idp.shizuoka.ac.jp'],
    idpSsoPathPattern: '^/idp/profile/SAML2/(Redirect|POST|POST-SimpleSign)/SSO\\b',
    loginScreenId: 'SC_01001B00_01',
    loginFormId: 'SC_01001B00_01_Login_Form',
    loggedInScreenIds: ['SC_01002B00_00', 'SC_01002B00_01'],
  },
  screens: {
    landing: 'SC_01002B00_00',
    home: 'SC_01002B00_01',
    scheduler: 'SC_18001B00_01',
    timetable: 'SC_18001B00_13',
    examTimetable: 'SC_18001B00_19',
    noticeList: 'SC_17001B00_01',
    noticeDetail: 'SC_17001B00_02',
    assignmentList: 'SC_14002B00_01',
    assignmentSubmit: 'SC_14002B00_03',
    attendance: 'SC_13002B00_01',
    gradeDashboard: 'SC_15005B00_01',
    grades: 'SC_10004B00_01',
  },
  actions: {
    menuInit: 'init',
    schedulerToTimetable: 'SC_18001B00_01/timeTable',
    timetableChangeSemester: 'SC_18001B00_13/change',
    timetableToExams: 'SC_18001B00_13/testTimeTable',
    examChangeSemester: 'SC_18001B00_19/change',
    semesterField: 'selectSemesterTermCode',
    noticeRowSelect: 'SC_17001B00_01/rowSelect',
    noticeDetailBack: 'SC_17001B00_02/back',
    rowIndexField: 'rowIndex',
    assignmentSearch: 'SC_14002B00_01/search',
    // Spelling as served by LCU ("grede").
    gradesFromDashboard: 'SC_15005B00_01/gredeInformation',
  },
  endpoints: {
    importantNotice: 'SC_01002B00_00/importantNotice',
    submissionInformation: 'SC_01002B00_01/submissionInformation?mode=web',
    warningNotice: 'SC_01002B00_01/warningNoticeInformation',
    classSubjectList: 'SubjectInformationSearch/getClassSubjectList',
    commonScript: 'js/common.js',
  },
  forms: {
    // 課題・アンケートリスト search with every status filter off and every type on (unverified
    // field encoding: Spring checkbox markers "_<name>=on").
    assignmentSearch: [
      ['_submitKbn', 'on'],
      ['submissionType', '0'],
      ['submissionType', '1'],
      ['submissionType', '2'],
      ['submissionType', '3'],
      ['submissionType', '4'],
      ['_submissionType', 'on'],
      ['title', ''],
      ['subjectInfomationSearch.startYear', '{year}'],
      ['subjectInfomationSearch.startSemester', ''],
      ['subjectInfomationSearch.classSubject', ''],
    ],
    classSubjectList: {
      yearField: 'startYear',
      semesterField: 'startSemester',
      extra: { staffCode: '', subjectCode: '' },
    },
  },
  semesters: [
    { code: '1', name: '前期' },
    { code: '2', name: '後期' },
  ],
  // 連絡一覧 contactTypeCondition options (observed).
  contactTypes: {
    U01: { title: '休講', kind: 'cancellation' },
    U02: { title: '補講', kind: 'makeup' },
    U03: { title: '試験', kind: 'exam' },
    U04: { title: '講義室変更', kind: 'roomChange' },
    U05: { title: '学内連絡', kind: 'notice' },
    U06: { title: '教員連絡', kind: 'notice' },
    U07: { title: '安否確認', kind: 'notice' },
    U08: { title: '個別質問コメント通知', kind: 'notice' },
    U09: { title: '欠席回数警告通知', kind: 'notice' },
    U11: { title: '各種申請結果通知', kind: 'notice' },
    U13: { title: '学修成果差戻し', kind: 'notice' },
    U14: { title: '学修成果確認済み', kind: 'notice' },
    U15: { title: 'スケジュール登録通知', kind: 'notice' },
    U16: { title: '予約受付結果通知', kind: 'notice' },
    U18: { title: '履修カルテ差戻し', kind: 'notice' },
    U19: { title: '履修カルテ確認済み', kind: 'notice' },
    U21: { title: '申請連絡受付通知', kind: 'notice' },
    U23: { title: '小テスト登録通知', kind: 'assignment' },
    U24: { title: 'レポート登録通知', kind: 'assignment' },
    U25: { title: '授業アンケート登録通知', kind: 'assignment' },
    U26: { title: '小テスト催促通知', kind: 'reminder' },
    U27: { title: 'レポート催促通知', kind: 'reminder' },
    U28: { title: '授業アンケート催促通知', kind: 'reminder' },
  },
  idleTimeoutMinutes: 60,
  // The FAQ only says "夜間に定期的な停止があります" without times; this window is a conservative
  // guess (unverified).
  maintenanceWindow: '01:00-06:00',
  version: {
    scripts: [
      { path: 'js/common.js', size: 27988 },
      { path: 'js/fileupload.js', size: 18945 },
    ],
  },
} satisfies LcuDeploymentProfileInput;
