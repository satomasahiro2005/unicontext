import { describe, expect, it } from 'vitest';
import { buildEnvelope, collect } from '../src/index.js';

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
