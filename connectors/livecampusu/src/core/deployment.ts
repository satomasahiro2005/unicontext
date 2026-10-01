import { ConfigError } from '@unicontext/core';
import { z } from 'zod';

/**
 * What a LiveCampusU deployment looks like to the product logic (§26). Everything that differs
 * between universities — base URL, identity provider, screen ids, endpoint paths, contact type
 * codes, maintenance window — lives in a profile object validated by this schema. `src/core/`
 * never hardcodes a university.
 */

/** How the normalizer treats a contact (連絡) type code. */
export const ContactKindSchema = z.enum([
  'cancellation', // 休講
  'makeup', // 補講
  'exam', // 試験
  'roomChange', // 講義室変更
  'notice', // 学内連絡・教員連絡 …
  'assignment', // 小テスト/レポート/アンケート登録通知
  'reminder', // 催促通知
  'other',
]);
export type ContactKind = z.infer<typeof ContactKindSchema>;

const screenId = z.string().regex(/^[A-Za-z0-9_]+$/, 'expected a screen id such as SC_01002B00_01');
/** Path relative to the base URL, without a leading slash (e.g. "SC_18001B00_01/timeTable"). */
const relPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^https?:/i.test(p), 'expected a path relative to baseUrl');

export const LcuScreensSchema = z.object({
  /** Screen reached right after SSO (and the one we GET to bootstrap tokens). */
  landing: screenId,
  home: screenId,
  scheduler: screenId,
  timetable: screenId,
  examTimetable: screenId,
  noticeList: screenId,
  noticeDetail: screenId,
  assignmentList: screenId,
  /** Submission screen — never opened (denylisted). Listed so overrides are denylisted too. */
  assignmentSubmit: screenId,
  attendance: screenId,
  gradeDashboard: screenId,
  grades: screenId,
  /** 単位修得情報 (requirement status), reached from the grade screen. Opt-in like grades. */
  creditRequirements: screenId.optional(),
});
export type LcuScreens = z.infer<typeof LcuScreensSchema>;

export const LcuActionsSchema = z.object({
  /** Menu entry action appended to a screen id: POST <screen>/<menuInit>. */
  menuInit: z.string().default('init'),
  schedulerToTimetable: relPath,
  timetableChangeSemester: relPath,
  timetableToExams: relPath,
  examChangeSemester: relPath,
  /** Hidden field carrying the semester code for the two "change" actions. */
  semesterField: z.string().default('selectSemesterTermCode'),
  noticeRowSelect: relPath,
  noticeDetailBack: relPath,
  /** Form field holding the DataTables row index for row transitions. */
  rowIndexField: z.string().default('rowIndex'),
  assignmentSearch: relPath,
  /** 出欠状況一覧 search (per year/semester); without it only the default (current) semester is read. */
  attendanceSearch: relPath.optional(),
  gradesFromDashboard: relPath,
  /**
   * Switch of the grade list between 修得成績 and 履修中含む (registered courses without an
   * evaluation yet). The value of `gradesKindField` selects the view.
   */
  gradesChangeKind: relPath.optional(),
  gradesKindField: z.string().default('seisekiKind'),
  /** Value of `gradesKindField` for the 履修中含む view. */
  gradesKindIncludingInProgress: z.string().optional(),
  /** Grade screen → 単位修得情報 (requirement status). */
  gradesToRequirements: relPath.optional(),
});
export type LcuActions = z.infer<typeof LcuActionsSchema>;

export const LcuEndpointsSchema = z.object({
  importantNotice: relPath,
  submissionInformation: relPath,
  warningNotice: relPath,
  classSubjectList: relPath,
  /** Static script hashed for version fingerprinting (§72). */
  commonScript: relPath,
});
export type LcuEndpoints = z.infer<typeof LcuEndpointsSchema>;

const formFields = z.array(z.tuple([z.string(), z.string()]));

export const LcuDeploymentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  /** UniContext profile ids (§54) that use this deployment when `deployment` is not set. */
  profileIds: z.array(z.string()).default([]),
  baseUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'baseUrl must be http(s)')
    .transform((u) => (u.endsWith('/') ? u : `${u}/`)),
  auth: z.object({
    ssoStartSelector: z.string().min(1),
    /** Informational: the action the SSO button posts to (the browser performs it). */
    ssoStartPath: relPath,
    idpHosts: z.array(z.string()).default([]),
    /** Regex source of the IdP SSO profile path (consent handler). */
    idpSsoPathPattern: z.string().optional(),
    loginScreenId: screenId,
    loginFormId: z.string().min(1),
    /** Screens that prove a logged-in session (browser login detection). */
    loggedInScreenIds: z.array(screenId).min(1),
  }),
  screens: LcuScreensSchema,
  actions: LcuActionsSchema,
  endpoints: LcuEndpointsSchema,
  forms: z
    .object({
      /** Fields of the assignment search (besides tokens); "{year}" is replaced. */
      assignmentSearch: formFields.default([]),
      /** Fields of the attendance search; "{year}" and "{semester}" are replaced. */
      attendanceSearch: formFields.default([]),
      classSubjectList: z
        .object({
          yearField: z.string().default('startYear'),
          semesterField: z.string().default('startSemester'),
          extra: z.record(z.string(), z.string()).default({}),
        })
        .prefault({}),
    })
    .prefault({}),
  semesters: z
    .array(z.object({ code: z.string(), name: z.string() }))
    .min(1)
    .default([
      { code: '1', name: '前期' },
      { code: '2', name: '後期' },
    ]),
  contactTypes: z.record(
    z.string(),
    z.object({ title: z.string(), kind: ContactKindSchema.default('notice') }),
  ),
  /** Server-side idle timeout of the LCU session. */
  idleTimeoutMinutes: z.number().positive().default(60),
  /** Nightly maintenance, local time in the profile timezone, e.g. "01:00-06:00". */
  maintenanceWindow: z
    .string()
    .regex(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/, 'expected HH:MM-HH:MM')
    .optional(),
  version: z
    .object({
      /** Known static scripts: size in bytes and/or sha256 of the deployed file. */
      scripts: z
        .array(
          z.object({
            path: relPath,
            size: z.number().int().optional(),
            sha256: z.string().optional(),
          }),
        )
        .default([]),
    })
    .prefault({}),
});
export type LcuDeploymentProfile = z.infer<typeof LcuDeploymentProfileSchema>;
export type LcuDeploymentProfileInput = z.input<typeof LcuDeploymentProfileSchema>;

/** Keys a profile (`products.livecampusu`) or the source config may override per deployment. */
export const DEPLOYMENT_OVERRIDE_KEYS = [
  'baseUrl',
  'idpHosts',
  'maintenanceWindow',
  'idleTimeoutMinutes',
  'screens',
  'actions',
  'endpoints',
  'contactTypes',
  'semesters',
] as const;

export interface DeploymentSelection {
  /** profile.products.livecampusu (deployment settings, §54). */
  productSettings?: Record<string, unknown> | undefined;
  /** UniContext profile id (fallback lookup through `profileIds`). */
  profileId?: string | undefined;
  /** Source config (wins over the profile). */
  config?: Record<string, unknown> | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function applyOverrides(
  base: LcuDeploymentProfileInput,
  over: Record<string, unknown> | undefined,
): LcuDeploymentProfileInput {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of DEPLOYMENT_OVERRIDE_KEYS) {
    const v = over[key];
    if (v === undefined) continue;
    if (key === 'idpHosts') {
      out.auth = { ...(out.auth as Record<string, unknown>), idpHosts: v };
    } else if (
      (key === 'screens' || key === 'actions' || key === 'endpoints' || key === 'contactTypes') &&
      isRecord(v)
    ) {
      out[key] = { ...(isRecord(out[key]) ? out[key] : {}), ...v };
    } else {
      out[key] = v;
    }
  }
  return out as LcuDeploymentProfileInput;
}

/**
 * Pick the deployment profile: `config.deployment`, else `products.livecampusu.deployment`, else
 * the registered deployment whose `profileIds` contains the UniContext profile id. Per-key
 * overrides are applied (profile first, then config) and the result is zod-validated.
 */
export function resolveDeployment(
  registry: Readonly<Record<string, LcuDeploymentProfileInput>>,
  selection: DeploymentSelection,
): LcuDeploymentProfile {
  const name =
    (typeof selection.config?.deployment === 'string' ? selection.config.deployment : undefined) ??
    (typeof selection.productSettings?.deployment === 'string'
      ? selection.productSettings.deployment
      : undefined);
  let base: LcuDeploymentProfileInput | undefined;
  if (name) {
    base = registry[name];
    if (!base)
      throw new ConfigError(
        `Unknown LiveCampusU deployment "${name}" (known: ${Object.keys(registry).join(', ')})`,
      );
  } else if (selection.profileId) {
    base = Object.values(registry).find((d) =>
      (d.profileIds ?? []).includes(selection.profileId ?? ''),
    );
  }
  if (!base)
    throw new ConfigError(
      'No LiveCampusU deployment selected: set `deployment` in the source config or `products.livecampusu.deployment` in the university profile',
    );
  const merged = applyOverrides(applyOverrides(base, selection.productSettings), selection.config);
  const parsed = LcuDeploymentProfileSchema.safeParse(merged);
  if (!parsed.success)
    throw new ConfigError(
      `Invalid LiveCampusU deployment profile: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return parsed.data;
}

/** Absolute URL of a path relative to the deployment base URL. */
export function lcuUrl(deployment: LcuDeploymentProfile, path: string): string {
  return new URL(path.replace(/^\/+/, ''), deployment.baseUrl).toString();
}

/** Path of a URL relative to the deployment base (no leading slash, no query); undefined if outside. */
export function relativeLcuPath(deployment: LcuDeploymentProfile, url: string): string | undefined {
  const base = new URL(deployment.baseUrl);
  let u: URL;
  try {
    u = new URL(url, deployment.baseUrl);
  } catch {
    return undefined;
  }
  if (u.host !== base.host) return undefined;
  const path = u.pathname.replace(/;jsessionid=[^/?#]*/gi, '');
  if (!path.startsWith(base.pathname) && `${path}/` !== base.pathname) return undefined;
  return path.slice(base.pathname.length).replace(/^\/+/, '');
}

/** Is `local` (HH:MM in the profile timezone) inside "HH:MM-HH:MM" (wraps past midnight)? */
export function inMaintenanceWindow(
  window: string | undefined,
  hour: number,
  minute: number,
): boolean {
  if (!window) return false;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const t = hour * 60 + minute;
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}
