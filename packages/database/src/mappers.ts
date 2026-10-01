import {
  type Conflict,
  ConflictSchema,
  type Fact,
  FactSchema,
  type IdentityLink,
  IdentityLinkSchema,
  type Task,
  TaskSchema,
} from '@unicontext/canonical-model';
import type { conflicts, facts, identityLinks, tasks } from './schema/records.js';

/** Row <-> record mappers shared by the stores in provenance/identity/task-engine and by JSONL I/O. */

export type FactRow = typeof facts.$inferSelect;
export type ConflictRow = typeof conflicts.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type IdentityLinkRow = typeof identityLinks.$inferSelect;

export function factToRow(f: Fact, createdAt: string): FactRow {
  return {
    id: f.id,
    subject: f.subject,
    predicate: f.predicate,
    valueJson: JSON.stringify(f.value),
    origin: f.origin,
    confidence: f.confidence,
    observedAt: f.observedAt,
    validFrom: f.validFrom ?? null,
    validUntil: f.validUntil ?? null,
    sourceReferenceId: f.sourceReferenceId,
    producerType: f.producer.type,
    producerId: f.producer.id,
    evidence: f.evidence ?? null,
    retractedAt: f.retractedAt ?? null,
    createdAt,
  };
}

export function rowToFact(r: FactRow): Fact {
  return FactSchema.parse({
    id: r.id,
    subject: r.subject,
    predicate: r.predicate,
    value: JSON.parse(r.valueJson) as unknown,
    origin: r.origin,
    confidence: r.confidence,
    observedAt: r.observedAt,
    ...(r.validFrom ? { validFrom: r.validFrom } : {}),
    ...(r.validUntil ? { validUntil: r.validUntil } : {}),
    sourceReferenceId: r.sourceReferenceId,
    producer: { type: r.producerType, id: r.producerId },
    ...(r.evidence ? { evidence: r.evidence } : {}),
    ...(r.retractedAt ? { retractedAt: r.retractedAt } : {}),
  });
}

export function conflictToRow(c: Conflict, updatedAt: string): ConflictRow {
  return {
    id: c.id,
    subject: c.subject,
    predicate: c.predicate,
    status: c.status,
    candidatesJson: JSON.stringify(c.candidates),
    detectedAt: c.detectedAt,
    resolvedAt: c.resolvedAt ?? null,
    resolutionJson: c.resolution ? JSON.stringify(c.resolution) : null,
    reason: c.reason ?? null,
    updatedAt,
  };
}

export function rowToConflict(r: ConflictRow): Conflict {
  return ConflictSchema.parse({
    id: r.id,
    subject: r.subject,
    predicate: r.predicate,
    status: r.status,
    candidates: JSON.parse(r.candidatesJson) as unknown,
    detectedAt: r.detectedAt,
    ...(r.resolvedAt ? { resolvedAt: r.resolvedAt } : {}),
    ...(r.resolutionJson ? { resolution: JSON.parse(r.resolutionJson) as unknown } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  });
}

export function taskToRow(t: Task): TaskRow {
  return {
    id: t.id,
    title: t.title,
    courseOfferingId: t.courseOfferingId ?? null,
    assignmentId: t.assignmentId ?? null,
    examId: t.examId ?? null,
    sourceFactIdsJson: JSON.stringify(t.sourceFactIds),
    dueAt: t.dueAt ?? null,
    status: t.status,
    createdBy: t.createdBy,
    taskKind: t.taskKind,
    origin: t.origin,
    statusSetBy: t.statusSetBy,
    statusEvidenceFactId: t.statusEvidenceFactId ?? null,
    evidence: t.evidence ?? null,
    notes: t.notes ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export function rowToTask(r: TaskRow): Task {
  return TaskSchema.parse({
    id: r.id,
    title: r.title,
    ...(r.courseOfferingId ? { courseOfferingId: r.courseOfferingId } : {}),
    ...(r.assignmentId ? { assignmentId: r.assignmentId } : {}),
    ...(r.examId ? { examId: r.examId } : {}),
    sourceFactIds: JSON.parse(r.sourceFactIdsJson) as unknown,
    ...(r.dueAt ? { dueAt: r.dueAt } : {}),
    status: r.status,
    createdBy: r.createdBy,
    taskKind: r.taskKind,
    origin: r.origin,
    statusSetBy: r.statusSetBy,
    ...(r.statusEvidenceFactId ? { statusEvidenceFactId: r.statusEvidenceFactId } : {}),
    ...(r.evidence ? { evidence: r.evidence } : {}),
    ...(r.notes ? { notes: r.notes } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function linkToRow(l: IdentityLink): IdentityLinkRow {
  return {
    id: l.id,
    entityKind: l.entityKind,
    leftId: l.leftId,
    rightId: l.rightId,
    status: l.status,
    score: l.score,
    method: l.method,
    evidenceJson: JSON.stringify(l.evidence),
    decidedBy: l.decidedBy,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

export function rowToLink(r: IdentityLinkRow): IdentityLink {
  return IdentityLinkSchema.parse({
    id: r.id,
    entityKind: r.entityKind,
    leftId: r.leftId,
    rightId: r.rightId,
    status: r.status,
    score: r.score,
    method: r.method,
    evidence: JSON.parse(r.evidenceJson) as unknown,
    decidedBy: r.decidedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}
