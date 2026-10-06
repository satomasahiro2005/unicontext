import {
  downloadCourseFiles,
  type DownloadFilesReport,
  MAX_DOWNLOADS_PER_REQUEST,
  mirrorFiles,
  type MirrorReport,
  openLink,
  type OpenLinkReport,
} from '@unicontext/context-engine';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { UsageError } from '../errors.js';
import { printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';

/*
 * `unicontext files download <id|course/path…>`: download class files (Teams/SharePoint) to this
 * computer, read-only at the source; their text becomes searchable. `unicontext files mirror`:
 * one pass of the opt-in mirror (`sources.teams-web.mirror`). Both go through the daemon when it
 * runs (it holds the browser profile and serializes this with the sync).
 */

/** Waiting for a running sync plus the pacing between files can take a while. */
const TIMEOUT_MS = 30 * 60_000;

const STATUS_LABELS: Record<DownloadFilesReport['results'][number]['status'], string> = {
  downloaded: 'ダウンロード',
  cached: '保存済み',
  tooLarge: '大きすぎる',
  notFound: '見つからない',
  unsupported: '対象外',
  failed: '失敗',
};

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function downloadVia(
  ctx: CliContext,
  ids: string[],
  extract: boolean,
): Promise<DownloadFilesReport> {
  const daemon = await ctx.daemon();
  if (daemon)
    return daemon.post<DownloadFilesReport>(
      '/api/v1/files/download',
      { ids, extract },
      { timeoutMs: TIMEOUT_MS },
    );
  const rt = await ctx.runtime();
  return downloadCourseFiles(rt.uc, ids, { filesDir: rt.filesDir, extract });
}

async function mirrorVia(ctx: CliContext, sourceId: string | undefined): Promise<MirrorReport> {
  const daemon = await ctx.daemon();
  if (daemon)
    return daemon.post<MirrorReport>('/api/v1/files/mirror', sourceId ? { sourceId } : {}, {
      timeoutMs: TIMEOUT_MS,
    });
  const rt = await ctx.runtime();
  return mirrorFiles(rt.uc, { filesDir: rt.filesDir, ...(sourceId ? { sourceId } : {}) });
}

async function openLinkVia(
  ctx: CliContext,
  url: string,
  extract: boolean,
): Promise<OpenLinkReport> {
  const daemon = await ctx.daemon();
  if (daemon)
    return daemon.post<OpenLinkReport>(
      '/api/v1/files/open-link',
      { url, extract },
      { timeoutMs: TIMEOUT_MS },
    );
  const rt = await ctx.runtime();
  return openLink(rt.uc, url, { filesDir: rt.filesDir, extract });
}

export function registerFiles(program: Command, h: Harness): void {
  const files = program
    .command('files')
    .description('授業ファイル（Teams/SharePoint）のダウンロードとミラー / Class files');

  files
    .command('download')
    .description(
      '授業ファイルをこのPCにダウンロードし、本文を検索できるようにする（大学側は読み取りのみ） / Download class files',
    )
    .argument('<files...>', 'document:… のID、または「科目名/フォルダ/ファイル名」')
    .option('--no-text', '本文を抽出しない / do not extract text')
    .action(
      action<{ text?: boolean }>(h, async (ctx, { args, opts }) => {
        const refs = (Array.isArray(args[0]) ? (args[0] as string[]) : []).filter(Boolean);
        if (refs.length === 0) throw new UsageError('ダウンロードするファイルを指定してください');
        const all: DownloadFilesReport = { results: [], downloaded: 0, warnings: [] };
        for (let i = 0; i < refs.length; i += MAX_DOWNLOADS_PER_REQUEST) {
          const r = await downloadVia(
            ctx,
            refs.slice(i, i + MAX_DOWNLOADS_PER_REQUEST),
            opts.text !== false,
          );
          all.results.push(...r.results);
          all.downloaded += r.downloaded;
          all.warnings.push(...r.warnings);
        }
        if (ctx.json) ctx.printJson(all);
        else {
          printTable(
            ctx,
            [
              { header: 'ファイル', value: (r) => ctx.text(r.title ?? r.ref), max: 40 },
              { header: '結果', value: (r) => STATUS_LABELS[r.status] },
              { header: 'サイズ', value: (r) => formatBytes(r.bytes ?? r.sizeBytes) },
              {
                header: '本文',
                value: (r) => (r.text ? `${r.text.chunks}チャンク` : ''),
              },
              { header: '保存先', value: (r) => r.path ?? r.error ?? '' },
            ],
            all.results,
          );
          for (const w of all.warnings) ctx.err(ctx.style.dim(`  ${w}`));
        }
        return all.results.some((r) => r.status === 'failed' || r.status === 'notFound') ? 1 : 0;
      }),
    );

  files
    .command('open')
    .description(
      'SharePoint / OneDriveのリンク（メールの共有リンクなど）を開く：ファイルはダウンロードして本文を検索できるように、フォルダーは中身を一覧（大学側は読み取りのみ） / Open a SharePoint or OneDrive link',
    )
    .argument('<url>', 'SharePoint / OneDriveのURL')
    .option('--no-text', '本文を抽出しない / do not extract text')
    .action(
      action<{ text?: boolean }>(h, async (ctx, { args, opts }) => {
        const url = typeof args[0] === 'string' ? args[0] : '';
        if (!url) throw new UsageError('開くリンクを指定してください');
        const r = await openLinkVia(ctx, url, opts.text !== false);
        if (ctx.json) ctx.printJson(r);
        else if (r.status === 'file' && r.file) {
          const f = r.file;
          ctx.out(`${ctx.text(f.title ?? '')}  ${f.id}`);
          ctx.out(
            `  ${STATUS_LABELS[f.status]}  ${formatBytes(f.bytes ?? f.sizeBytes)}${f.text ? `  本文${f.text.chunks}チャンク` : ''}${f.course ? `  ${ctx.text(f.course.title)}` : ''}`,
          );
          if (f.path ?? f.error) ctx.out(`  ${f.path ?? f.error}`);
        } else if (r.status === 'folder') {
          ctx.out(
            `${ctx.text(r.folder?.name ?? '')}/${r.folder?.course ? `  ${ctx.text(r.folder.course.title)}` : ''}`,
          );
          for (const d of r.folders ?? []) ctx.out(`  ${ctx.text(d.name)}/  ${d.url ?? ''}`);
          for (const f of r.files ?? [])
            ctx.out(`  ${ctx.text(f.name)}  ${formatBytes(f.sizeBytes)}  ${f.id}`);
          if (r.truncated) ctx.out('  …（一部だけ表示）');
        } else ctx.out(`${r.status}: ${r.reason ?? ''}`);
        for (const w of r.warnings) ctx.err(ctx.style.dim(`  ${w}`));
        return r.status === 'file' || r.status === 'folder' ? 0 : 1;
      }),
    );

  files
    .command('mirror')
    .description(
      'ミラー（sources.<id>.mirror）を1回更新する：新しい・変わったファイルをダウンロード、消えたものは.trashへ / Run one mirror pass',
    )
    .option('--source <id>', 'ソースID（既定: ミラーが有効なすべて）')
    .action(
      action<{ source?: string }>(h, async (ctx, { opts }) => {
        const r = await mirrorVia(ctx, opts.source);
        if (ctx.json) ctx.printJson(r);
        else if (r.sources.length === 0)
          ctx.out(
            'ミラーが有効なソースはありません（config.yamlのsources.teams-web.mirror.enabled）',
          );
        else
          for (const s of r.sources) {
            if (!s.enabled) {
              ctx.out(`${s.sourceId}: ミラーは無効です`);
              continue;
            }
            ctx.out(`${s.sourceId}: ${s.root}`);
            ctx.out(
              `  対象${s.wanted}件・保存済み${s.present}件・ダウンロード${s.downloaded}件（${formatBytes(s.bytesDownloaded)}）・移動${s.renamed}件・ゴミ箱へ${s.trashed}件・大きすぎて除外${s.skippedTooLarge}件・失敗${s.failed}件・残り${s.remaining}件・本文抽出${s.textExtracted}件`,
            );
          }
        for (const w of r.warnings) ctx.err(ctx.style.dim(`  ${w}`));
        return r.sources.some((s) => s.failed > 0) ? 1 : 0;
      }),
    );
}
