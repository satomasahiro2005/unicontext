import { z } from 'zod';

export const RAW_TYPE_DOCUMENT = 'file.document';

export const FileDocumentPayloadSchema = z.object({
  /** Absolute root directory this file was found under (the user's own machine). */
  root: z.string(),
  /** Path below the root, always with `/` separators. */
  relativePath: z.string(),
  name: z.string(),
  /** Lower-case extension without the dot ("" when none). */
  ext: z.string(),
  mimeType: z.string(),
  size: z.number(),
  /** Modification time, ISO 8601. */
  mtime: z.string(),
  /** sha256 of the content (of "size:mtime" for files above maxFileSizeMb). */
  hash: z.string(),
  /** PDF: text per page. */
  pages: z.array(z.object({ page: z.number().int().positive(), text: z.string() })).optional(),
  /** DOCX / text / HTML / source code. */
  text: z.string().optional(),
  /** PPTX: text per slide in presentation order. */
  slides: z
    .array(
      z.object({
        slide: z.number().int().positive(),
        title: z.string().optional(),
        text: z.string(),
        notes: z.string().optional(),
      }),
    )
    .optional(),
  image: z
    .object({
      width: z.number(),
      height: z.number(),
      takenAt: z.string().optional(),
    })
    .optional(),
  /** Folder name inferred as the course (e.g. データベースシステム論). */
  courseFolder: z.string().optional(),
  /** Term/year folder that was skipped while inferring the course (e.g. 2026前期). */
  termFolder: z.string().optional(),
  /** Why only metadata is present (too large, extraction error). */
  note: z.string().optional(),
});
export type FileDocumentPayload = z.infer<typeof FileDocumentPayloadSchema>;

export interface FileSlide {
  slide: number;
  title?: string;
  text: string;
  notes?: string;
}
