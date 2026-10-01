import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { JsonValueSchema, type Fact, type JsonValue } from '@unicontext/canonical-model';
import {
  NotFoundError,
  PolicyViolationError,
  systemClock,
  ValidationError,
  type Clock,
} from '@unicontext/core';
import type { UniContext } from '@unicontext/context-engine';
import { z } from 'zod';

/*
 * Propose -> confirm -> execute (§50). An AI client (the MCP server) may only create a Proposal.
 * The user confirms it from another process (`unicontext confirm <id>` or the Web UI), which calls
 * applyProposal(). Proposals are one JSON file each so the stdio MCP process and the daemon/CLI,
 * which are different processes, share them without a database lock.
 */

/**
 * High-risk predicates (§51): grades, submissions and enrolment. Matched per word so `final_grade`,
 * `courseGrade` or `assignment.submission` are caught, not only a leading `grade`.
 */
const HIGH_RISK_WORDS =
  /^(grades?|grading|gpa|scores?|submissions?|submit|submitted|enrol|enroll|enrolment|enrollment|enrolled|registration|register|registered)$/i;

/** Entity kinds whose facts an AI proposal may never touch (§51). */
export const HIGH_RISK_SUBJECT_KINDS: ReadonlySet<string> = new Set(['grade', 'submission']);

export function isHighRiskPredicate(predicate: string): boolean {
  if (/^(grade|submission|enrol)/i.test(predicate)) return true;
  return predicate
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_.-]+/)
    .some((w) => HIGH_RISK_WORDS.test(w));
}

function isHighRiskProposal(p: Pick<Proposal, 'subject' | 'predicate'>): boolean {
  const colon = p.subject.indexOf(':');
  const kind = colon > 0 ? p.subject.slice(0, colon) : '';
  return isHighRiskPredicate(p.predicate) || HIGH_RISK_SUBJECT_KINDS.has(kind);
}

export type ProposalStatus = 'pending' | 'confirmed' | 'rejected' | 'expired';

export interface Proposal {
  id: string;
  kind: 'correct_fact';
  status: ProposalStatus;
  createdAt: string;
  expiresAt: string;
  preview: string;
  subject: string;
  predicate: string;
  value: JsonValue;
  /** Always present so a Proposal is assignable to the daemon's ProposalView. */
  note: string | undefined;
  createdBy: string;
}

export interface CreateProposalInput {
  kind: 'correct_fact';
  subject: string;
  predicate: string;
  value: JsonValue;
  note?: string;
  createdBy: string;
  preview: string;
}

export const DEFAULT_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

const ProposalSchema = z.object({
  id: z.string(),
  kind: z.literal('correct_fact'),
  status: z.enum(['pending', 'confirmed', 'rejected', 'expired']),
  createdAt: z.string(),
  expiresAt: z.string(),
  preview: z.string(),
  subject: z.string(),
  predicate: z.string(),
  value: JsonValueSchema,
  note: z.string().optional(),
  createdBy: z.string(),
});

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class ProposalStore {
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(
    readonly dir: string,
    opts: { clock?: Clock; ttlMs?: number } = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.ttlMs = opts.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS;
  }

  create(input: CreateProposalInput): Proposal {
    mkdirSync(this.dir, { recursive: true });
    const id = this.newId();
    const now = this.clock.now();
    const proposal: Proposal = {
      id,
      kind: input.kind,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      preview: input.preview,
      subject: input.subject,
      predicate: input.predicate,
      value: input.value,
      note: input.note || undefined,
      createdBy: input.createdBy,
    };
    this.write(proposal);
    return proposal;
  }

  private newId(): string {
    for (;;) {
      const id = `p_${randomBytes(5).toString('hex')}`;
      if (!existsSync(this.file(id))) return id;
    }
  }

  get(id: string): Proposal | undefined {
    if (!ID_PATTERN.test(id)) return undefined;
    const raw = this.read(this.file(id));
    return raw ? this.expireIfDue(raw) : undefined;
  }

  list(options: { status?: ProposalStatus } = {}): Proposal[] {
    if (!existsSync(this.dir)) return [];
    const out: Proposal[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const raw = this.read(path.join(this.dir, name));
      if (!raw) continue;
      const p = this.expireIfDue(raw);
      if (!options.status || p.status === options.status) out.push(p);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  markConfirmed(id: string): Proposal {
    return this.transition(id, 'confirmed');
  }

  reject(id: string): Proposal {
    return this.transition(id, 'rejected');
  }

  private transition(id: string, to: 'confirmed' | 'rejected'): Proposal {
    const p = this.get(id);
    if (!p) throw new NotFoundError(`proposal ${id}`);
    if (p.status !== 'pending')
      throw new ValidationError(`proposal ${id} is ${p.status}, not pending`);
    const next: Proposal = { ...p, status: to };
    this.write(next);
    return next;
  }

  private expireIfDue(p: Proposal): Proposal {
    if (p.status !== 'pending') return p;
    if (this.clock.now().getTime() < new Date(p.expiresAt).getTime()) return p;
    const expired: Proposal = { ...p, status: 'expired' };
    this.write(expired);
    return expired;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private read(file: string): Proposal | undefined {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = ProposalSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return undefined;
      const { note, ...rest } = parsed.data;
      return { ...rest, note };
    } catch {
      return undefined;
    }
  }

  /** Atomic: write a temp file in the same directory, then rename over the target. */
  private write(p: Proposal): void {
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(p.id);
    const tmp = path.join(this.dir, `.${p.id}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        renameSync(tmp, target);
        return;
      } catch (e) {
        lastError = e;
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
        // Windows: the target may be open in another process for a moment.
        const until = Date.now() + 20 * (attempt + 1);
        while (Date.now() < until) {
          /* brief busy wait; renames are rare and tiny */
        }
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw lastError;
  }
}

/**
 * User-initiated execution of a proposal (§50, §74): only the user's own surface (CLI/Web UI) calls
 * this. Stores the value as an origin=user fact and marks the proposal confirmed.
 */
export function applyProposal(
  uc: UniContext,
  store: ProposalStore,
  id: string,
): { proposal: Proposal; fact: Fact } {
  const proposal = store.get(id);
  if (!proposal) throw new NotFoundError(`proposal ${id}`);
  if (proposal.status !== 'pending')
    throw new ValidationError(
      proposal.status === 'expired'
        ? `proposal ${id} has expired; ask the assistant to propose it again`
        : `proposal ${id} is already ${proposal.status}`,
    );
  // Defence in depth: the MCP tool already refuses these, but a proposal file is plain JSON in the
  // data dir, so the high-risk rule (§51) is enforced again where it is executed.
  if (isHighRiskProposal(proposal))
    throw new PolicyViolationError(
      `proposal ${id} touches grades, submissions or enrolment, which cannot be applied from a proposal (§51)`,
    );
  const { fact } = uc.resolver.correct({
    subject: proposal.subject,
    predicate: proposal.predicate,
    value: proposal.value,
    ...(proposal.note ? { note: proposal.note } : {}),
  });
  // Self-study slots (pace_slots) decide which weekly 「今週分」 tasks exist.
  if (proposal.predicate === 'pace_slots') {
    uc.identity.invalidate();
    uc.tasks.derive();
  }
  return { proposal: store.markConfirmed(id), fact };
}
