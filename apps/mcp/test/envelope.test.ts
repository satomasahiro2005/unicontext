import { describe, expect, it } from 'vitest';
import { buildEnvelope, collect, compactEnvelope } from '../src/index.js';
import { TOP_CITATIONS } from '../src/envelope.js';

const cite = (id: string, label: string, retrievedAt = '2026-10-01T00:42:00.000Z') => ({
  sourceReferenceId: id,
  sourceSystem: 'x',
  sourceLabel: label,
  authority: 'academic-system',
  sourceItemId: id,
  retrievedAt,
  url: undefined,
  location: undefined,
  rawItemId: undefined,
  label: `${label} 10/1 09:42取得`,
});

const conflictValue = {
  value: '21',
  status: 'conflict',
  origin: 'authoritative',
  method: 'recency',
  candidates: [
    {
      value: '情報学部2号館21教室',
      source: '学務情報システム',
      citation: cite('a', '学務情報システム'),
    },
    { value: '情報学部2号館11教室', source: 'Teams', citation: cite('b', 'Teams') },
  ],
};

describe('envelope', () => {
  it('collects citations anywhere and de-duplicates them', () => {
    const e = buildEnvelope({
      items: [{ citations: [cite('a', 'A'), cite('b', 'B')] }, { citations: [cite('a', 'A')] }],
      nested: { deep: { candidate: { citation: cite('c', 'C') } } },
    });
    expect(e.citations.map((c) => c.sourceReferenceId).sort()).toEqual(['a', 'b', 'c']);
    expect(e.answerHint).toContain('根拠:');
  });

  it('turns a conflicting ResolvedValue into a plain Japanese notice', () => {
    const { conflicts } = collect({
      classes: [{ course: { title: 'DB論' }, room: conflictValue }],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('「DB論」の教室');
    expect(conflicts[0]).toContain(
      '情報学部2号館21教室（学務情報システム）と情報学部2号館11教室（Teams）が食い違っています',
    );
    expect(conflicts[0]).toContain('断定せず');
  });

  it('handles ConflictItem and does not report resolved values', () => {
    const { conflicts } = collect({
      conflicts: [
        {
          id: 'c1',
          subject: 's',
          subjectLabel: 'DB論',
          predicate: 'room',
          candidates: conflictValue.candidates,
          note: 'n',
        },
      ],
      room: { value: 'x', status: 'resolved', candidates: conflictValue.candidates },
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('教室');
  });

  it('says so when there is nothing to cite and mentions conflicts in the hint', () => {
    expect(buildEnvelope({ a: 1 }).answerHint).toContain('見つかりませんでした');
    expect(buildEnvelope({ room: conflictValue }).answerHint).toContain('食い違い');
  });

  it('makes data JSON-safe (undefined dropped)', () => {
    const e = buildEnvelope({ a: undefined, b: 1 });
    expect(e.data).toEqual({ b: 1 });
    expect('a' in (e.data as object)).toBe(false);
  });
});

describe('compactEnvelope (what AI clients receive)', () => {
  const withUrl = (id: string, label: string) => ({ ...cite(id, label), url: `https://x/${id}` });

  it('slims citations, sends each url once, drops settled candidates and caps the top list', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      title: `item${i}`,
      course: { id: 'c', title: 'DB論', linkedIds: ['c', 'd'] },
      room: {
        value: '21',
        status: 'resolved',
        origin: 'authoritative',
        method: 'single',
        candidates: [{ value: '21', citation: withUrl(`r${i}`, 'R') }],
      },
      citations: [withUrl(`a${i}`, 'A'), withUrl('shared', 'S')],
    }));
    const full = buildEnvelope({
      course: { id: 'c', title: 'DB論', linkedIds: ['c', 'd'] },
      items,
      clash: { room: conflictValue },
    });
    const e = compactEnvelope(full);
    const data = e.data as {
      course: { linkedIds?: string[] };
      items: {
        citations: Record<string, unknown>[];
        room: Record<string, unknown>;
        course: Record<string, unknown>;
      }[];
    };
    expect(data.items[0]?.citations[0]).toEqual({
      sourceReferenceId: 'a0',
      label: 'A 10/1 09:42取得',
      url: 'https://x/a0',
    });
    // The same source a second time: id and label only.
    expect(data.items[1]?.citations[1]).toEqual({
      sourceReferenceId: 'shared',
      label: 'S 10/1 09:42取得',
    });
    expect(data.items[0]?.room).toEqual({
      value: '21',
      status: 'resolved',
      origin: 'authoritative',
      method: 'single',
    });
    expect(data.items[0]?.course).toEqual({ id: 'c', title: 'DB論' });
    expect(data.course.linkedIds).toEqual(['c', 'd']);
    expect(e.citations).toHaveLength(TOP_CITATIONS);
    expect(full.citations.length).toBeGreaterThan(TOP_CITATIONS);
    expect(e.answerHint).toContain(`全${full.citations.length}件のうち先頭${TOP_CITATIONS}件`);
    // Disagreements survive: notices and the conflicting candidates with their sources.
    expect(e.conflicts).toEqual(full.conflicts);
    expect(e.conflicts).toHaveLength(1);
    expect(JSON.stringify(e.data)).toContain('情報学部2号館11教室');
    expect(JSON.stringify(e).length).toBeLessThan(JSON.stringify(full).length / 2);
  });
});
