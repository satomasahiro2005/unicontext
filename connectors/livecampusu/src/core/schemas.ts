import { z } from 'zod';

/**
 * Raw item types emitted by the adapter and the zod schemas used for schema-drift detection
 * (§73). JSON endpoint shapes are mirrored exactly (unknown/missing fields are reported, not
 * rejected); HTML screens are parsed into the structured payloads below.
 */
export const RAW_TYPES = {
  course: 'lcu.course',
  notice: 'lcu.notice',
  assignment: 'lcu.assignment',
  submissionInfo: 'lcu.submissionInfo',
  warningNotice: 'lcu.warningNotice',
  calendarEvent: 'lcu.calendarEvent',
  exam: 'lcu.exam',
  attendance: 'lcu.attendance',
  grade: 'lcu.grade',
  /** 単位修得情報: graduation requirement status (one item per requirement type). */
  creditRequirements: 'lcu.creditRequirements',
} as const;
export type LcuRawType = (typeof RAW_TYPES)[keyof typeof RAW_TYPES];
export const ALL_RAW_TYPES: LcuRawType[] = Object.values(RAW_TYPES);

const str = z.string();
const nstr = z.string().nullable();

// ---------------------------------------------------------------- JSON endpoints (observed)

/** GET <landing>/importantNotice — one element of the top-level array. */
export const ImportantNoticeSchema = z.object({
  contactDate: str,
  contactSeq: str,
  contactTime: str,
  contactTypeCode: str,
  contactTypeTitle: str,
  importanceCategory: str,
  subjectClassSemesterWeekHour: str,
  targetDate: str,
  title: str,
});
export type ImportantNotice = z.infer<typeof ImportantNoticeSchema>;

/** POST SubjectInformationSearch/getClassSubjectList — one element. */
export const ClassSubjectSchema = z.object({
  label: str,
  optGroupflg: z.boolean(),
  value: str,
});
export type ClassSubject = z.infer<typeof ClassSubjectSchema>;

const WarningDateSchema = z.object({
  warningNoticeContentDateTitle: nstr,
  warningNoticeContentDay: nstr,
  warningNoticeContentDayText: nstr,
  warningNoticeContentHalfSizeSlash: nstr,
  warningNoticeContentHalfSizeSlashText: nstr,
  warningNoticeContentMonth: nstr,
  warningNoticeContentMonthText: nstr,
  warningNoticeStatusId: nstr,
  warningNoticeStatusName: nstr,
});

/** GET <home>/warningNoticeInformation — one element (warningNoticeRequestPath is dropped). */
export const WarningNoticeSchema = z.object({
  chartShortenedDisplayCount: nstr,
  studyResultShortenedDisplayCount: nstr,
  warningDisplayExamType: nstr,
  warningNoticeContent: nstr,
  warningNoticeContentCount: nstr,
  warningNoticeContentCountText: nstr,
  warningNoticeContentDay: nstr,
  warningNoticeContentDayText: nstr,
  warningNoticeContentHalfSizeSlash: nstr,
  warningNoticeContentHalfSizeSlashText: nstr,
  warningNoticeContentMonth: nstr,
  warningNoticeContentMonthText: nstr,
  warningNoticeCountExistence: nstr,
  warningNoticeDateExistence: nstr,
  warningNoticeId: nstr,
  warningNoticeInformationDateList: z.array(WarningDateSchema).nullable(),
  warningNoticeName: nstr,
  warningNoticeSize: nstr,
  warningNoticeStatusExistence: nstr,
  warningNoticeStatusId: nstr,
  warningNoticeStatusName: nstr,
});
export type WarningNotice = z.infer<typeof WarningNoticeSchema>;

/**
 * GET <home>/submissionInformation?mode=web — shape NOT observed (the list was empty). Fields the
 * community userscript reads are optional; anything else is reported as drift.
 */
export const SubmissionInformationSchema = z.object({
  submissionSeq: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  subjectName: z.string().optional(),
  submissionTypeName: z.string().optional(),
  submittalEndDate: z.string().optional(),
  submittalTerm: z.string().optional(),
  deadline: z.string().optional(),
});

// ---------------------------------------------------------------- adapter payloads

const sourceSchema = z.object({ screen: str, selector: str.optional() });

export const CourseSlotSchema = z.object({
  week: z.number(),
  period: z.number(),
  room: str.optional(),
  campus: str.optional(),
  selector: str.optional(),
});

export const CoursePayloadSchema = z.object({
  key: str,
  year: z.number(),
  semesterCode: str.optional(),
  termName: str.optional(),
  subjectCode: str,
  classCode: str,
  title: str,
  className: str.optional(),
  subjectList: ClassSubjectSchema.optional(),
  /** regular = weekly grid; unscheduled = 時間割外講義; intensive = 集中講義 (timetable screen sections). */
  scheduleType: z.enum(['regular', 'unscheduled', 'intensive']).optional(),
  /** 再履修 class (class name 「再履修…」). */
  retake: z.boolean().optional(),
  timetable: z
    .object({
      teacher: str.optional(),
      credits: z.number().optional(),
      numbering: str.optional(),
      campus: str.optional(),
      room: str.optional(),
      flags: z.array(str),
      slots: z.array(CourseSlotSchema),
    })
    .optional(),
  source: sourceSchema,
});
export type CoursePayload = z.infer<typeof CoursePayloadSchema>;

const contextSchema = z.object({ offeringKey: str.optional(), offeringTitle: str.optional() });

export const NoticeListRowPayloadSchema = z.object({
  rowIndex: z.number(),
  unread: z.boolean(),
  hasAttachment: z.boolean().optional(),
  typeCode: str.optional(),
  importanceDigit: str.optional(),
  category: str,
  title: str,
  subjectKey: z.object({ year: z.number(), subjectCode: str, classCode: str, raw: str }).optional(),
  subjectText: str,
  targetDate: str.optional(),
  contactDateTime: str.optional(),
});

export const NoticeDetailPayloadSchema = z.object({
  title: str,
  category: str.optional(),
  courses: z.array(str),
  body: str,
  importance: str.optional(),
  contactDateTime: str.optional(),
  sender: str.optional(),
  attachments: z.array(z.object({ name: str, size: z.number().optional() })),
  /** False when the attachment list could not be read (names may be missing). */
  attachmentsComplete: z.boolean().optional(),
  links: z.array(str).optional(),
  /** When the detail screen was read (ISO). */
  fetchedAt: str.optional(),
  /**
   * LCU read state of the row when the detail was first opened. False: UniContext opened it while
   * it was unread (sync with openUnreadNotices, or on request), so LCU's "read" is UniContext's
   * doing, not the student's; kept false on later re-reads.
   */
  openedWhileRead: z.boolean().optional(),
  /** Opened because the user explicitly asked for it (it may have been unread before). */
  openedOnDemand: z.boolean().optional(),
});
export type NoticeDetailPayload = z.infer<typeof NoticeDetailPayloadSchema>;

export const NoticePayloadSchema = z.object({
  key: str,
  /** Type from the deployment's contact type table (resolved by the adapter). */
  kind: str,
  typeTitle: str.optional(),
  important: ImportantNoticeSchema.optional(),
  listRow: NoticeListRowPayloadSchema.omit({ rowIndex: true }).optional(),
  detail: NoticeDetailPayloadSchema.optional(),
  /**
   * fetched: detail.body is the notice text; notOpened: unread in LCU and not opened because the
   * source has openUnreadNotices: false (opening marks it read and LCU cannot set it back);
   * pending: not fetched yet, a later sync will (over this run's budget).
   */
  bodyStatus: z.enum(['fetched', 'notOpened', 'pending']).optional(),
  context: contextSchema,
  source: sourceSchema,
});
export type NoticePayload = z.infer<typeof NoticePayloadSchema>;

export const AssignmentPayloadSchema = z.object({
  submissionSeq: str,
  year: z.number().optional(),
  submissionType: str,
  subjectText: str,
  title: str,
  statusName: str,
  statusCode: str,
  submittalTerm: str,
  submittalStatus: str,
  context: contextSchema,
  source: sourceSchema,
});
export type AssignmentPayload = z.infer<typeof AssignmentPayloadSchema>;

export const SubmissionInfoPayloadSchema = z.object({
  item: z.unknown(),
  extracted: z.object({
    submissionSeq: str.optional(),
    title: str.optional(),
    deadline: str.optional(),
  }),
  source: sourceSchema,
});

export const WarningNoticePayloadSchema = z.object({
  item: z.unknown(),
  /** Year the month/day refer to (inferred by the adapter from the fetch date). */
  year: z.number(),
  source: sourceSchema,
});

export const CalendarEventPayloadSchema = z.object({
  title: str,
  start: str,
  end: str.optional(),
  allDay: z.boolean().optional(),
  listType: str.optional(),
  event: z.record(z.string(), z.unknown()),
  source: sourceSchema,
});

export const ExamPayloadSchema = z.object({
  year: z.number(),
  semesterCode: str,
  subject: str,
  date: str.optional(),
  period: str.optional(),
  time: str.optional(),
  room: str.optional(),
  teacher: str.optional(),
  cells: z.record(z.string(), z.string()),
  context: contextSchema,
  source: sourceSchema,
});

export const AttendancePayloadSchema = z.object({
  subject: str,
  subjectCode: str.optional(),
  semesterCode: str.optional(),
  schedule: str,
  published: str.optional(),
  counts: z.record(z.string(), z.number()),
  context: contextSchema,
  source: sourceSchema,
});

const markerSchema = z.object({ symbol: str, label: str.optional() });

export const GradePayloadSchema = z.object({
  subjectCode: str,
  subjectName: str,
  markers: z.array(markerSchema).optional(),
  staffName: str.optional(),
  category: str.optional(),
  categoryOrder: z.number().optional(),
  creditType: str.optional(),
  creditTypeCode: str.optional(),
  credits: z.number().optional(),
  score: z.number().optional(),
  mark: str.optional(),
  markCode: str.optional(),
  markHighlighted: z.boolean().optional(),
  gradePoint: z.number().optional(),
  interim: z.boolean().optional(),
  reportTerm: str.optional(),
  academicYear: z.number().optional(),
  term: str.optional(),
  termPart: str.optional(),
  reportDate: str.optional(),
  replacedSubjectName: str.optional(),
  examType: str.optional(),
  examTypeCode: str.optional(),
  /** Grade list view the row came from (履修中含む lists registered courses without a mark). */
  view: z.enum(['earned', 'includingInProgress']).optional(),
  context: contextSchema,
  source: sourceSchema,
});
export type GradePayload = z.infer<typeof GradePayloadSchema>;

const requirementCourseSchema = z.object({
  title: str,
  markers: z.array(markerSchema).optional(),
  creditType: str.optional(),
  credits: z.number().optional(),
  status: str.optional(),
});

export const CreditRequirementsPayloadSchema = z.object({
  requirementType: z.object({ code: str, name: str }).optional(),
  rows: z.array(
    z.object({
      depth: z.number(),
      name: str,
      creditType: str.optional(),
      required: z.number().optional(),
      expected: z.number().optional(),
      status: str.optional(),
      courses: z.array(requirementCourseSchema),
    }),
  ),
  /** 成績マーカー table: symbol, meaning, credit cap and total. */
  markers: z
    .array(
      markerSchema.extend({
        capCredits: z.number().optional(),
        totalCredits: z.number().optional(),
      }),
    )
    .optional(),
  source: sourceSchema,
});
export type CreditRequirementsPayload = z.infer<typeof CreditRequirementsPayloadSchema>;

export const PAYLOAD_SCHEMAS: Record<LcuRawType, z.ZodType> = {
  'lcu.course': CoursePayloadSchema,
  'lcu.notice': NoticePayloadSchema,
  'lcu.assignment': AssignmentPayloadSchema,
  'lcu.submissionInfo': SubmissionInfoPayloadSchema,
  'lcu.warningNotice': WarningNoticePayloadSchema,
  'lcu.calendarEvent': CalendarEventPayloadSchema,
  'lcu.exam': ExamPayloadSchema,
  'lcu.attendance': AttendancePayloadSchema,
  'lcu.grade': GradePayloadSchema,
  'lcu.creditRequirements': CreditRequirementsPayloadSchema,
};
