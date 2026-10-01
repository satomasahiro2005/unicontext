import { describe, expect, it } from 'vitest';
import {
  isErrorPage,
  parseCsrf,
  parseDayPeriod,
  parseDetail,
  parseResults,
  splitBilingual,
  yearOfTitle,
} from '../src/index.js';
import { fixture } from './helpers.js';

describe('LCU syllabus parsers', () => {
  it('reads the csrf token of a form and recognizes the error screen', () => {
    expect(parseCsrf(fixture('lcu-syllabus-search-form-SC_06001B00_21.html'))).toBe('REDACTED');
    expect(parseCsrf('<html></html>')).toBeUndefined();
    expect(isErrorPage('<html><head><title>error</title></head></html>')).toBe(true);
    expect(isErrorPage('<p>処理を続行することができませんでした</p>')).toBe(true);
    expect(isErrorPage(fixture('lcu-syllabus-search-result-SC_06001B00_21.html'))).toBe(false);
  });

  it('parses #dataTable01 rows with visible and hidden columns', () => {
    const res = parseResults(fixture('lcu-syllabus-search-result-SC_06001B00_21.html'));
    expect(res.hasTable).toBe(true);
    expect(res.rows).toHaveLength(4);
    const first = res.rows[0]!;
    expect(first.index).toBe(0);
    expect(first.columns).toMatchObject({
      講義名: 'データベースシステム論',
      クラス: '1クラス',
      タイトル: '2026年度　情報学部 [IN-B]',
      科目コード: '77403030',
      ナンバリング: 'IN002160080',
      開講学期: '後期',
      '曜日・時限': '木3・4',
      classCode: '61',
      weekPeriodCode: '42',
    });
    expect(res.rows[1]?.columns['科目コード']).toBe('77501090');
    expect(res.formInputs).toMatchObject({ rowIndex: '', viewRowIndexArray: '' });
    expect(res.csrf).toBe('REDACTED');
  });

  it('reports a missing table', () => {
    expect(parseResults('<form><input name="_csrf" value="x"></form>').hasTable).toBe(false);
  });

  it('parses the detail screen: labels, sections, plan rows and flags', () => {
    const { detail, recognized, description } = parseDetail(
      fixture('lcu-syllabus-detail-SC_06001B00_22.html'),
    );
    expect(recognized).toBeGreaterThan(20);
    expect(description).toContain('2026年度');
    expect(detail).toMatchObject({
      numbering: 'IN002160080',
      name: 'データベースシステム論',
      nameEn: 'Database System',
      className: '1クラス',
      instructors: ['教員 花子'],
      instructorsEn: ['KYOIN Hanako'],
      department: '情報学領域',
      laboratory: 'J0000',
      grade: '2年、3年、4年',
      campus: '（共通）',
      semester: '後期',
      dayPeriod: '木3・4',
      room: '共通講義棟３１',
      requirement: '選必',
      credits: 2,
      delivery: ['対面授業科目'],
      officeHours: '講義終了から１時間',
    });
    expect(detail.slots).toEqual([{ dayOfWeek: 4, period: 2, rawPeriod: '3・4' }]);
    expect(detail.keywords).toEqual([
      '関係データベース',
      'SQL言語',
      'データベース設計',
      'DBMS',
      'ビッグデータとNoSQL',
      '数理データサイエンス科目',
    ]);
    expect(detail.plan).toHaveLength(15);
    expect(detail.plan[0]).toEqual({ no: '1', content: '導入' });
    expect(detail.goals).toContain('リレーショナルデータベース');
    expect(detail.content).toContain('1. ER図');
    expect(detail.textbook).toContain('リレーショナルデータベース入門');
    expect(detail.evaluation).toContain('期末試験');
    // Empty sections and unchecked rows are dropped, nothing leaks into extra.
    expect(detail.activeLearning).toEqual([]);
    expect(detail.practicalExperience).toEqual([]);
    expect(detail.message).toBeUndefined();
    expect(detail.extra).toEqual({});
  });

  it('keeps unknown labels and sections in extra', () => {
    const html = `
      <table class="c-table-line"><tbody>
        <tr><th>科目ナンバリング</th><td><p>X1</p></td></tr>
        <tr><th>新しい項目</th><td><p>値</p></td></tr>
      </tbody></table>
      <div class="c-expand -small"><h3>新しい節</h3><table class="c-table"><tbody><tr><td><p>本文</p></td></tr></tbody></table></div>`;
    const { detail } = parseDetail(html);
    expect(detail.numbering).toBe('X1');
    expect(detail.extra).toEqual({ 新しい項目: '値', 新しい節: '本文' });
  });

  it('maps LCU period pairs to 90-minute period numbers', () => {
    expect(parseDayPeriod('木3・4')).toEqual([{ dayOfWeek: 4, period: 2, rawPeriod: '3・4' }]);
    expect(parseDayPeriod('月1・2,金９・１０')).toEqual([
      { dayOfWeek: 1, period: 1, rawPeriod: '1・2' },
      { dayOfWeek: 5, period: 5, rawPeriod: '9・10' },
    ]);
    expect(parseDayPeriod('火13・14')[0]).toMatchObject({ period: 7 });
    expect(parseDayPeriod('集中')).toEqual([]);
  });

  it('splits bilingual cells and extracts the year of a title', () => {
    expect(splitBilingual('データベース論\n（Database）')).toEqual({
      ja: 'データベース論',
      en: 'Database',
    });
    expect(splitBilingual('数学Ⅲ（微分積分Ｂ）')).toEqual({
      ja: '数学Ⅲ（微分積分Ｂ）',
      en: undefined,
    });
    expect(yearOfTitle('2026年度　情報学部 [IN-B]')).toBe(2026);
    expect(yearOfTitle('情報学部')).toBeUndefined();
  });
});
