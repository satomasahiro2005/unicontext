import { loadConfig, parseDuration } from '@unicontext/core';
import {
  accessOf,
  GUEST_ROLES,
  guestActive,
  GuestStore,
  type GuestRole,
  type StoredGuest,
} from '@unicontext/daemon/lib';
import {
  ACCESS_CATEGORIES,
  ACCESS_LABELS,
  ACCESS_PRESETS,
  type AccessCategory,
  parseAccess,
} from '@unicontext/mcp';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';

function store(ctx: CliContext): GuestStore {
  if (ctx.dev) throw new UsageError('--devでは共有を扱えません', '--devを外して実行してください');
  return GuestStore.forPaths(ctx.paths(), () => ctx.deps.now());
}

const shortTime = (iso: string | undefined): string =>
  iso ? iso.replace('T', ' ').slice(0, 16) : '-';

const allowed = (g: StoredGuest): AccessCategory[] =>
  ACCESS_CATEGORIES.filter((c) => accessOf(g).has(c));

function categories(words: readonly string[]): AccessCategory[] {
  const { categories: cs, unknown } = parseAccess(words);
  if (unknown.length > 0)
    throw new UsageError(
      `「${unknown.join('、')}」は範囲の名前ではありません`,
      '「unicontext share categories」で一覧できます',
    );
  return cs;
}

function connectorUrl(ctx: CliContext): string {
  const publicUrl = loadConfig(ctx.configFile()).remote.publicUrl;
  if (!publicUrl)
    throw new CliError('remote.publicUrlが未設定なので共有できません（docs/remote.md）', 1);
  return publicUrl.replace(/\/+$/, '');
}

function printCode(ctx: CliContext, g: StoredGuest, code: string, url: string): void {
  ctx.out(`  接続先:      ${url}`);
  ctx.out(`  招待コード:  ${ctx.style.bold(code)}`);
  ctx.out(
    `  見られるもの: ${
      allowed(g)
        .map((c) => ACCESS_LABELS[c])
        .join('・') || '（なし）'
    }`,
  );
  ctx.out(
    ctx.style.dim(`  招待コードはもう表示できません。取り消し: unicontext share revoke ${g.id}`),
  );
}

export function registerGuest(program: Command, h: Harness): void {
  const share = program
    .command('share')
    .alias('guest')
    .description(
      '家族や友達に見せる範囲を決めて共有する（その人のChatGPTやClaudeからコネクタで読める） / Share chosen parts with someone, read through their own AI',
    );

  share
    .command('add <name>')
    .description(
      '共有相手を追加して招待コードを出す（一度だけ表示） / Add someone and show their invite code once',
    )
    .option('--allow <categories...>', '見せる範囲（例: schedule,courses,deadlines／family）')
    .option(
      '--role <preset>',
      `範囲のひな形（${GUEST_ROLES.join(' / ')}）。--allowが優先`,
      'friend',
    )
    .option('--expires <duration>', '有効期限（例: 30d）。省略すると取り消すまで有効')
    .action(
      action<{ allow?: string[]; role: string; expires?: string }>(
        h,
        async (ctx, { args, opts }) => {
          const name = String(args[0] ?? '').trim();
          if (!name) throw new UsageError('名前を指定してください（unicontext share add <名前>）');
          if (!GUEST_ROLES.includes(opts.role as GuestRole))
            throw new UsageError(`--roleは${GUEST_ROLES.join(' / ')}のどちらかです`);
          const allow = opts.allow ? categories(opts.allow) : undefined;
          const url = connectorUrl(ctx);
          const { guest: g, code } = store(ctx).add({
            name,
            role: opts.role as GuestRole,
            ...(allow ? { allow } : {}),
            ...(opts.expires ? { ttlMs: parseDuration(opts.expires) } : {}),
          });
          if (ctx.json) {
            ctx.printJson(
              { id: g.id, name, allow: allowed(g), connector: url, code, expiresAt: g.expiresAt },
              { local: true },
            );
            return;
          }
          ctx.out(ctx.style.green(`${name}さんと共有しました`));
          printCode(ctx, g, code, url);
        },
      ),
    );

  share
    .command('allow <name> <categories...>')
    .description('見せる範囲を足す（すぐ反映） / Show more to someone')
    .action(
      action(h, async (ctx, { args }) => {
        const s = store(ctx);
        const key = String(args[0]);
        const g = s.find(key);
        if (!g) throw new CliError(`有効な共有相手「${key}」はいません`, 1);
        const next = new Set([...accessOf(g), ...categories(args[1] as string[])]);
        const updated = s.setAllow(
          g.id,
          ACCESS_CATEGORIES.filter((c) => next.has(c)),
        );
        if (updated)
          ctx.out(
            `${updated.name}: ${allowed(updated)
              .map((c) => ACCESS_LABELS[c])
              .join('・')}`,
          );
      }),
    );

  share
    .command('deny <name> <categories...>')
    .description('見せる範囲を減らす（すぐ反映） / Show less to someone')
    .action(
      action(h, async (ctx, { args }) => {
        const s = store(ctx);
        const key = String(args[0]);
        const g = s.find(key);
        if (!g) throw new CliError(`有効な共有相手「${key}」はいません`, 1);
        const drop = new Set(categories(args[1] as string[]));
        const updated = s.setAllow(
          g.id,
          ACCESS_CATEGORIES.filter((c) => accessOf(g).has(c) && !drop.has(c)),
        );
        if (updated)
          ctx.out(
            `${updated.name}: ${
              allowed(updated)
                .map((c) => ACCESS_LABELS[c])
                .join('・') || '（なし）'
            }`,
          );
      }),
    );

  share
    .command('code <name>')
    .description('招待コードを作り直す（古いコードは使えなくなる） / Issue a new invite code')
    .action(
      action(h, async (ctx, { args }) => {
        const key = String(args[0]);
        const url = connectorUrl(ctx);
        const r = store(ctx).newCode(key);
        if (!r) throw new CliError(`有効な共有相手「${key}」はいません`, 1);
        if (ctx.json) {
          ctx.printJson({ id: r.guest.id, connector: url, code: r.code }, { local: true });
          return;
        }
        printCode(ctx, r.guest, r.code, url);
      }),
    );

  share
    .command('categories')
    .description('見せる範囲の一覧 / The categories that can be shared')
    .action(
      action(h, async (ctx) => {
        if (ctx.json) {
          ctx.printJson({ categories: ACCESS_LABELS, presets: ACCESS_PRESETS }, { local: true });
          return;
        }
        for (const c of ACCESS_CATEGORIES) ctx.out(`  ${c.padEnd(14)}${ACCESS_LABELS[c]}`);
        for (const [p, cs] of Object.entries(ACCESS_PRESETS))
          if (p !== 'all') ctx.out(ctx.style.dim(`  ${p.padEnd(14)}= ${cs.join(',')}`));
      }),
    );

  share
    .command('list')
    .description('共有相手の一覧 / List the people you share with')
    .option('--all', '取り消し済み・期限切れも表示する / include revoked and expired')
    .action(
      action<{ all?: boolean }>(h, async (ctx, { opts }) => {
        const now = ctx.deps.now();
        const rows = store(ctx)
          .read()
          .filter((g) => opts.all || guestActive(g, now));
        if (ctx.json) {
          ctx.printJson(
            rows.map((g) => ({
              id: g.id,
              name: g.name,
              allow: allowed(g),
              createdAt: g.createdAt,
              lastUsedAt: g.lastUsedAt,
              expiresAt: g.expiresAt,
              revokedAt: g.revokedAt,
              active: guestActive(g, now),
            })),
            { local: true },
          );
          return;
        }
        if (rows.length === 0) {
          ctx.out(`  ${ctx.style.dim('共有相手はいません（unicontext share add <名前>）')}`);
          return;
        }
        printTable(
          ctx,
          [
            { header: 'ID', value: (g) => g.id },
            { header: '名前', value: (g) => ctx.text(g.name), max: 20 },
            { header: '見られるもの', value: (g) => allowed(g).join(',') },
            { header: '最終利用', value: (g) => shortTime(g.lastUsedAt) },
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

  share
    .command('revoke <idOrName>')
    .description('共有をやめる（つないだAIもすぐ読めなくなる） / Stop sharing')
    .action(
      action(h, async (ctx, { args }) => {
        const key = String(args[0] ?? '');
        const revoked = store(ctx).revoke(key);
        if (revoked.length === 0) throw new CliError(`有効な共有相手「${key}」はいません`, 1);
        if (ctx.json) ctx.printJson({ revoked: revoked.map((g) => g.id) }, { local: true });
        else
          for (const g of revoked) ctx.out(ctx.style.green(`取り消しました: ${g.name}（${g.id}）`));
      }),
    );
}
