import {
  ADDITION_LIMITS,
  type AdditionClient,
  type AdditionResult,
  type UniContext,
} from '@unicontext/context-engine';
import { z } from 'zod';
import { WRITE_RESULT_SHAPE, writeOutput } from './additions.js';

/*
 * set_travel_time: how long a trip between two places takes, in the student's words. The views
 * (get_today / get_week / get_tomorrow: `travelFromPrevious`) and get_next_action (busy time before
 * a class) use it. No maps service is ever called.
 */

const TRAVEL_MODE_VALUES = ['walk', 'bike', 'train', 'bus', 'car'] as const;
const place = (what: string) =>
  z
    .string()
    .min(1)
    .max(100)
    .describe(
      `${what}。場所の名前（工学部・情13・共通講義棟 など）${what === '出発地' ? '。自宅なら home' : ''} / Place name${what === '出発地' ? ' (home for the student’s home)' : ''}`,
    );

export const setTravelTimeShape = {
  from: place('出発地'),
  to: place('目的地'),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(300)
    .describe('かかる時間（分） / Minutes the trip takes, as the student said'),
  mode: z
    .enum(TRAVEL_MODE_VALUES)
    .optional()
    .describe('手段（言われたときだけ） / Mode, only if stated: walk, bike, train, bus, car'),
  statement: z
    .string()
    .min(1)
    .max(ADDITION_LIMITS.evidence)
    .describe('根拠: ユーザーの言葉をそのまま引用 / Verbatim quote of what the student said'),
  idempotencyKey: z
    .string()
    .min(1)
    .max(ADDITION_LIMITS.idempotencyKey)
    .optional()
    .describe('同じ呼び出しをやり直すとき同じ値 / Same key = same call, never stored twice'),
};

/** The server's `writeTool` registrar, as far as this module needs it. */
export interface PlaceToolHost {
  uc: UniContext;
  caller: () => AdditionClient;
  writeTool: <S extends z.ZodRawShape>(
    name: 'set_travel_time',
    meta: { outputShape: z.ZodRawShape },
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<{
      structured: Record<string, unknown>;
      write?: { status: string; additionId: string; entityIds: string[]; factIds: string[] };
    }>,
  ) => void;
}

function travelHint(r: AdditionResult): string {
  if (r.status !== 'created' && r.status !== 'updated') return '';
  return `${r.addition.title}を登録しました（ユーザーが言った時間。地図サービスは使っていません）。get_today・get_week・get_tomorrow の授業・予定に travelFromPrevious として付き、get_next_action の空き時間から移動の分が引かれます。間違いなら retract_addition で取り消せます。`;
}

/** Registers `set_travel_time` (a write tool: never on the read-only remote surface). */
export function registerPlaceTools(host: PlaceToolHost): void {
  const { uc, caller, writeTool } = host;
  writeTool(
    'set_travel_time',
    { outputShape: WRITE_RESULT_SHAPE },
    setTravelTimeShape,
    async (a) => {
      const r = await uc.additions.setTravelTime(caller(), {
        from: a.from,
        to: a.to,
        minutes: a.minutes,
        mode: a.mode,
        statement: a.statement,
        idempotencyKey: a.idempotencyKey,
      });
      const out = writeOutput(r);
      const hint = travelHint(r);
      return {
        structured: hint ? { ...out, answerHint: `${hint}${String(out['answerHint'])}` } : out,
        write: { status: r.status, ...r.audit },
      };
    },
  );
}
