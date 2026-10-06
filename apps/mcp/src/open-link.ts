import {
  type DownloadFilesReport,
  fileTextExcerpt,
  MAX_LINK_LENGTH,
  openLink,
  type OpenLinkReport,
  type UniContext,
} from '@unicontext/context-engine';
import { ValidationError } from '@unicontext/core';
import { z } from 'zod';

/*
 * open_link: SharePoint / OneDrive links in an email or a message, opened through UniContext's
 * signed-in Microsoft session (teams-web) instead of asking the student to open them. Registered
 * from createMcpServer (both surfaces; read-only at the source).
 */

export const OPEN_LINK_INSTRUCTION_JA =
  'メール・お知らせ・Teamsの投稿などにSharePoint / OneDriveのリンク（〜.sharepoint.com、〜-my.sharepoint.com、Teamsのファイルのリンク）があり、その中身が答えや作業に要るときは、本人に開いてもらったり中身の貼り付けを頼んだりせず、open_linkにそのURLを渡して読んでください。ファイルなら抽出した本文とdocument id（download_course_fileでも開ける）、フォルダーなら中のファイル（各idはdownload_course_fileで開ける）とサブフォルダー（urlをopen_linkに渡す）が返ります。開けなかったときはreasonをそのまま伝え、中身を推測しないでください。';
export const OPEN_LINK_INSTRUCTION_EN =
  'When an email, notice or post contains a SharePoint / OneDrive link (*.sharepoint.com, *-my.sharepoint.com, a Teams file link) whose content matters, call open_link with the URL instead of asking the student to open it or paste it: a file returns its extracted text and a document id (download_course_file accepts it); a folder returns its files (ids for download_course_file) and subfolders (pass their url to open_link). When it cannot be opened, relay the reason and never guess the content.';

export interface OpenLinkDeps {
  /**
   * Open a SharePoint / OneDrive link (open_link). The daemon runs it in-process (it holds the
   * browser profile); `unicontext mcp` routes it to the running daemon. Default: in-process with
   * `filesDir` (and `downloadFiles` for the download).
   */
  openLink?: (url: string, options: { extract: boolean }) => Promise<OpenLinkReport>;
}

interface RegisterContext extends OpenLinkDeps {
  uc: UniContext;
  remote: boolean;
  filesDir?: string;
  downloadFiles?: (refs: string[], options: { extract: boolean }) => Promise<DownloadFilesReport>;
  fileLink?: (documentId: string) => { url: string; expiresAt: string } | undefined;
}

type ToolRegistrar = <S extends z.ZodRawShape>(
  name: string,
  meta: { title: string; description: string; remoteDescription?: string },
  shape: S,
  run: (
    args: z.infer<z.ZodObject<S>>,
  ) =>
    | { data: unknown; options?: { hint?: string } }
    | Promise<{ data: unknown; options?: { hint?: string } }>,
) => void;

const FAILURE_HINT =
  'このリンクは開けませんでした。reasonをそのまま伝え、リンク先の中身を推測しないでください。';

export function registerOpenLinkTool(tool: ToolRegistrar, ctx: RegisterContext): void {
  const { uc, remote } = ctx;
  tool(
    'open_link',
    {
      title: 'SharePoint / OneDriveのリンクを開く',
      description:
        'メールや投稿にあるSharePoint / OneDrive for Businessのリンク（共有リンク :b:/s/…・:f:/…、ファイルやフォルダーのURL、〜-my.sharepoint.comの個人のOneDrive、Teamsのファイルリンク）を、UniContextのサインイン済みのMicrosoftセッションで開く（読み取りのみ）。ファイルは本人のPCにダウンロードしてdocument id・保存先・抽出した本文（PDF/Word/PowerPoint/テキスト）を返し、フォルダーは中のファイル（document idつき、download_course_fileで開ける）とサブフォルダー（urlをopen_linkに渡す）を返す。授業のチームのサイトなら科目（course）も付く。開けないリンクはstatusとreasonを返す。本人にリンクを開くよう頼む代わりに使う。 / Open a SharePoint / OneDrive for Business link (sharing link, file or folder URL, personal OneDrive, Teams file link) with UniContext’s signed-in Microsoft session, read-only. A file is downloaded and returned with its document id, local path and extracted text; a folder returns its files (document ids for download_course_file) and subfolders. Links that cannot be opened return status and reason. Use it instead of asking the student to open the link.',
      remoteDescription:
        'メールや投稿にあるSharePoint / OneDrive for Businessのリンク（共有リンク、ファイルやフォルダーのURL、〜-my.sharepoint.comの個人のOneDrive、Teamsのファイルリンク）を、UniContextのサインイン済みのMicrosoftセッションで開く（読み取りのみ）。ファイルはdocument idと抽出した本文（maxCharsで打ち切り）を返し、link=trueのときはこの接続だけが約10分間ダウンロードできるリンクも返す。フォルダーは中のファイル（document idつき、download_course_fileで開ける）とサブフォルダー（urlをopen_linkに渡す）を返す。授業のチームのサイトなら科目（course）も付く。開けないリンクはstatusとreasonを返す。本人にリンクを開くよう頼む代わりに使う。 / Open a SharePoint / OneDrive link with UniContext’s signed-in Microsoft session (read-only): a file returns its document id and extracted text (link=true adds a ~10-minute download link for this client); a folder returns its files (ids for download_course_file) and subfolders. Unopenable links return status and reason.',
    },
    {
      url: z
        .string()
        .min(8)
        .max(MAX_LINK_LENGTH)
        .describe(
          'SharePoint / OneDriveのURL（メールにあるまま） / The SharePoint or OneDrive URL as it appears',
        ),
      includeText: z
        .boolean()
        .optional()
        .describe('抽出した本文を返す（既定true） / Return the extracted text (default true)'),
      maxChars: z
        .number()
        .int()
        .min(200)
        .max(100_000)
        .optional()
        .describe('本文の最大文字数（既定20000） / Max characters of text (default 20000)'),
      ...(remote
        ? {
            link: z
              .boolean()
              .optional()
              .describe(
                '約10分有効のダウンロードリンクも返す（この接続のみ） / Also return a ~10-minute download link (this client only)',
              ),
          }
        : {}),
    },
    async (a) => {
      const includeText = a.includeText !== false;
      const run =
        ctx.openLink ??
        ((url: string, o: { extract: boolean }) => {
          if (!ctx.filesDir) throw new ValidationError('opening links is not available here');
          return openLink(uc, url, {
            filesDir: ctx.filesDir,
            extract: o.extract,
            ...(ctx.downloadFiles ? { downloadFiles: ctx.downloadFiles } : {}),
          });
        });
      const report = await run(a.url, { extract: true });
      if (report.status === 'folder')
        return {
          data: {
            status: 'folder',
            url: report.url,
            folder: report.folder,
            files: report.files ?? [],
            folders: report.folders ?? [],
            truncated: report.truncated === true,
            ...(report.warnings.length ? { warnings: report.warnings } : {}),
            ...(report.files?.length
              ? { citations: uc.context.citationsFor(report.files.map((f) => f.id)) }
              : {}),
          },
        };
      if (report.status !== 'file' || !report.file)
        return {
          data: {
            status: report.status,
            url: report.url,
            reason: report.reason ?? 'unknown',
          },
          options: { hint: FAILURE_HINT },
        };
      const r = report.file;
      const ok = r.status === 'downloaded' || r.status === 'cached';
      const { path: localPath, ref: _ref, ...meta } = r;
      const file = remote ? meta : { ...meta, ...(localPath ? { path: localPath } : {}) };
      const text = ok && includeText ? fileTextExcerpt(uc, r.id, a.maxChars ?? 20_000) : undefined;
      const wantsLink = remote && (a as { link?: boolean }).link === true;
      const link = ok && wantsLink ? ctx.fileLink?.(r.id) : undefined;
      return {
        data: {
          status: 'file',
          url: report.url,
          file,
          ...(text
            ? {
                text: {
                  excerpt: text.text,
                  truncated: text.truncated,
                  chunks: text.chunks,
                  totalChars: text.totalChars,
                },
              }
            : {}),
          ...(ok && includeText && !text?.chunks
            ? {
                textUnavailable:
                  '本文を抽出できない形式か、本文がありません（Excel・画像・動画など） / no text could be extracted from this file type',
              }
            : {}),
          ...(link ? { link } : {}),
          ...(wantsLink && !link ? { linkUnavailable: true } : {}),
          ...(report.warnings.length ? { warnings: report.warnings } : {}),
          citations: uc.context.citationsFor([r.id]),
        },
      };
    },
  );
}
