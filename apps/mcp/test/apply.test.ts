import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stableId } from '@unicontext/canonical-model';
import type { UniContext } from '@unicontext/context-engine';
import {
  ManualClock,
  NotFoundError,
  PolicyViolationError,
  ValidationError,
} from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyProposal, ProposalStore } from '../src/index.js';
import { isHighRiskPredicate } from '../src/proposals.js';
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

  it('refuses a high-risk proposal written straight into the store (§51) and writes no fact', () => {
    const before = uc.resolver.facts.history(course, 'final_grade').length;
    const p = store.create({
      kind: 'correct_fact',
      subject: course,
      predicate: 'final_grade',
      value: 'S',
      createdBy: 'mcp:test',
      preview: '教室の訂正',
    });
    expect(() => applyProposal(uc, store, p.id)).toThrow(PolicyViolationError);
    expect(store.get(p.id)?.status).toBe('pending');
    expect(uc.resolver.facts.history(course, 'final_grade').length).toBe(before);
    const sub = store.create({
      kind: 'correct_fact',
      subject: 'submission:x',
      predicate: 'status',
      value: 'submitted',
      createdBy: 'mcp:test',
      preview: 'p',
    });
    expect(() => applyProposal(uc, store, sub.id)).toThrow(PolicyViolationError);
  });

  it('isHighRiskPredicate matches per word, not substrings of harmless words', () => {
    for (const p of ['grade', 'final_grade', 'courseGrade', 'assignment.submission', 'enrolled'])
      expect(isHighRiskPredicate(p), p).toBe(true);
    for (const p of ['room', 'assignment_due', 'class_status', 'exam_at', 'upgrade_note'])
      expect(isHighRiskPredicate(p), p).toBe(false);
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
