import { loadConfig, parseDuration } from '@unicontext/core';
import { GUEST_ROLES, guestActive, GuestStore, type GuestRole } from '@unicontext/daemon/lib';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';

function store(ctx: CliContext): GuestStore {
  if (ctx.dev) throw new UsageError('--devではゲストを扱えません', '--devを外して実行してください');
  return GuestStore.forPaths(ctx.paths(), () => ctx.deps.now());
}

const ROLE_LABEL: Record<GuestRole, string> = {
  friend: '友達（時間割だけ）',
  family: '家族（時間割・締切・提出状況）',
};

const shortTime = (iso: string | undefined): string =>
  iso ? iso.replace('T', ' ').slice(0, 16) : '-';

export function registerGuest(program: Command, h: Harness): void {
  const guest = program
    .command('guest')
    .description(
      '家族や友達に読み取り専用の予定ページを共有する / Share a read-only schedule page with family or friends',
    );

  guest
    .command('add <name>')
    .description('共有リンクを作る（リンクは一度だけ表示） / Create a share link (shown once)')
    .option('--role <role>', 'friend＝時間割だけ、family＝締切・提出状況も', 'friend')
    .option('--expires <duration>', '有効期限（例: 30d）。省略すると取り消すまで有効')
    .action(
      action<{ role: string; expires?: string }>(h, async (ctx, { args, opts }) => {
        const name = String(args[0] ?? '').trim();
        if (!name) throw new UsageError('名前を指定してください（unicontext guest add <名前>）');
        if (!GUEST_ROLES.includes(opts.role as GuestRole))
          throw new UsageError(`--roleは${GUEST_ROLES.join(' / ')}のどちらかです`);
        const publicUrl = loadConfig(ctx.configFile()).remote.publicUrl;
        if (!publicUrl)
          throw new CliError(
            'remote.publicUrlが未設定なので共有リンクを作れません（docs/remote.md）',
            1,
          );
        const { guest: g, token } = store(ctx).add({
          name,
          role: opts.role as GuestRole,
          ...(opts.expires ? { ttlMs: parseDuration(opts.expires) } : {}),
        });
        const url = `${publicUrl.replace(/\/+$/, '')}/g/${token}`;
        const mcpUrl = `${url}/mcp`;
        if (ctx.json) {
          ctx.printJson({ ...g, tokenHash: undefined, url, mcpUrl }, { local: true });
          return;
        }
        ctx.out(ctx.style.green(`${name}さん用の共有リンクを作りました（${ROLE_LABEL[g.role]}）`));
        ctx.out(`  ページ:    ${url}`);
        ctx.out(`  コネクタ:  ${mcpUrl}`);
        ctx.out(
          ctx.style.dim(
            `  このリンクはもう表示できません。取り消し: unicontext guest revoke ${g.id}`,
          ),
        );
      }),
    );

  guest
    .command('list')
    .description('共有先の一覧 / List guests')
    .option('--all', '取り消し済み・期限切れも表示する / include revoked and expired')
    .action(
      action<{ all?: boolean }>(h, async (ctx, { opts }) => {
        const now = ctx.deps.now();
        const rows = store(ctx)
          .read()
          .filter((g) => opts.all || guestActive(g, now));
        if (ctx.json) {
          ctx.printJson(
            rows.map((g) => ({ ...g, tokenHash: undefined, active: guestActive(g, now) })),
            { local: true },
          );
          return;
        }
        if (rows.length === 0) {
          ctx.out(`  ${ctx.style.dim('共有先はありません（unicontext guest add <名前>）')}`);
          return;
        }
        printTable(
          ctx,
          [
            { header: 'ID', value: (g) => g.id },
            { header: '名前', value: (g) => ctx.text(g.name), max: 20 },
            { header: '範囲', value: (g) => ROLE_LABEL[g.role] },
            { header: '作成', value: (g) => shortTime(g.createdAt) },
            { header: '最終閲覧', value: (g) => shortTime(g.lastUsedAt) },
            {
              header: '状態',
              value: (g) =>
                g.revokedAt
                  ? '取り消し済み'
                  : g.expiresAt
                    ? `${shortTime(g.expiresAt)}まで`
                    : '有効',
            },
          ],
          rows,
        );
      }),
    );

  guest
    .command('revoke <idOrName>')
    .description('共有を取り消す（すぐにリンクが使えなくなる） / Revoke a share link')
    .action(
      action(h, async (ctx, { args }) => {
        const key = String(args[0] ?? '');
        const revoked = store(ctx).revoke(key);
        if (revoked.length === 0) throw new CliError(`有効な共有先「${key}」はありません`, 1);
        if (ctx.json) ctx.printJson({ revoked: revoked.map((g) => g.id) }, { local: true });
        else
          for (const g of revoked) ctx.out(ctx.style.green(`取り消しました: ${g.name}（${g.id}）`));
      }),
    );
}
