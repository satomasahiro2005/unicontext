import type { UniContext } from '@unicontext/context-engine';
import type { Logger } from '@unicontext/core';
import type { Citation } from '@unicontext/provenance';
import { z } from 'zod';

export const NOTIFICATION_KINDS = [
  'room_change',
  'class_cancelled',
  'new_assignment',
  'deadline_changed',
  'deadline_approaching',
  'exam_announced',
  'important_announcement',
  'auth_expired',
  'sync_failure',
  'conflict',
  'schema_drift',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Most urgent first. */
export const PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;
export type NotificationPriority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS_JA: Record<NotificationPriority, string> = {
  critical: '緊急',
  high: '重要',
  normal: '通常',
  low: '低',
};

/**
 * Sort comparator: negative when `a` is more urgent than `b`, so
 * `list.sort((x, y) => comparePriority(x.priority, y.priority))` puts critical first.
 */
export function comparePriority(a: NotificationPriority, b: NotificationPriority): number {
  return PRIORITIES.indexOf(a) - PRIORITIES.indexOf(b);
}

/** True when `priority` is at least as urgent as `min`. */
export function meetsPriority(priority: NotificationPriority, min: NotificationPriority): boolean {
  return comparePriority(priority, min) <= 0;
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  priority: NotificationPriority;
  title: string;
  body: string;
  /** ISO 8601 */
  createdAt: string;
  dedupeKey: string;
  sourceId?: string;
  entityId?: string;
  courseOfferingId?: string;
  citations: Citation[];
  read?: boolean;
}

export interface NotificationSink {
  readonly id: string;
  send(n: Notification): Promise<void> | void;
}

/** The slice of UniContext the notification service needs. */
export type NotificationHost = Pick<
  UniContext,
  'bus' | 'context' | 'clock' | 'timezone' | 'db' | 'sync'
>;

export interface NotificationServiceOptions {
  uc: NotificationHost;
  sinks: NotificationSink[];
  /** JSONL path. Omit for an in-memory log. */
  logFile?: string;
  /** Notifications below this priority are dropped (not logged, not sent). Default 'low'. */
  minPriority?: NotificationPriority;
  /** Durations such as '24h', '3h' (core parseDuration). Default ['24h', '3h', '1h']. */
  deadlineLeadTimes?: string[];
  /** Default 5 minutes. */
  deadlineCheckIntervalMs?: number;
  logger?: Logger;
  /** Suppression window for repeating kinds (sync_failure, auth_expired, conflict). Default 6 hours. */
  dedupeWindowMs?: number;
}

const CitationLikeSchema = z.custom<Citation>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { label?: unknown }).label === 'string' &&
    typeof (v as { sourceSystem?: unknown }).sourceSystem === 'string',
);

export const NotificationSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(NOTIFICATION_KINDS),
  priority: z.enum(PRIORITIES),
  title: z.string(),
  body: z.string(),
  createdAt: z.string().min(1),
  dedupeKey: z.string().min(1),
  sourceId: z.string().optional(),
  entityId: z.string().optional(),
  courseOfferingId: z.string().optional(),
  citations: z.array(CitationLikeSchema).default([]),
  read: z.boolean().optional(),
});
