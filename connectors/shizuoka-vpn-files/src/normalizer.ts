import { isIdOf, type Id } from '@unicontext/canonical-model';
import {
  type DriftFinding,
  detectSchemaDrift,
  type NormalizeContext,
  type NormalizedEntity,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { chunkText } from '@unicontext/local-files';
import {
  type FilePayload,
  FilePayloadSchema,
  type FileTextPayload,
  FileTextPayloadSchema,
  isRawType,
  RAW_TYPES,
  SCHEMAS,
} from './schemas.js';
import { extensionOf } from './parse.js';

export const NORMALIZER_VERSION = '1';
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 100;

function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined || value === '' ? {} : { [key]: value }) as {
    [P in K]?: V;
  };
}

function drift(type: keyof typeof SCHEMAS, payload: unknown): DriftFinding[] {
  return detectSchemaDrift(payload, SCHEMAS[type]).filter((f) => f.kind !== 'unknown');
}

function materialKind(name: string): 'slides' | 'handout' | 'reading' | 'code' | 'other' {
  const ext = extensionOf(name);
  if (ext === 'pptx' || ext === 'ppt' || ext === 'key') return 'slides';
  if (ext === 'pdf' || ext === 'docx' || ext === 'doc') return 'handout';
  if (ext === 'txt' || ext === 'md') return 'reading';
  if (['py', 'c', 'cpp', 'h', 'java', 'js', 'ts', 'ipynb', 'r'].includes(ext)) return 'code';
  return 'other';
}

/**
 * A file of the share → a `document` (+ `material`), with the full tree path kept so the AI can
 * browse/search by path. Course attribution is best-effort and never a filter: when the folder
 * parsed as a course (or a config mapping names one), a `courseOffering` candidate is emitted so
 * the IdentityResolver can PROPOSE a link to the academic system's offering, which the student
 * confirms. An explicit mapping to a known offering id is used directly.
 */
function normalizeFile(p: FilePayload, ctx: NormalizeContext): NormalizeOutput {
  const documentId = ctx.id('document', p.root, p.path);
  const entities: NormalizedEntity[] = [];
  let courseOfferingId: Id<'courseOffering'> | undefined;

  const hint = p.course;
  if (hint) {
    const explicit = hint.explicitCourse;
    if (explicit && isIdOf('courseOffering', explicit)) {
      // The student mapped this path to a specific offering: attribute it directly.
      courseOfferingId = explicit as Id<'courseOffering'>;
    } else {
      // A title-only candidate; the IdentityResolver links it by title + year.
      courseOfferingId = ctx.id('courseOffering', p.root, hint.coursePath);
      const title = (explicit && !isIdOf('courseOffering', explicit) ? explicit : hint.title).trim();
      entities.push({
        entity: {
          id: courseOfferingId,
          kind: 'courseOffering',
          title: title || hint.coursePath,
          ...opt('academicYear', hint.year),
          instructorIds: [],
          instructorNames: hint.teacher ? [hint.teacher] : [],
          schedule: [],
          extra: {
            platform: 'vpn-fs',
            source: 'folder',
            root: p.root,
            folderPath: hint.coursePath,
          },
        },
        ref: {},
      });
    }
  }

  const url = undefined; // the portal path is not a stable web URL
  const extra = {
    platform: 'vpn-fs',
    root: p.root,
    folder: p.parent,
    ...opt('sizeText', p.sizeText),
    ...opt('modifiedText', p.modifiedText),
    ...opt('listedAt', p.listedAt),
  };
  entities.push({
    entity: {
      id: documentId,
      kind: 'document',
      title: p.name,
      ...opt('mimeType', p.mimeType),
      path: `/${p.path}`,
      ...opt('url', url),
      ...(p.sizeBytes !== undefined ? { sizeBytes: p.sizeBytes } : {}),
      ...opt('courseOfferingId', courseOfferingId),
      ...opt('modifiedAt', p.modifiedAt),
      extra,
    },
    ref: { location: { timestamp: p.modifiedText ?? p.listedAt } },
  });
  entities.push({
    entity: {
      id: ctx.id('material', p.root, p.path),
      kind: 'material',
      ...opt('courseOfferingId', courseOfferingId),
      title: p.name,
      materialKind: materialKind(p.name),
      documentId,
      extra: { platform: 'vpn-fs', root: p.root, folder: p.parent },
    },
    ref: {},
  });
  return { entities };
}

function normalizeFileText(p: FileTextPayload, ctx: NormalizeContext): NormalizeOutput {
  // The file text's external id is the file's external id ("<root>:<path>"). Rebuild the document id.
  const sep = p.externalId.indexOf(':');
  const root = sep > 0 ? p.externalId.slice(0, sep) : '';
  const path = sep > 0 ? p.externalId.slice(sep + 1) : p.path;
  const documentId = ctx.id('document', root, path);
  const pieces: { text: string; page?: number }[] = [];
  if (p.pages?.length)
    for (const pg of p.pages)
      for (const text of chunkText(pg.text, CHUNK_SIZE, CHUNK_OVERLAP))
        pieces.push({ text, page: pg.page });
  else for (const text of chunkText(p.text, CHUNK_SIZE, CHUNK_OVERLAP)) pieces.push({ text });
  return {
    entities: pieces.map((piece, ordinal) => ({
      entity: {
        id: ctx.id('documentChunk', root, path, String(ordinal)),
        kind: 'documentChunk',
        documentId,
        ordinal,
        text: piece.text,
        ...(piece.page && piece.page > 0 ? { page: piece.page } : {}),
      },
      ref: piece.page ? { location: { page: piece.page } } : {},
    })),
  };
}

/** VPN file-share raw items → canonical entities. Folders stay raw (read by the browse view). */
export function createShizuokaVpnFilesNormalizer(): Normalizer {
  return {
    id: 'shizuoka-vpn-files-normalizer',
    version: NORMALIZER_VERSION,
    sourceTypes: [...RAW_TYPES],
    normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
      const type = item.sourceType;
      if (!isRawType(type)) return { entities: [] };
      const findings = drift(type, item.payload);
      const fail = (msg: string): NormalizeOutput => ({
        entities: [],
        drift: findings,
        warnings: [`invalid ${type} payload: ${msg}`],
      });
      switch (type) {
        case 'szvpn.folder':
          // Kept in the raw store only; the context engine reads it for the browse tree.
          return { entities: [], drift: findings };
        case 'szvpn.file': {
          const r = FilePayloadSchema.safeParse(item.payload);
          return r.success ? { ...normalizeFile(r.data, ctx), drift: findings } : fail(r.error.message);
        }
        case 'szvpn.fileText': {
          const r = FileTextPayloadSchema.safeParse(item.payload);
          return r.success
            ? { ...normalizeFileText(r.data, ctx), drift: findings }
            : fail(r.error.message);
        }
        default:
          return { entities: [] };
      }
    },
  };
}
