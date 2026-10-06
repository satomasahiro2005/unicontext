import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type DocumentImage,
  type DocumentPage,
  type DocumentRead,
  parsePageSpec,
  readDocument,
  type RenderMode,
  resolveDocument,
} from '@unicontext/context-engine';
import { errorMessage, isUniContextError, redact, ValidationError } from '@unicontext/core';
import { z } from 'zod';
import { buildEnvelope, compactEnvelope } from './envelope.js';
import type { McpDeps } from './server.js';

/*
 * get_document: open any document UniContext knows (a class file, an Ed attachment, a notice
 * attachment, a search hit, a file in a local-files folder) and return it the way a person would
 * look at it: the text of each page / slide, and the pages and pictures as real images the client's
 * vision can read. Read-only: the bytes are fetched on demand through the source that has them (or
 * not at all: LiveCampusU attachments only come back with where to open them).
 */

/** One sentence for SERVER_INSTRUCTIONS / REMOTE_* : when to reach for get_document. */
export const DOCUMENT_INSTRUCTION_JA =
  'PDF・スライド・Word・画像・お知らせや投稿の添付など、資料の中身が答えに要るときは、本人に貼り付けやスクリーンショットを求めず、search や get_course などの document:… の id（お知らせは announcement:…）で get_document を呼んでください（ページごとの本文と、ページ画像・埋め込み画像が画像として返ります。needsVision のページは画像を見て読み、取得できない資料は UniContext に何が足りないかをそのまま伝える）。';

export const GET_DOCUMENT_DESCRIPTION =
  '資料を開き、ページ／スライドごとの本文と、ページ画像・スライドの埋め込み画像・画像ファイルを画像として返す（PDF・PowerPoint・Word・PNG/JPEG/GIF/WebP・テキスト）。id は document:…／material:…／announcement:…／search の結果の id、「科目名/フォルダ/ファイル名」、ローカルフォルダ内のパス。ファイルは必要になった時にその情報源から取得する（Teams・VPNファイル共有・Edの添付・ローカルファイル）。pages は「1-5」「3」「2,4-6」で、省略すると先頭5ページ（pageCount と続きの取り方を返す）。render は text / images / both（既定 both）。スキャンされたページ（needsVision）は本文が取れていないので、続く画像を見て読む。LiveCampusU の添付はコネクタ方針で取得できず、開く場所（openUrl）だけを返す。大学側には何も変更しない（読み取りのみ）。 / Open a document and return the text of each page or slide plus page renders, embedded slide images and image files as real image content (PDF, PowerPoint, Word, images, text). id: document:… / material:… / announcement:… / a search hit id, "<course>/<path>", or a path inside a local-files folder. Bytes are fetched on demand from the source that has them. pages: "1-5", "3" or "2,4-6" (default: the first 5, with pageCount and how to ask for more). render: text | images | both (default both). Pages with needsVision have no text layer: read the image that follows. LiveCampusU attachments cannot be downloaded (connector policy): only openUrl comes back. Read-only.';

export const GET_DOCUMENT_REMOTE_DESCRIPTION =
  '資料を開き、ページ／スライドごとの本文と、ページ画像・スライドの埋め込み画像・画像ファイルを画像として返す（PDF・PowerPoint・Word・画像・テキスト）。id は document:…／material:…／announcement:…／search の結果の id、または「科目名/フォルダ/ファイル名」。pages は「1-5」「3」「2,4-6」で、省略すると先頭5ページ。render は text / images / both。画像は最大4枚・合計3MBまで（続きは pages を絞って）。スキャンされたページ（needsVision）は続く画像を見て読む。LiveCampusU の添付は取得できず、開く場所（openUrl）だけを返す。読み取りのみ。 / Open a document and return per-page or per-slide text plus page renders and embedded images as image content (at most 4 images, 3 MB in total; ask for fewer pages to see more). Pages with needsVision: read the image that follows. LiveCampusU attachments are not downloadable: only openUrl comes back. Read-only.';

export const DOCUMENT_LIMITS = {
  local: { maxImages: 8, maxImageBase64: 1_500_000, maxTotalBase64: 6_000_000 },
  remote: { maxImages: 4, maxImageBase64: 1_500_000, maxTotalBase64: 3_000_000 },
} as const;

export const DEFAULT_DOCUMENT_CHARS = 20_000;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const getDocumentShape = {
  id: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'document:…／material:…／announcement:… の id、検索結果の id、「科目名/フォルダ/ファイル名」、ローカルパス / Document id, search hit id, "<course>/<path>" or a local path',
    ),
  pages: z
    .union([z.string().max(200), z.array(z.number().int().positive()).max(500)])
    .optional()
    .describe(
      'ページ／スライド番号: "1-5"、"3"、"2,4-6"、[1,2]。省略時は先頭5ページ / Pages or slides, e.g. "1-5"; default the first 5',
    ),
  render: z
    .enum(['text', 'images', 'both'])
    .optional()
    .describe(
      'text=本文だけ, images=画像だけ, both=両方（既定） / text only, images only, or both (default)',
    ),
  maxChars: z
    .number()
    .int()
    .min(200)
    .max(100_000)
    .optional()
    .describe('本文の最大文字数（既定20000） / Max characters of text (default 20000)'),
};

/** What structuredContent carries (the same object as the text envelope; the pictures are image items). */
export const getDocumentOutputShape = {
  document: z.looseObject({ id: z.string(), title: z.string() }),
  kind: z.string(),
  pageCount: z.number().optional(),
  pages: z.array(z.looseObject({ index: z.number(), kind: z.string(), text: z.string() })),
  images: z.array(z.looseObject({ n: z.number(), mimeType: z.string(), label: z.string() })),
  truncated: z.boolean(),
  fromStoredText: z.boolean().optional(),
  warnings: z.array(z.string()),
  unsupported: z.looseObject({ reason: z.string() }).optional(),
  candidates: z.array(z.looseObject({ id: z.string(), title: z.string() })).optional(),
  citations: z.array(z.looseObject({ sourceReferenceId: z.string(), label: z.string() })),
  answerHint: z.string(),
};

interface ToolPage {
  index: number;
  kind: DocumentPage['kind'];
  text: string;
  ocrText?: string;
  origin?: 'ocr';
  needsVision?: boolean;
  truncated?: true;
}

/** The pages' text, in order, cut at `maxChars` in total (text and OCR text both count). */
function limitText(
  pages: readonly DocumentPage[],
  maxChars: number,
): {
  pages: ToolPage[];
  truncated: boolean;
} {
  let left = maxChars;
  let truncated = false;
  const out: ToolPage[] = [];
  const cut = (s: string): { text: string; cut: boolean } => {
    if (s.length <= left) {
      left -= s.length;
      return { text: s, cut: false };
    }
    const text = s.slice(0, Math.max(0, left));
    left = 0;
    return { text, cut: true };
  };
  for (const p of pages) {
    const t = cut(p.text);
    const o = p.ocrText !== undefined ? cut(p.ocrText) : undefined;
    const wasCut = t.cut || o?.cut === true;
    if (wasCut) truncated = true;
    out.push({
      index: p.index,
      kind: p.kind,
      text: t.text,
      ...(o ? { ocrText: o.text } : {}),
      ...(p.origin ? { origin: p.origin } : {}),
      ...(p.needsVision ? { needsVision: true } : {}),
      ...(wasCut ? { truncated: true as const } : {}),
    });
  }
  return { pages: out, truncated };
}

const b64 = (n: number): number => Math.ceil(n / 3) * 4;

/** The pictures that fit the surface's count and size caps, in order. */
export function limitImages(
  images: readonly DocumentImage[],
  limits: { maxImages: number; maxImageBase64: number; maxTotalBase64: number },
  warnings: string[],
): DocumentImage[] {
  const kept: DocumentImage[] = [];
  let total = 0;
  let dropped = 0;
  for (const img of images) {
    const size = b64(img.data.length);
    if (
      kept.length >= limits.maxImages ||
      size > limits.maxImageBase64 ||
      total + size > limits.maxTotalBase64
    ) {
      dropped += 1;
      continue;
    }
    kept.push(img);
    total += size;
  }
  if (dropped > 0)
    warnings.push(
      `画像は${limits.maxImages}枚・合計${Math.round(limits.maxTotalBase64 / 1_000_000)}MBまでのため${dropped}枚は省きました。pages を絞ると続きを取れます`,
    );
  return kept;
}

export interface DocumentToolOutput {
  result: CallToolResult;
  read: DocumentRead;
}

/**
 * Build the tool result: a JSON envelope as text, then one image item per picture. Exported for
 * tests (the registered tool is a thin wrapper).
 */
export async function runGetDocument(
  deps: McpDeps,
  args: { id: string; pages?: string | number[]; render?: RenderMode; maxChars?: number },
): Promise<DocumentToolOutput> {
  const remote = deps.surface === 'remote';
  const limits = remote ? DOCUMENT_LIMITS.remote : DOCUMENT_LIMITS.local;
  const ref = args.id.trim();
  // The remote client reads what UniContext holds, never an arbitrary path of this computer.
  if (remote && /^(file:|~|[A-Za-z]:[\\/]|\/|\\\\)/.test(ref))
    throw new ValidationError('local paths cannot be opened through the remote connection');
  const pages = parsePageSpec(args.pages);
  const handle = resolveDocument(deps.uc, ref, {
    ...(deps.filesDir ? { filesDir: deps.filesDir } : {}),
    ...(deps.downloadFiles ? { downloadFiles: deps.downloadFiles } : {}),
  });
  const read = await readDocument(handle, {
    pages,
    render: args.render ?? 'both',
    maxImages: limits.maxImages,
    maxImageBase64: limits.maxImageBase64,
  });
  const warnings = [...read.warnings];
  const images = limitImages(read.images, limits, warnings);
  const text = limitText(read.pages, args.maxChars ?? DEFAULT_DOCUMENT_CHARS);
  if (text.truncated)
    warnings.push(
      '本文を maxChars で打ち切りました。pages を絞るか maxChars を増やすと続きを取れます',
    );

  const hints: string[] = [];
  const shown = read.pages.map((p) => p.index);
  if (
    read.pageCount !== undefined &&
    pages === undefined &&
    shown.length > 0 &&
    read.pageCount > shown.length
  ) {
    const next = (shown[shown.length - 1] ?? 0) + 1;
    hints.push(
      `全${read.pageCount}ページのうち先頭${shown.length}ページです。続きは pages: "${next}-${Math.min(read.pageCount, next + 4)}" のように指定してください。`,
    );
  }
  if (read.pages.some((p) => p.needsVision))
    hints.push(
      'needsVision のページは文字が取れていません。続く画像を見て読んでください（本人に貼り付けは求めない）。',
    );
  if (read.unsupported) {
    hints.push(
      read.unsupported.openUrl
        ? `UniContext からは取得できません: ${read.unsupported.reason}。開く場所は openUrl です。本人に押し付けず、何が取れなかったかをそのまま伝えてください。`
        : `UniContext からは取得できません: ${read.unsupported.reason}。何が取れなかったかをそのまま伝えてください。`,
    );
  }

  const envelope = buildEnvelope({ citations: read.citations }, { hint: hints.join(' ') });
  const compact = compactEnvelope(envelope);
  const body = {
    document: read.document,
    kind: read.kind,
    ...(read.pageCount !== undefined ? { pageCount: read.pageCount } : {}),
    pages: text.pages,
    images: images.map((img, n) => ({
      n: n + 1,
      ...(img.page !== undefined ? { page: img.page } : {}),
      source: img.source,
      label: img.label,
      mimeType: img.mimeType,
      width: img.width,
      height: img.height,
    })),
    truncated: text.truncated,
    ...(read.fromStoredText ? { fromStoredText: true } : {}),
    warnings,
    ...(read.unsupported
      ? {
          unsupported: {
            reason: read.unsupported.reason,
            ...(read.unsupported.openUrl
              ? { openUrl: redact(read.unsupported.openUrl) as string }
              : {}),
          },
        }
      : {}),
    ...(read.candidates ? { candidates: read.candidates } : {}),
    citations: compact.citations,
    answerHint: compact.answerHint,
  };
  const result: CallToolResult = {
    structuredContent: body as unknown as Record<string, unknown>,
    content: [
      { type: 'text', text: JSON.stringify(body, null, remote ? 0 : 2) },
      ...images.map((img) => ({
        type: 'image' as const,
        data: img.data.toString('base64'),
        mimeType: img.mimeType,
      })),
    ],
  };
  return { result, read };
}

/** Student ids in error text never reach the client (same rule as every other tool). */
function redactionOptions(deps: McpDeps): { extraValuePatterns?: RegExp[] } {
  const pattern = deps.uc.profile?.privacy.studentIdPattern;
  if (!pattern) return {};
  try {
    return { extraValuePatterns: [new RegExp(pattern, 'g')] };
  } catch {
    return {};
  }
}

/** Register get_document (read-only, so also on the remote surface). */
export function registerDocumentTools(server: McpServer, deps: McpDeps): void {
  const remote = deps.surface === 'remote';
  server.registerTool(
    'get_document',
    {
      title: '資料を開く（本文と画像）',
      description: remote ? GET_DOCUMENT_REMOTE_DESCRIPTION : GET_DOCUMENT_DESCRIPTION,
      inputSchema: getDocumentShape,
      outputSchema: getDocumentOutputShape,
      annotations: READ_ONLY,
    },
    async (args: unknown): Promise<CallToolResult> => {
      const started = Date.now();
      let ok = false;
      try {
        const out = await runGetDocument(deps, args as Parameters<typeof runGetDocument>[1]);
        ok = true;
        return out.result;
      } catch (e) {
        let message: string;
        if (isUniContextError(e)) message = `${e.code}: ${e.message}`;
        else if (e instanceof z.ZodError)
          message = `validation: ${e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`;
        else {
          deps.logger?.error('mcp tool failed', { tool: 'get_document', error: errorMessage(e) });
          message = `internal: ${errorMessage(e)}`;
        }
        return {
          isError: true,
          content: [{ type: 'text', text: redact(message, redactionOptions(deps)) as string }],
        };
      } finally {
        try {
          deps.onToolCall?.({ tool: 'get_document', ok, ms: Date.now() - started });
        } catch (e) {
          deps.logger?.warn('mcp audit hook failed', {
            tool: 'get_document',
            error: errorMessage(e),
          });
        }
      }
    },
  );
}
