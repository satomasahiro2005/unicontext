import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '@unicontext/core';
import {
  DEFAULT_TUNNEL_HOSTNAME,
  DEFAULT_TUNNEL_NAME,
  hashPassphrase,
  hostnameFromPublicUrl,
  passphraseProblem,
  RemoteStateStore,
  remoteAuditFile,
  tunnelConfigYaml,
} from '@unicontext/daemon/lib';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';

function store(ctx: CliContext): RemoteStateStore {
  if (ctx.dev)
    throw new UsageError(
      '--devではリモート接続の設定は扱えません',
      '--devを外して実行してください',
    );
  return RemoteStateStore.forPaths(ctx.paths(), () => ctx.deps.now());
}

function remoteConfig(ctx: CliContext) {
  return loadConfig(ctx.configFile()).remote;
}

async function readSecret(ctx: CliContext, question: string): Promise<string> {
  const ask = ctx.deps.promptSecret ?? ctx.deps.prompt;
  return ask(question);
}

interface ClientRow {
  clientId: string;
  type: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  activeGrants: number;
  scopes: string[];
}

function shortTime(iso: string | undefined): string {
  if (!iso) return '-';
  return iso.replace('T', ' ').slice(0, 16);
}

export function registerRemote(program: Command, h: Harness): void {
  const remote = program
    .command('remote')
    .description(
      'ChatGPT・claude.aiから読み取り専用で使うリモート接続を管理する / Manage the read-only remote MCP endpoint',
    );

  remote
    .command('status')
    .description('リモート接続の設定と状態を表示する / Show remote endpoint settings and state')
    .action(
      action(h, async (ctx) => {
        const cfg = remoteConfig(ctx);
        const s = store(ctx);
        const state = s.read();
        const lockedUntil =
          state.owner.lockedUntil && Date.parse(state.owner.lockedUntil) > ctx.deps.now().getTime()
            ? state.owner.lockedUntil
            : undefined;
        const out = {
          enabled: cfg.enabled,
          publicUrl: cfg.publicUrl ?? null,
          mcpUrl: cfg.publicUrl ? `${cfg.publicUrl.replace(/\/+$/, '')}/mcp` : null,
          listen: `http://127.0.0.1:${cfg.port}`,
          unlockConfigured: state.owner.passphrase !== undefined,
          lockedUntil: lockedUntil ?? null,
          clients: Object.keys(state.clients).length,
          activeGrants: s.activeGrants().length,
          stateFile: s.file,
          auditLog: remoteAuditFile(ctx.paths()),
        };
        if (ctx.json) {
          ctx.printJson(out, { local: true });
          return 0;
        }
        ctx.out(
          `  有効:           ${out.enabled ? 'はい' : 'いいえ（config.yamlのremote.enabled）'}`,
        );
        ctx.out(`  公開URL:        ${out.mcpUrl ?? '未設定（config.yamlのremote.publicUrl）'}`);
        ctx.out(`  待ち受け:       ${out.listen}（トンネルだけがここへ転送する）`);
        ctx.out(
          `  パスフレーズ:   ${out.unlockConfigured ? '設定済み' : '未設定（unicontext remote set-passphrase）'}`,
        );
        if (lockedUntil) ctx.out(ctx.style.red(`  ロック中:       ${shortTime(lockedUntil)}まで`));
        ctx.out(`  クライアント:   ${out.clients}（有効な許可${out.activeGrants}）`);
        ctx.out(`  監査ログ:       ${out.auditLog}`);
        return 0;
      }),
    );

  remote
    .command('set-passphrase')
    .description(
      '接続を許可するときに入力するパスフレーズを設定する / Set the owner passphrase used to approve connections',
    )
    .option(
      '--from-env <name>',
      '環境変数から読む（スクリプト用） / read it from an environment variable',
    )
    .action(
      action<{ fromEnv?: string }>(h, async (ctx, { opts }) => {
        const s = store(ctx);
        let passphrase: string;
        if (opts.fromEnv) {
          const v = ctx.deps.env[opts.fromEnv];
          if (!v) throw new UsageError(`環境変数${opts.fromEnv}が空です`);
          passphrase = v;
        } else {
          if (!ctx.canPrompt())
            throw new UsageError(
              '対話できない環境ではパスフレーズを入力できません',
              '端末から実行するか --from-env <環境変数名> を使ってください',
            );
          passphrase = await readSecret(ctx, '新しいパスフレーズ: ');
          const again = await readSecret(ctx, 'もう一度: ');
          if (passphrase === '')
            throw new CliError(
              '入力を読み取れませんでした。PowerShellなどのターミナルで直接実行してください',
              1,
            );
          if (passphrase !== again) throw new CliError('2回の入力が一致しません', 1);
        }
        const problem = passphraseProblem(passphrase);
        if (problem) throw new CliError(problem, 1);
        s.setPassphrase(await hashPassphrase(passphrase));
        if (ctx.json) ctx.printJson({ ok: true, stateFile: s.file }, { local: true });
        else ctx.out(ctx.style.green('パスフレーズを設定しました（scryptでハッシュ化して保存）'));
        return 0;
      }),
    );

  remote
    .command('clients')
    .description('接続を許可したクライアントの一覧 / List registered clients and their grants')
    .action(
      action(h, async (ctx) => {
        const s = store(ctx);
        const state = s.read();
        const ids = new Set([
          ...Object.keys(state.clients),
          ...s.activeGrants().map((g) => g.clientId),
        ]);
        const rows: ClientRow[] = [...ids].sort().map((id) => {
          const c = state.clients[id];
          const grants = s.activeGrants(id);
          const lastUsed = [c?.lastUsedAt, ...grants.map((g) => g.lastUsedAt)]
            .filter((x): x is string => Boolean(x))
            .sort()
            .at(-1);
          return {
            clientId: id,
            type: c?.type ?? 'unknown',
            name: c?.name ?? '',
            createdAt: c?.createdAt ?? '',
            lastUsedAt: lastUsed ?? '',
            activeGrants: grants.length,
            // What the active grants allow: read only, or read + write (record tools).
            scopes: [...new Set(grants.flatMap((g) => g.scope.split(' ')))]
              .filter((x) => x.startsWith('unicontext.'))
              .sort(),
          };
        });
        if (ctx.json) {
          ctx.printJson(rows, { local: true });
          return 0;
        }
        if (rows.length === 0) {
          ctx.out(`  ${ctx.style.dim('なし')}`);
          return 0;
        }
        printTable(
          ctx,
          [
            { header: 'クライアントID', value: (r) => r.clientId, max: 48 },
            {
              header: '種類',
              value: (r) =>
                r.type === 'cimd' ? 'メタデータURL' : r.type === 'dcr' ? '動的登録' : '-',
            },
            { header: '名前', value: (r) => ctx.text(r.name) || '-', max: 24 },
            { header: '登録', value: (r) => shortTime(r.createdAt) },
            { header: '最終利用', value: (r) => shortTime(r.lastUsedAt) },
            { header: '有効な許可', value: (r) => String(r.activeGrants), align: 'right' },
            {
              header: '範囲',
              value: (r) =>
                r.scopes.length === 0
                  ? '-'
                  : r.scopes.includes('unicontext.write')
                    ? '読み取り＋追加'
                    : '読み取り',
            },
          ],
          rows,
        );
        return 0;
      }),
    );

  remote
    .command('revoke')
    .description(
      'クライアントの許可を取り消す（トークンは即座に無効） / Revoke a client (its tokens stop working immediately)',
    )
    .argument('[clientId]', 'unicontext remote clientsに出るクライアントID')
    .option('--all', 'すべてのクライアントを取り消す / revoke every client')
    .option('-y, --yes', '確認しない / do not ask')
    .action(
      action<{ all?: boolean; yes?: boolean }>(h, async (ctx, { args, opts }) => {
        const s = store(ctx);
        const clientId = args[0] === undefined ? undefined : String(args[0]);
        if (!clientId && !opts.all)
          throw new UsageError(
            '取り消すクライアントIDか --allを指定してください',
            '一覧は「unicontext remote clients」',
          );
        if (opts.all) {
          if (!(await ctx.confirmAction('すべてのクライアントの許可を取り消しますか？', opts.yes)))
            return 1;
          const r = s.revokeAll();
          if (ctx.json) ctx.printJson({ revoked: 'all', ...r }, { local: true });
          else
            ctx.out(ctx.style.green(`取り消しました（クライアント${r.clients}、許可${r.grants}）`));
          return 0;
        }
        const r = s.revokeClient(clientId as string);
        if (!r.found)
          throw new CliError(
            `クライアント${clientId}は見つかりません`,
            1,
            '一覧は「unicontext remote clients」',
          );
        if (ctx.json) ctx.printJson({ revoked: clientId, grants: r.grants }, { local: true });
        else
          ctx.out(
            ctx.style.green(
              `取り消しました（許可${r.grants}）。同じアプリは再接続に再度の許可が要ります`,
            ),
          );
        return 0;
      }),
    );

  remote
    .command('tunnel-config')
    .description(
      'cloudflaredの名前付きトンネル設定を出力する（リモート用の待ち受けだけを公開） / Print a cloudflared config that exposes only the remote listener',
    )
    .option(
      '--hostname <host>',
      `公開ホスト名（既定: remote.publicUrlか${DEFAULT_TUNNEL_HOSTNAME}）`,
    )
    .option('--tunnel <name>', `トンネル名またはUUID（既定: ${DEFAULT_TUNNEL_NAME}）`)
    .option('--credentials-file <file>', 'cloudflared tunnel createが作った資格情報JSON')
    .option('--write <file>', 'ファイルに書き出す / write to a file instead of stdout')
    .option('--force', '既存のファイルを上書きする / overwrite')
    .action(
      action<{
        hostname?: string;
        tunnel?: string;
        credentialsFile?: string;
        write?: string;
        force?: boolean;
      }>(h, async (ctx, { opts }) => {
        const cfg = remoteConfig(ctx);
        const hostname =
          opts.hostname ?? hostnameFromPublicUrl(cfg.publicUrl) ?? DEFAULT_TUNNEL_HOSTNAME;
        const tunnel = opts.tunnel ?? DEFAULT_TUNNEL_NAME;
        if (opts.write && !opts.credentialsFile)
          throw new UsageError(
            '--writeには --credentials-fileが必要です',
            '「cloudflared tunnel create unicontext」が出力した <UUID>.jsonのパスを指定してください',
          );
        const credentialsFile =
          opts.credentialsFile ?? path.join(homedir(), '.cloudflared', '<TUNNEL-UUID>.json');
        const yaml = tunnelConfigYaml({ hostname, tunnel, credentialsFile, port: cfg.port });
        const publicUrl = `https://${hostname}`;
        const notes: string[] = [];
        if (!cfg.enabled) notes.push('config.yamlでremote.enabled: trueにしてください');
        if (cfg.publicUrl !== publicUrl && cfg.publicUrl !== `${publicUrl}/`)
          notes.push(`config.yamlのremote.publicUrlを${publicUrl}にしてください`);
        if (opts.write) {
          const file = path.resolve(opts.write);
          if (existsSync(file) && !opts.force)
            throw new CliError(`${file}は既にあります`, 1, '上書きするなら--force');
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, yaml);
          if (ctx.json)
            ctx.printJson({ file, hostname, tunnel, port: cfg.port, notes }, { local: true });
          else {
            ctx.out(ctx.style.green(`書き出しました: ${file}`));
            for (const n of notes) ctx.err(`注意: ${n}`);
          }
          return 0;
        }
        if (ctx.json) {
          ctx.printJson({ yaml, hostname, tunnel, port: cfg.port, notes }, { local: true });
          return 0;
        }
        ctx.deps.stdout(yaml);
        for (const n of notes) ctx.err(`注意: ${n}`);
        return 0;
      }),
    );
}
