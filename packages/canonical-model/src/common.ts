import { z } from 'zod';

/** ISO 8601 instant with Z or an explicit offset. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** Local calendar date "YYYY-MM-DD" (interpreted in the profile timezone). */
export const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export type LocalDate = z.infer<typeof LocalDateSchema>;

/** Wall-clock "HH:MM". */
export const LocalTimeSchema = z.string().regex(/^\d{2}:\d{2}$/, 'expected HH:MM');

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** Connector-specific extras that do not (yet) have a canonical field. */
export const ExtraSchema = z.record(z.string(), JsonValueSchema).optional();
