import { describe, expect, it } from 'vitest';
import { dedupeCitations, describeLocation } from '../src/lib/citation.js';

describe('describeLocation', () => {
  it('describes page, timestamp and message id without ASCII/Japanese spacing', () => {
    expect(describeLocation({ page: 3 })).toBe('3ページ');
    expect(describeLocation({ timestamp: '00:42:18' })).toBe('00:42:18');
    expect(describeLocation({ messageId: '3812' })).toBe('メッセージ3812');
    expect(describeLocation({ page: 2, line: 14 })).toBe('2ページ、14行目');
  });
  it('is empty when nothing is known', () => {
    expect(describeLocation(undefined)).toBe('');
    expect(describeLocation({})).toBe('');
  });
});

describe('dedupeCitations', () => {
  it('keeps the first citation per source reference', () => {
    const list = [
      { sourceReferenceId: 'a', label: '1' },
      { sourceReferenceId: 'b', label: '2' },
      { sourceReferenceId: 'a', label: '3' },
    ];
    expect(dedupeCitations(list).map((c) => c.label)).toEqual(['1', '2']);
    expect(dedupeCitations(undefined)).toEqual([]);
  });
});
