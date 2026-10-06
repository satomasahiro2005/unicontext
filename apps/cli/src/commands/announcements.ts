import {
  type AnnouncementItem,
  openAnnouncements,
  type OpenAnnouncementsReport,
} from '@unicontext/context-engine';
import type {
  AnnouncementReadResponse,
  UnopenedAnnouncementsResponse,
} from '@unicontext/daemon/api-types';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { UsageError } from '../errors.js';
import { shortTime } from '../format/common.js';
import { printSection, printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';

/*
 * `unicontext announcements open <id…>` / `--unread-all`: fetch the bodies of LiveCampusU notices
 * that are unread there. Opening one marks it READ in LiveCampusU and LCU cannot set it back, so
 * the sync never does it; only this explicit request does (through the daemon when it runs: it
 * holds the LCU session and serializes this with the sync). UniContext keeps them 未読 until they
 * are read in UniContext (`unicontext announcements read <id>` or the Web UI).
 */

const BATCH = 10;
/** Waiting for a running sync plus LiveCampusU's 1 request/s pacing can take a while. */
const OPEN_TIMEOUT_MS = 15 * 60_000;

const STATUS_LABELS: Record<OpenAnnouncementsReport['results'][number]['status'], string> = {
  opened: '取得',
  alreadyFetched: '取得済み',
  notFound: '見つからない',
  unsupported: '対象外',
  failed: '失敗',
};

async function openVia(ctx: CliContext, ids: string[]): Promise<OpenAnnouncementsReport> {
  const daemon = await ctx.daemon();
  if (daemon)
    return daemon.post<OpenAnnouncementsReport>(
      '/api/v1/announcements/open',
      { ids },
      { timeoutMs: OPEN_TIMEOUT_MS },
    );
  const rt = await ctx.runtime();
  return openAnnouncements(rt.uc, ids);
}

async function unopened(ctx: CliContext): Promise<AnnouncementItem[]> {
  const daemon = await ctx.daemon();
  if (daemon)
    return (await daemon.get<UnopenedAnnouncementsResponse>('/api/v1/announcements/unopened'))
      .announcements;
  return (await ctx.runtime()).uc.context.unopenedAnnouncements();
}

export function registerAnnouncements(program: Command, h: Harness): void {
  const announcements = program
    .command('announcements')
    .description('お知らせの本文の取得と既読の管理 / Fetch notice bodies and manage read state');

  announcements
    .command('open')
    .description(
      '未読のお知らせの本文を取得する（LiveCampusUで既読になり、元に戻せません） / Fetch bodies (marks them read in LiveCampusU)',
    )
    .argument('[ids...]', 'announcement:… のID')
    .option('--unread-all', '本文のない未読のお知らせをすべて取得する / every unread notice')
    .option('--yes', '確認の質問を省略する / skip the y/N question')
    .action(
      action<{ unreadAll?: boolean; yes?: boolean }>(h, async (ctx, { args, opts }) => {
        const given = (Array.isArray(args[0]) ? (args[0] as string[]) : []).filter(Boolean);
        if (given.length > 0 && opts.unreadAll)
          throw new UsageError('IDと「--unread-all」は同時に指定できません');
        let ids = given;
        if (opts.unreadAll) {
          // Unread without a body: not opened (openUnreadNotices off) or waiting for a later sync.
          const list = (await unopened(ctx)).filter(
            (a) => a.bodyStatus === 'notOpened' || (a.bodyStatus === 'pending' && a.read === false),
          );
          if (list.length === 0) {
            if (ctx.json) ctx.printJson({ results: [], opened: 0, markedReadAtSource: 0 });
            else ctx.out('本文を取得していない未読のお知らせはありません');
            return 0;
          }
          if (!ctx.json) {
            printSection(ctx, '本文を取得していない未読のお知らせ', list.length);
            printTable(
              ctx,
              [
                { header: '日時', value: (a) => shortTime(a.publishedAt, 'Asia/Tokyo') },
                { header: '件名', value: (a) => ctx.text(a.title), max: 50 },
              ],
              list.slice(0, 20),
            );
            if (list.length > 20) ctx.out(ctx.style.dim(`  ほか${list.length - 20}件`));
          }
          ids = list.map((a) => a.id);
        }
        if (ids.length === 0)
          throw new UsageError(
            '取得するお知らせのIDを指定してください',
            '「unicontext announcements open --unread-all」で本文のない未読をすべて取得できます',
          );
        ctx.assertCanConfirm(opts.yes);
        const ok = await ctx.confirmAction(
          `${ids.length}件のお知らせを開きます。LiveCampusUではすべて既読になり、未読に戻せません。続けますか？`,
          opts.yes,
        );
        if (!ok) {
          ctx.err('キャンセルしました（何も開いていません）');
          return 1;
        }
        const all: OpenAnnouncementsReport = {
          results: [],
          opened: 0,
          markedReadAtSource: 0,
          warnings: [],
        };
        for (let i = 0; i < ids.length; i += BATCH) {
          const r = await openVia(ctx, ids.slice(i, i + BATCH));
          all.results.push(...r.results);
          all.opened += r.opened;
          all.markedReadAtSource += r.markedReadAtSource;
          all.warnings.push(...r.warnings);
        }
        if (ctx.json) {
          ctx.printJson(all);
        } else {
          printTable(
            ctx,
            [
              { header: 'ID', value: (r) => r.id },
              { header: '件名', value: (r) => ctx.text(r.title ?? ''), max: 40 },
              { header: '結果', value: (r) => STATUS_LABELS[r.status] },
              { header: 'LCU', value: (r) => (r.markedReadAtSource ? '既読になった' : '') },
            ],
            all.results,
          );
          ctx.out(
            ctx.style.green(
              `${all.opened}件の本文を取得しました（LiveCampusUで既読になったもの${all.markedReadAtSource}件）。UniContextでは読むまで未読のままです`,
            ),
          );
        }
        return all.results.some((r) => r.status === 'failed') ? 1 : 0;
      }),
    );

  announcements
    .command('read')
    .description(
      'UniContextの中で既読にする（LiveCampusUには何もしない） / Mark read in UniContext only',
    )
    .argument('<ids...>', 'announcement:… のID')
    .option('--unread', '未読に戻す / mark unread again')
    .action(
      action<{ unread?: boolean }>(h, async (ctx, { args, opts }) => {
        const ids = (Array.isArray(args[0]) ? (args[0] as string[]) : []).filter(Boolean);
        const daemon = await ctx.daemon();
        const done: AnnouncementItem[] = [];
        for (const id of ids) {
          if (daemon)
            done.push(
              (
                await daemon.post<AnnouncementReadResponse>(
                  `/api/v1/announcements/${encodeURIComponent(id)}/read`,
                  { read: !opts.unread },
                )
              ).announcement,
            );
          else done.push((await ctx.runtime()).uc.context.setAnnouncementRead(id, !opts.unread));
        }
        if (ctx.json) ctx.printJson({ announcements: done });
        else
          ctx.out(ctx.style.green(`${done.length}件を${opts.unread ? '未読' : '既読'}にしました`));
      }),
    );
}
