import { describe, expect, it } from 'vitest';
import {
  classifyPage,
  collectPluginVersions,
  extractRoomChange,
  extractTokens,
  findEventsLiteral,
  gradeTableColumns,
  gradeViewKind,
  GRADE_COLUMNS,
  GRADE_HIDDEN_COLUMNS,
  jsLiteralToJson,
  parseAssignmentCells,
  parseAssignmentList,
  parseAttendance,
  parseCalendarEvents,
  parseExamTimetable,
  parseCreditRequirements,
  parseGradeMarkers,
  parseGrades,
  parseLcuReportTerm,
  noticeAttachmentLoadPath,
  parseNoticeAttachments,
  parseNoticeDetail,
  parseNoticeList,
  parseNoticeReadState,
  parseSubjectKey,
  parseSubjectText,
  parseTermRange,
  activeSemesterLabel,
  parseTimetable,
  parseTimetablePage,
  periodFromLabel,
  pluginFingerprint,
  screenIdFromUrl,
  selectedOption,
  splitGradeMarkers,
  splitTitleClass,
  stripJsessionid,
  TESTED_FINGERPRINT,
  uniquePeriodOnDay,
} from '../src/index.js';
import { fixture, jsonFixture, kadaiListHtml, markNoticeRead } from './helpers.js';

const CLASSIFY = { loginFormId: 'SC_01001B00_01_Login_Form', ssoStartSelector: '#btnSsoStart' };

describe('timetable page: semester switch and off-grid lists', () => {
  it('reads the shown semester, the year and the 時間割外講義 list', () => {
    const page = parseTimetablePage(fixture('lcu-timetable-full-SC_18001B00_13.synthetic.html'));
    expect(page.activeSemesterLabel).toBe('前期');
    expect(page.year).toBe(2026);
    expect(page.entries).toHaveLength(6);
    expect(page.entries[0]?.semesterCode).toBe('1');
    expect(page.offGrid).toEqual([
      expect.objectContaining({
        kind: 'unscheduled',
        year: 2026,
        semesterCode: '1',
        subjectCode: '77301020',
        classCode: 'RW',
        title: 'コンピュータ入門',
        teacher: '教員 花子',
        credits: 2,
        numbering: 'IN002160040',
        room: '共通講義棟２１',
      }),
    ]);
  });

  it('an empty 後期 (nothing registered yet) has no entries and says 後期', () => {
    const html = fixture('lcu-timetable-empty-SC_18001B00_13.synthetic.html');
    const page = parseTimetablePage(html);
    expect(page).toMatchObject({ entries: [], offGrid: [], activeSemesterLabel: '後期' });
    expect(activeSemesterLabel(html)).toBe('後期');
  });

  it('pages without a semester switch report no active semester', () => {
    expect(activeSemesterLabel(fixture('lcu-timetable-SC_18001B00_13.html'))).toBeUndefined();
  });
});

describe('timetable SC_18001B00_13', () => {
  const entries = parseTimetable(fixture('lcu-timetable-SC_18001B00_13.html'));

  it('reads every li.select-btn with displayPopup arguments', () => {
    expect(entries).toHaveLength(6);
    const first = entries[0];
    expect(first).toMatchObject({
      week: 1,
      period: 1,
      year: 2026,
      subjectCode: '77401180',
      classCode: '61',
      title: 'コンピュータネットワーク',
      teacher: '教員 花子',
      credits: 2,
      numbering: 'IN012160060',
      campus: '（共通）',
      room: '共通講義棟３１',
      flags: ['compulsory', 'confirm'],
    });
    expect(first?.selector).toContain('[week=1][period=1]');
  });

  it('maps rows 「3・4」 to period 2 and columns to weeks', () => {
    const thu = entries.find((e) => e.title === '情報理論');
    expect(thu).toMatchObject({ week: 4, period: 2, room: '情１３' });
    expect(entries.filter((e) => e.period === 1).map((e) => e.week)).toEqual([1, 2, 3, 5]);
  });
});

describe('notice list SC_17001B00_01', () => {
  const rows = parseNoticeList(fixture('lcu-renraku-list-SC_17001B00_01.html'));

  it('reads all rows including hidden columns', () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rowIndex: 0,
      unread: true,
      typeCode: 'U05',
      importanceDigit: '1',
      category: '学内連絡(共通)',
      title: '2026年度「学びの実態調査」の実施について【回答期間：10月1日(木)～11月15日(日)】',
      contactDateTime: '2026/09/30 17:00',
      subjectText: '',
    });
    expect(rows[0]?.subjectKey).toBeUndefined();
    expect(rows[1]).toMatchObject({
      rowIndex: 46,
      typeCode: 'U04',
      category: '講義室変更',
      targetDate: '2026/07/24',
      contactDateTime: '2026/07/23 10:30',
      subjectKey: { year: 2026, subjectCode: '77401220', classCode: '61' },
    });
    expect(rows[1]?.subjectText).toBe(
      '機械語と計算機械\n前期前半/金5・6, 前期前半/金7・8, 前期後半/金5・6, 前期後半/金7・8',
    );
  });

  it('reads the read state from the unread-row styling script, not tr.is-unread', () => {
    const html = fixture('lcu-renraku-list-SC_17001B00_01.html');
    expect(parseNoticeList(html).map((x) => [x.rowIndex, x.unread])).toEqual([
      [0, true],
      [46, true],
    ]);
    // LCU marks a row read by dropping its bold block; the class stays on every row.
    const read46 = markNoticeRead(html, 46);
    expect(read46).toContain('<tr class="is-unread" _index="46">');
    expect(parseNoticeList(read46).map((x) => [x.rowIndex, x.unread])).toEqual([
      [0, true],
      [46, false],
    ]);
    expect(parseNoticeReadState(read46)).toEqual({
      unread: new Set([0]),
      known: new Set([0, 46]),
    });
    // Removing the class alone says nothing.
    const noClass = html.replace('<tr class="is-unread" _index="46">', '<tr _index="46">');
    expect(parseNoticeList(noClass)[1]?.unread).toBe(true);
  });

  it('fails safe: without the script, or for rows it does not mention, rows count as unread', () => {
    const html = markNoticeRead(fixture('lcu-renraku-list-SC_17001B00_01.html'), 46);
    const noScript = html.slice(0, html.indexOf('<script>'));
    expect(parseNoticeReadState(noScript)).toBeUndefined();
    expect(parseNoticeList(noScript).every((r) => r.unread)).toBe(true);
    const unmentioned = html.replace(/\[_index='46'\]/g, "[_index='999']");
    expect(parseNoticeList(unmentioned)[1]?.unread).toBe(true);
  });

  it('flags rows with attachments (toDoAttachmentOrder x1 / commented ico_clip)', () => {
    const rows = parseNoticeList(fixture('lcu-renraku-list-SC_17001B00_01.html'));
    expect(rows.map((r) => r.hasAttachment ?? false)).toEqual([false, true]);
  });

  it('parses the hidden subjectCode key', () => {
    expect(parseSubjectKey('20267740122061')).toEqual({
      year: 2026,
      subjectCode: '77401220',
      classCode: '61',
      raw: '20267740122061',
    });
    expect(parseSubjectKey('')).toBeUndefined();
  });
});

describe('notice detail SC_17001B00_02', () => {
  it('reads title, type, courses, body, importance, date, sender', () => {
    const d = parseNoticeDetail(fixture('lcu-renraku-detail-SC_17001B00_02.html'));
    expect(d).toMatchObject({
      title: 'コンピュータ入門 連絡（件名）',
      category: '教員連絡',
      courses: ['コンピュータ入門(1クラス)', 'コンピュータ入門(再履修（情）１)'],
      importance: '重要連絡(通知有り)',
      contactDateTime: '2026/08/20 09:39',
      attachments: [],
      links: [],
    });
    expect(d?.body).toBe('（本文）\n（本文）\n（本文）\n（本文）');
    expect(d?.sender).toBeUndefined();
  });

  it('returns undefined for unrelated pages', () => {
    expect(parseNoticeDetail('<main><p>x</p></main>')).toBeUndefined();
  });

  it('keeps paragraphs and links of a rich-text body; nested tables do not leak into fields', () => {
    const html = fixture('lcu-renraku-detail-SC_17001B00_02.html').replace(
      /<div>（本文）[\s\S]*?<\/div>/,
      '<div><html><head></head><body><p class="MsoNormal">第一段落です。</p> <p>詳しくは<a href="https://example.ac.jp/a">こちら</a></p><table><tr><th>重要度</th><td>表の中</td></tr></table><p>URL: https://example.ac.jp/b</p></body></html></div>',
    );
    const d = parseNoticeDetail(html);
    expect(d?.body).toBe(
      ['第一段落です。', '詳しくはこちら', '重要度表の中', 'URL: https://example.ac.jp/b'].join(
        '\n',
      ),
    );
    expect(d?.importance).toBe('重要連絡(通知有り)');
    expect(d?.links).toEqual(['https://example.ac.jp/a', 'https://example.ac.jp/b']);
  });

  it('finds the read-only file-list call and parses its JSON', () => {
    const html = fixture('lcu-renraku-detail-SC_17001B00_02.html');
    expect(noticeAttachmentLoadPath(html)).toBe('fileUpload/load/fi02');
    expect(noticeAttachmentLoadPath('<main></main>')).toBeUndefined();
    expect(
      parseNoticeAttachments({
        prefix: 'fi02',
        temporaryFileList: [
          { temporaryId: 'a', physicalFileName: 'x.pdf', fileSize: 10, fileStatusType: 'STAY' },
          { temporaryId: 'b', physicalFileName: 'gone.pdf', fileSize: 1, fileStatusType: 'DELETE' },
          { temporaryId: 'c', physicalFileName: ' ', fileSize: 1, fileStatusType: 'STAY' },
        ],
      }),
    ).toEqual([{ name: 'x.pdf', size: 10 }]);
    expect(parseNoticeAttachments({ temporaryFileList: null })).toEqual([]);
    expect(parseNoticeAttachments('<html>')).toBeUndefined();
  });
});

describe('assignment list SC_14002B00_01', () => {
  const data = jsonFixture<{ rows: { _index: string; cells: string[] }[] }>(
    'lcu-kadai-list-rows-SC_14002B00_01.json',
  );

  it('parses DataTables row cells (hidden submissionSeq / statusCode included)', () => {
    const rows = data.rows.map((r) => parseAssignmentCells(r.cells));
    expect(rows[0]).toMatchObject({
      submissionSeq: '95133',
      submissionType: 'レポート',
      subjectText: 'コンピュータネットワーク(1クラス)\n前期後半/月1・2, 前期前半/月1・2',
      title: '01',
      statusName: '締切',
      statusCode: '4',
      submittalTerm: '2026/04/13 00:00 ～ 2026/04/20 00:00',
      submittalStatus: '未提出',
    });
    expect(rows[1]?.submittalStatus).toBe('提出済');
    expect(rows[3]).toMatchObject({
      submissionType: '学内アンケート',
      subjectText: '',
      submissionSeq: '2045',
    });
  });

  it('parses the server HTML table by th ids', () => {
    const rows = parseAssignmentList(kadaiListHtml());
    expect(rows.map((r) => r.submissionSeq)).toEqual(['95133', '96930', '95912', '2045']);
    expect(rows[1]?.title).toBe('第1回 小テスト');
  });

  it('parses submittalTerm ranges', () => {
    expect(parseTermRange('2026/05/08 21:50 ～ 2026/05/19 23:55')).toEqual({
      from: { year: 2026, month: 5, day: 8, hour: 21, minute: 50 },
      to: { year: 2026, month: 5, day: 19, hour: 23, minute: 55 },
    });
  });
});

describe('JSON fixtures', () => {
  it('importantNotice is an array with the observed keys', () => {
    const r = jsonFixture<{ response: Record<string, string>[] }>(
      'lcu-home-importantNotice.json',
    ).response;
    expect(r).toHaveLength(7);
    expect(Object.keys(r[0] ?? {}).sort()).toEqual([
      'contactDate',
      'contactSeq',
      'contactTime',
      'contactTypeCode',
      'contactTypeTitle',
      'importanceCategory',
      'subjectClassSemesterWeekHour',
      'targetDate',
      'title',
    ]);
  });

  it('getClassSubjectList values are <subjectCode>_<classCode>', () => {
    const r = jsonFixture<{ response: { value: string; label: string }[] }>(
      'lcu-getClassSubjectList.json',
    ).response;
    expect(r.map((x) => x.value.split('_'))).toEqual([
      ['77301020', 'RW'],
      ['77301090', '61'],
      ['77351100', '61'],
    ]);
    expect(splitTitleClass(r[0]?.label ?? '')).toEqual({
      title: 'コンピュータ入門',
      className: '再履修（情）１',
    });
  });

  it('misc XHR fixture has the three home endpoints', () => {
    const r = jsonFixture('lcu-home-misc-xhr.json');
    expect(Object.keys(r).filter((k) => k.startsWith('GET'))).toHaveLength(3);
  });
});

describe('grades SC_10004B00_01', () => {
  it('reads every column id of the real table (8 hidden) and no rows from the shape fixture', () => {
    const html = fixture('lcu-grades-shape-SC_10004B00_01.html');
    const cols = gradeTableColumns(html);
    expect(cols).toHaveLength(21);
    expect(cols.filter((c) => (GRADE_COLUMNS as readonly string[]).includes(c))).toEqual([
      ...GRADE_COLUMNS,
    ]);
    expect(cols.filter((c) => (GRADE_HIDDEN_COLUMNS as readonly string[]).includes(c))).toEqual([
      ...GRADE_HIDDEN_COLUMNS,
    ]);
    expect(parseGrades(html)).toEqual([]);
    expect(gradeViewKind(html)).toBe('earned');
    expect(selectedOption(html, 'requirementTypeCode')).toEqual({
      value: '01',
      label: '卒業要件（学士課程）',
    });
  });

  it('parses every attempt with the verbatim evaluation, its outcome, year and term', () => {
    const html = fixture('lcu-grades-SC_10004B00_01.synthetic.html');
    const rows = parseGrades(html);
    expect(rows).toHaveLength(14);
    // A course failed three times: three rows, one per year.
    const intro = rows.filter((r) => r.subjectCode === '90000001');
    expect(intro.map((r) => [r.academicYear, r.term, r.mark, r.outcome])).toEqual([
      [2024, '前期', '不可', 'failed'],
      [2025, '前期', '不可', 'failed'],
      [2026, '前期', '不可', 'failed'],
    ]);
    expect(intro[0]).toMatchObject({
      subjectName: 'サンプル入門',
      credits: 2,
      score: 9,
      gradePoint: 0,
      markCode: '05',
      markHighlighted: true,
      termPart: '前期後半',
      reportTerm: '2024年度 前期 前期後半',
      reportDate: '2024/08/20',
      examType: '本試験',
      examTypeCode: '1',
      category: '必修',
      categoryOrder: 1001,
      creditType: '必',
      creditTypeCode: '1',
      staffName: '教員 一郎',
    });
    const byMark = Object.fromEntries(rows.map((r) => [r.mark, r.outcome]));
    expect(byMark).toEqual({
      不可: 'failed',
      優: 'passed',
      合: 'passed',
      否: 'failed',
      秀: 'passed',
      良: 'passed',
      再試: 'not_graded',
      認定: 'transferred',
      評価保留中: 'unknown',
    });
    // 成績マーカー: stripped from the title, explained by the marker table.
    const online = rows.find((r) => r.subjectCode === '90000003');
    expect(online).toMatchObject({
      subjectName: 'オンライン教養',
      markers: [{ symbol: '+', label: 'オンライン科目' }],
    });
    expect(online?.score).toBeUndefined();
    expect(parseGradeMarkers(html)).toEqual([
      { symbol: '+', label: 'オンライン科目', capCredits: 10, totalCredits: 2 },
    ]);
    expect(rows.find((r) => r.examType === '再試験')).toMatchObject({ mark: '不可' });
    expect(rows.find((r) => r.mark === '認定')?.replacedSubjectName).toBe('サンプル検定');
    expect(JSON.stringify(rows)).not.toContain('S0000000');
    expect(JSON.stringify(rows)).not.toContain('学生 太郎');
  });

  it('reads the 履修中含む view: registered courses without a mark and interim results', () => {
    const html = fixture('lcu-grades-inprogress-SC_10004B00_01.synthetic.html');
    expect(gradeViewKind(html)).toBe('includingInProgress');
    const rows = parseGrades(html);
    expect(rows).toHaveLength(16);
    expect(rows.find((r) => r.subjectCode === '90000011')).toMatchObject({
      outcome: 'in_progress',
      academicYear: 2026,
      term: '後期',
    });
    expect(rows.find((r) => r.subjectCode === '90000011')?.mark).toBeUndefined();
    expect(rows.find((r) => r.subjectCode === '90000012')).toMatchObject({
      mark: '良',
      interim: true,
      outcome: 'in_progress',
    });
  });

  it('splits report terms and markers', () => {
    expect(parseLcuReportTerm('2025年度 後期 後期前半')).toEqual({
      academicYear: 2025,
      term: '後期',
      termPart: '後期前半',
    });
    expect(parseLcuReportTerm('2026前期')).toEqual({ academicYear: 2026, term: '前期' });
    expect(parseLcuReportTerm('')).toEqual({});
    expect(splitGradeMarkers('+＊科目', [{ symbol: '+', label: 'オンライン科目' }])).toEqual({
      title: '科目',
      markers: [{ symbol: '+', label: 'オンライン科目' }, { symbol: '＊' }],
    });
    expect(splitGradeMarkers('+')).toEqual({ title: '+', markers: [] });
  });
});

describe('単位修得情報 SC_10004B00_02', () => {
  it('reads the requirement tree with depth, required / expected credits and course results', () => {
    const req = parseCreditRequirements(
      fixture('lcu-credit-requirements-SC_10004B00_02.synthetic.html'),
    );
    expect(req?.requirementType).toEqual({ code: '01', name: '卒業要件（学士課程）' });
    expect(req?.rows.map((r) => [r.depth, r.name, r.required, r.expected, r.status])).toEqual([
      [0, '卒業要件（学士課程）', 124, 30, '不足'],
      [0, '教養科目', 30, 8, '不足'],
      [1, '教養基礎科目', 10, 4, '不足'],
      [2, '教養基礎科目', undefined, 4, undefined],
      [3, 'サンプル基礎', 2, 2, '充足'],
      [3, 'サンプル選択群', 4, 0, '不足'],
      [0, '専門科目', 94, 22, '不足'],
      [1, '学科専門科目／必修', 40, 22, '不足'],
      [2, '学科専門科目／必修', undefined, 22, undefined],
      [3, '必修', 40, 22, '不足'],
    ]);
    const group = req?.rows.find((r) => r.name === 'サンプル選択群');
    expect(group?.creditType).toBe('選必');
    expect(group?.courses).toEqual([
      { title: 'サンプル統計', creditType: '選必', credits: 2 },
      { title: 'サンプル選択Ａ', creditType: '選必', credits: 2, status: '不合格' },
      { title: 'サンプル選択Ｂ', creditType: '選必', credits: 2 },
    ]);
    expect(req?.rows.find((r) => r.name === 'サンプル基礎')?.courses[0]).toMatchObject({
      title: 'オンライン教養',
      markers: [{ symbol: '+' }],
      status: '合格',
    });
  });

  it('returns undefined for a page without the requirement table', () => {
    expect(parseCreditRequirements('<main><p>no table</p></main>')).toBeUndefined();
  });
});

describe('login / error page detection', () => {
  it('detects the login screen', () => {
    expect(classifyPage(fixture('lcu-login-SC_01001B00_01.html'), CLASSIFY).kind).toBe('login');
  });

  it('detects the error screen', () => {
    expect(classifyPage(fixture('lcu-error.synthetic.html'), CLASSIFY).kind).toBe('error');
    expect(
      classifyPage('<html><head><title>error</title></head><body></body></html>', CLASSIFY).kind,
    ).toBe('error');
  });

  it('detects CSRF failures and normal screens', () => {
    expect(classifyPage('<p>CSRFトークンの検証に失敗しました</p>', CLASSIFY).kind).toBe('csrf');
    expect(classifyPage(fixture('lcu-timetable-SC_18001B00_13.html'), CLASSIFY).kind).toBe('ok');
  });

  it('extracts the tokens of the latest page', () => {
    expect(extractTokens(fixture('lcu-login-SC_01001B00_01.html'))).toEqual({
      csrf: 'REDACTED',
      transactionToken: undefined,
    });
    expect(
      extractTokens(
        '<form><input type="hidden" name="_csrf" value="a"><input type="hidden" name="_TRANSACTION_TOKEN" value="b"></form>',
      ),
    ).toEqual({ csrf: 'a', transactionToken: 'b' });
  });

  it('handles screen ids and ;jsessionid= rewriting', () => {
    expect(screenIdFromUrl('https://x/lcu-web/SC_17001B00_01;jsessionid=ABC')).toBe(
      'SC_17001B00_01',
    );
    expect(stripJsessionid('https://x/lcu-web/SC_14002B00_01;jsessionid=ABC?x=1')).toEqual({
      url: 'https://x/lcu-web/SC_14002B00_01?x=1',
      jsessionid: 'ABC',
    });
  });
});

describe('embedded calendar events (SC_18001B00_01)', () => {
  it('extracts the events literal without eval', () => {
    const r = parseCalendarEvents(fixture('lcu-scheduler-SC_18001B00_01.synthetic.html'));
    expect(r.error).toBeUndefined();
    expect(r.events.map((e) => [e.title, e.start, e.listType])).toEqual([
      ['スポーツの日', '2026-10-12', 'Holiday'],
      ['後期授業開始', '2026-10-01', 'teachingevent'],
      ["学内行事 '説明会'", '2026-10-02T13:00:00', 'teachingevent'],
    ]);
  });

  it('refuses non-literal values instead of evaluating them', () => {
    const r = parseCalendarEvents("<script>x({ events: [{ title: 'a', start: foo() }] })</script>");
    expect(r.events).toEqual([]);
    expect(r.error).toMatch(/non-literal/);
    expect(findEventsLiteral('nothing here')).toBeUndefined();
    expect(
      JSON.parse(jsLiteralToJson("{a: 'x', 'b': [1, 2,], c: true, /* c */ d: null,}")),
    ).toEqual({
      a: 'x',
      b: [1, 2],
      c: true,
      d: null,
    });
  });
});

describe('exam timetable SC_18001B00_19', () => {
  it('parses rows', () => {
    const rows = parseExamTimetable(fixture('lcu-exam-timetable-SC_18001B00_19.synthetic.html'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      subject: '情報理論(1クラス)',
      date: '2026/07/30(木)',
      period: '3・4',
      room: '共通講義棟２１',
      teacher: '教員 花子',
    });
  });

  it('returns [] for 「対象の科目はありません」', () => {
    expect(
      parseExamTimetable(fixture('lcu-exam-timetable-empty-SC_18001B00_19.synthetic.html')),
    ).toEqual([]);
  });
});

describe('attendance SC_13002B00_01', () => {
  it('reads counts per course', () => {
    const rows = parseAttendance(fixture('lcu-attendance-SC_13002B00_01.synthetic.html'));
    expect(rows).toEqual([
      {
        subject: '情報理論',
        subjectCode: '77401100',
        schedule: '前期/木3・4',
        published: '公開中',
        counts: { attended: 12, absent: 1, late: 0, earlyLeave: 0, excused: 0, invalid: 0 },
      },
      {
        subject: 'モデリング',
        subjectCode: '77451100',
        schedule: '前期後半/水1・2',
        published: '公開中',
        counts: { attended: 7, absent: 0, late: 1, earlyLeave: 0, excused: 0, invalid: 0 },
      },
    ]);
  });
});

describe('text conventions', () => {
  it('maps LCU period labels to pair indexes', () => {
    expect(periodFromLabel('1・2')).toBe(1);
    expect(periodFromLabel('13・14')).toBe(7);
    expect(periodFromLabel('5')).toBe(3);
    expect(periodFromLabel('x')).toBeUndefined();
  });

  it('parses subject text with slots', () => {
    const s = parseSubjectText(
      '機械語と計算機械\r\n前期前半/金5・6, 前期前半/金7・8, 前期後半/金5・6',
    );
    expect(s?.title).toBe('機械語と計算機械');
    expect(s?.slots.map((x) => [x.dayOfWeek, x.period])).toEqual([
      [5, 3],
      [5, 4],
      [5, 3],
    ]);
    expect(uniquePeriodOnDay(s?.slots ?? [], 5)).toBeUndefined();
    const t = parseSubjectText('論理回路\r\n前期前半/月9・10, 前期後半/月9・10');
    expect(uniquePeriodOnDay(t?.slots ?? [], 1)).toBe(5);
    expect(parseSubjectText('コンピュータネットワーク(1クラス)\n前期後半/月1・2')).toMatchObject({
      title: 'コンピュータネットワーク',
      className: '1クラス',
    });
  });

  it('extracts the new room from 講義室変更 titles', () => {
    expect(extractRoomChange('7/24(金) B班の教室を科学実験室から共41に変更します')).toEqual({
      to: '共41',
      from: '科学実験室',
    });
    expect(extractRoomChange('本日の教室は共通講義棟21です')?.to).toBe('共通講義棟21');
    expect(extractRoomChange('第5回の講義について')).toBeUndefined();
  });
});

describe('version fingerprint', () => {
  it('collects plugin folder versions (ignoring vX.X.X)', () => {
    const v = collectPluginVersions(fixture('lcu-login-SC_01001B00_01.html'));
    expect(v).toMatchObject({
      jquery: '3.5.1',
      'jquery-ui': '1.12.1',
      datatables: '1.10.20',
      modaal: '0.4.4',
      dropzone: '5.7.0',
      'smooth-scroll': '16.1.2',
    });
    expect(Object.keys(v)).not.toContain('toastr');
  });

  it('matches the tested fingerprint on the observed pages', () => {
    expect(pluginFingerprint(fixture('lcu-login-SC_01001B00_01.html'))).toBe(TESTED_FINGERPRINT);
    expect(pluginFingerprint(fixture('lcu-home-SC_01002B00_00.synthetic.html'))).toBe(
      TESTED_FINGERPRINT,
    );
    expect(pluginFingerprint('<p>no plugins</p>')).toBeUndefined();
  });
});
