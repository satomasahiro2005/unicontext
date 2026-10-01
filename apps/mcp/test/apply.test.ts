import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stableId } from '@unicontext/canonical-model';
import type { UniContext } from '@unicontext/context-engine';
import { ManualClock, NotFoundError, ValidationError } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyProposal, ProposalStore } from '../src/index.js';
import { createSeeded } from './seeded.js';

let uc: UniContext;
let clock: ManualClock;
let tmp: string;
let store: ProposalStore;
const course = stableId('courseOffering', 'lcu', 'J2401-2026-2');

beforeAll(async () => {
  ({ uc, clock } = await createSeeded());
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-apply-'));
  store = new ProposalStore(path.join(tmp, 'p'), { clock, ttlMs: 60 * 60 * 1000 });
});
afterAll(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

const make = (value: string) =>
  store.create({
    kind: 'correct_fact',
    subject: course,
    predicate: 'room',
    value,
    createdBy: 'mcp:test',
    preview: 'p',
  });

describe('applyProposal (user-initiated execution)', () => {
  it('refuses unknown ids', () => {
    expect(() => applyProposal(uc, store, 'p_unknown')).toThrow(NotFoundError);
  });

  it('refuses rejected proposals and writes no fact', () => {
    const before = uc.resolver.facts.history(course, 'room').length;
    const p = make('情報学部2号館11教室');
    store.reject(p.id);
    expect(() => applyProposal(uc, store, p.id)).toThrow(ValidationError);
    expect(uc.resolver.facts.history(course, 'room').length).toBe(before);
  });

  it('refuses expired proposals (clock-driven) and writes no fact', () => {
    const before = uc.resolver.facts.history(course, 'room').length;
    const p = make('情報学部2号館11教室');
    clock.set(new Date(clock.now().getTime() + 2 * 60 * 60 * 1000).toISOString());
    expect(() => applyProposal(uc, store, p.id)).toThrow(/expired/);
    expect(store.get(p.id)?.status).toBe('expired');
    expect(uc.resolver.facts.history(course, 'room').length).toBe(before);
  });

  it('stores the confirmed value as an origin=user fact and resolves the conflict', () => {
    const p = make('情報学部2号館11教室');
    const { fact, proposal } = applyProposal(uc, store, p.id);
    expect(proposal.status).toBe('confirmed');
    expect(fact.origin).toBe('user');
    expect(fact.producer.type).toBe('user');
    expect(uc.resolver.resolve(course, 'room').value).toBe('情報学部2号館11教室');
    expect(uc.resolver.listConflicts({ status: 'open' }).some((c) => c.predicate === 'room')).toBe(
      false,
    );
  });
});
