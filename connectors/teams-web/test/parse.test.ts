import { describe, expect, it } from 'vitest';
import {
  attachments,
  cjkName,
  decodeAssignmentCard,
  driveFolder,
  mentions,
  messageText,
  parseCardDue,
  parseClassTeamName,
  routeDecision,
  scrubSecrets,
  scrubUrl,
  uniqueIdFromEtag,
} from '../src/index.js';
import { call as callScript } from '../src/page-scripts.js';
import { CARD_ASSIGNMENT, CH_MATERIALS, CLASS_GROUP, fixture, TEAM_ID } from './helpers.js';

describe('class team names', () => {
  it.each([
    ['2026データベース演習X', 'データベース演習X', 2026, undefined],
    ['2026-計算理論', '計算理論', 2026, undefined],
    ['演習2024情報学科', '演習 情報学科', 2024, undefined],
    ['統計学2024', '統計学', 2024, undefined],
    ['2024プログラミング基礎(情報科)', 'プログラミング基礎', 2024, '情報科'],
    ['2025年度 線形代数（A組）', '線形代数', 2025, 'A組'],
    ['ゼミ', 'ゼミ', undefined, undefined],
  ])('%s → %s (%s, %s)', (name, title, year, section) => {
    expect(parseClassTeamName(name)).toEqual({ title, academicYear: year, section });
  });

  it('keeps the CJK part of romanized display names', () => {
    expect(cjkName('Kyoin Hanako (教員 花子)')).toBe('教員 花子');
    expect(cjkName('教員 花子')).toBe('教員 花子');
    expect(cjkName('Hanako Kyoin')).toBeUndefined();
    expect(cjkName(undefined)).toBeUndefined();
  });
});

describe('secrets never leave the page', () => {
  it('drops download URLs and token keys, strips authenticating query parameters', () => {
    const out = scrubSecrets({
      name: 'a.pdf',
      '@content.downloadUrl': 'https://x.sharepoint.com/download.aspx?tempauth=abc',
      nested: [{ skypetoken: 'x', url: 'https://x.sharepoint.com/f.pdf?tempauth=abc&web=1' }],
      syncToken: 'x',
      accessToken: 'y',
    });
    expect(out).toEqual({
      name: 'a.pdf',
      nested: [{ url: 'https://x.sharepoint.com/f.pdf?web=1' }],
    });
    expect(scrubUrl('https://h/p?token=1&sig=2&a=b')).toBe('https://h/p?a=b');
    expect(scrubUrl('not a url ?token=1')).toBe('not a url ?token=1');
    // inside JSON strings and HTML
    expect(
      scrubSecrets({ files: '[{"fileInfo":{"fileUrl":"https://h/a.pdf?tempauth=x"}}]' }),
    ).toEqual({
      files: '[{"fileInfo":{"fileUrl":"https://h/a.pdf"}}]',
    });
    expect(scrubSecrets('<a href="https://h/a.pdf?tempauth=x&web=1">a</a>')).toBe(
      '<a href="https://h/a.pdf?web=1">a</a>',
    );
  });
});

describe('message content', () => {
  const chains =
    fixture<Record<string, { messages: Record<string, unknown>[] }[]>>('client-replychains.json');
  const root = chains[CH_MATERIALS]?.[0]?.messages[0] as {
    content: string;
    properties: { files: string; mentions: unknown };
  };

  it('turns HTML into text, keeping mention names', () => {
    const text = messageText(root.content);
    expect(text).toContain('00_講義資料 に第1回の資料を置きました。');
    expect(text).toContain('week1.pdf');
    expect(text).not.toMatch(/<|>/);
    expect(
      messageText(
        '<p>図<img src="https://jp-prod.asyncgw.teams.microsoft.com/v1/objects/x/views/imgo"></p>',
      ),
    ).toBe('図 [画像]');
  });

  it('reads attachments (JSON string) and mentions (array or JSON string)', () => {
    expect(attachments(root.properties.files)).toEqual([
      {
        name: 'week1.pdf',
        fileType: 'pdf',
        url: 'https://example.sharepoint.com/sites/2026X_abc123/Shared%20Documents/00_%E8%AC%9B%E7%BE%A9%E8%B3%87%E6%96%99/week1.pdf',
        uniqueId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
      },
    ]);
    expect(mentions(root.properties.mentions)).toEqual([
      { type: 'channel', name: '00_講義資料', mri: CH_MATERIALS },
    ]);
    expect(mentions('[{"mentionType":"person","displayName":"A","mri":"8:orgid:x"}]')).toEqual([
      { type: 'person', name: 'A', mri: '8:orgid:x' },
    ]);
    expect(attachments(undefined)).toEqual([]);
  });

  it('decodes the Assignments bot card', () => {
    const card = chains[TEAM_ID]?.[0]?.messages[0] as { content: string };
    const decoded = decodeAssignmentCard(card.content);
    expect(decoded).toMatchObject({
      title: '第2回レポート（合成）',
      dueText: '期限 10月9日',
      classId: CLASS_GROUP,
      assignmentId: CARD_ASSIGNMENT,
    });
    expect(decodeAssignmentCard('<p>no card</p>')).toBeUndefined();
  });

  it('gives the card due date a year and a time', () => {
    expect(parseCardDue('期限 10月9日', '2026-09-30T00:00:00Z', 'Asia/Tokyo')).toBe(
      '2026-10-09T14:59:00.000Z',
    );
    // posted in December, due in February → next year
    expect(parseCardDue('期限 2月7日', '2024-12-05T23:00:00Z', 'Asia/Tokyo')).toBe(
      '2025-02-07T14:59:00.000Z',
    );
    expect(parseCardDue('期限 7月22日 17:00', '2024-07-16T06:00:00Z', 'Asia/Tokyo')).toBe(
      '2024-07-22T08:00:00.000Z',
    );
    expect(parseCardDue('期限なし', '2024-07-16T06:00:00Z', 'Asia/Tokyo')).toBeUndefined();
  });
});

describe('files', () => {
  it('reads folders and unique ids from drive items', () => {
    expect(driveFolder('/drive/root:/00_%E8%AC%9B%E7%BE%A9%E8%B3%87%E6%96%99/sub')).toBe(
      '00_講義資料/sub',
    );
    expect(driveFolder('/drive/root:')).toBe('');
    expect(uniqueIdFromEtag('"{5B6C7D8E-9F0A-4B1C-8D2E-3F4A5B6C7D8E},3"')).toBe(
      '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
    );
  });
});

describe('read-only request policy', () => {
  it.each([
    ['GET', 'https://teams.cloud.microsoft/api/csa/apac/api/v1/containers/x/posts', 'continue'],
    ['POST', 'https://login.microsoftonline.com/t/oauth2/v2.0/token', 'continue'],
    ['POST', 'https://teams.microsoft.com/api/authsvc/v1.0/authz', 'continue'],
    ['POST', 'https://jp-prod.asyncgw.teams.microsoft.com/v1/skypetokenauth', 'continue'],
    [
      'POST',
      'https://teams.cloud.microsoft/api/mt/apac/beta/users/fetchShortProfile?x=1',
      'continue',
    ],
    ['POST', 'https://teams.cloud.microsoft/ups/apac/v1/presence/getpresence/', 'continue'],
    ['POST', 'https://example.sharepoint.com/_forms/default.aspx', 'continue'],
    ['POST', 'https://idp.example.ac.jp/idp/profile/SAML2/POST/SSO', 'continue'],
    // marking a channel read
    [
      'PUT',
      'https://teams.cloud.microsoft/api/chatsvc/jp/v1/users/ME/conversations/19%3Ax/properties?name=consumptionhorizon',
      'abort',
    ],
    // posting a message, reacting, presence, joining, turning in, telemetry
    [
      'POST',
      'https://teams.cloud.microsoft/api/chatsvc/jp/v1/users/ME/conversations/19%3Ax/messages',
      'abort',
    ],
    [
      'PUT',
      'https://teams.cloud.microsoft/api/chatsvc/jp/v1/users/ME/conversations/19%3Ax/messages/1/properties?name=emotions',
      'abort',
    ],
    ['PUT', 'https://teams.cloud.microsoft/ups/apac/v1/me/forceavailability/', 'abort'],
    ['POST', 'https://teams.cloud.microsoft/api/mt/apac/v1/sharetoteams/installApp', 'abort'],
    [
      'POST',
      'https://assignments.edu.cloud.microsoft/api/v1.0/edu/classes/c/assignments/a/submissions/s/submit',
      'abort',
    ],
    ['PATCH', 'https://example.sharepoint.com/sites/s/_api/v2.0/drive/items/1', 'abort'],
    ['POST', 'https://example.sharepoint.com/sites/s/_api/search/postquery', 'abort'],
    ['POST', 'https://browser.events.data.microsoft.com/OneCollector/1.0/', 'abort'],
    ['POST', 'https://teams.cloud.microsoft/registrar/prod/V2/registrations', 'abort'],
  ])('%s %s → %s', (method, url, expected) => {
    expect(routeDecision(method, url)).toBe(expected);
  });
});

describe('page scripts', () => {
  it('wraps a script into an evaluate expression with a JSON argument', () => {
    expect(callScript('(x) => x', { a: '"' })).toBe('((x) => x)({"a":"\\""})');
  });
});
