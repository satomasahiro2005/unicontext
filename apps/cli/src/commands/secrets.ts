import {
  type CredentialSecret,
  type SavedCredentialsAdapter,
  type SourceAdapter,
  supportsSavedCredentials,
} from '@unicontext/connector-sdk';
import { type NamedSecret, namedSecrets, type SecretStore, secretKey } from '@unicontext/core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';

/** A secret a source's config names, and whether the SecretStore holds a value for it. */
export interface SecretStatus extends NamedSecret {
  sourceId: string;
  key: string;
  set: boolean;
}

/** The source's adapter when it signs in by itself with saved credentials (SavedCredentialsAdapter). */
async function credentialAdapter(
  ctx: CliContext,
  sourceId: string,
): Promise<SavedCredentialsAdapter | undefined> {
  const rt = await ctx.runtime();
  let adapter: SourceAdapter;
  try {
    adapter = rt.uc.sync.getSource(sourceId).adapter;
  } catch {
    return undefined; // disabled or not loaded: only the config's secrets apply
  }
  return supportsSavedCredentials(adapter) ? adapter : undefined;
}

const asNamed = (c: CredentialSecret): NamedSecret => ({
  secret: c.secret,
  target: c.label,
  via: 'login',
});

/**
 * The secrets `sources.<id>.envSecrets / headerSecrets` name (effective config, profile merged),
 * plus the sign-in credentials an adapter may store (opt-in, SavedCredentialsAdapter).
 */
async function secretsOfSource(ctx: CliContext, sourceId: string): Promise<NamedSecret[]> {
  const rt = await ctx.runtime();
  const config = rt.config.sources[sourceId];
  if (!config)
    throw new CliError(
      `ソース「${sourceId}」は登録されていません`,
      1,
      `config.yamlのsourcesにsources.${sourceId}を追加してください（「unicontext sources」で一覧できます）`,
    );
  const named = namedSecrets(config as Record<string, unknown>);
  const adapter = await credentialAdapter(ctx, sourceId);
  for (const c of adapter?.credentialSecrets() ?? [])
    if (!named.some((n) => n.secret === c.secret)) named.push(asNamed(c));
  return named;
}

async function statusOf(
  store: SecretStore,
  sourceId: string,
  named: NamedSecret[],
): Promise<SecretStatus[]> {
  const out: SecretStatus[] = [];
  for (const n of named) {
    const key = secretKey(sourceId, n.secret);
    const value = await store.get(key);
    out.push({ ...n, sourceId, key, set: value !== undefined && value !== '' });
  }
  return out;
}

/** The SecretStore, refusing one that would forget the value when this command exits. */
async function persistentStore(ctx: CliContext): Promise<SecretStore> {
  const store = await ctx.secrets();
  if (store.backend === 'memory')
    throw new CliError(
      'OSキーチェーンを使えないため保存できません（このコマンドの終了とともに失われます）',
      1,
      ctx.noKeychain
        ? '--no-keychainと--devを外して実行してください'
        : '「unicontext doctor」でキーチェーンの状態を確認してください',
    );
  return store;
}

function promptLabel(s: NamedSecret, echo = false): string {
  if (s.via === 'login')
    return echo
      ? `${s.target}を入力してEnter: `
      : `${s.target}を入力してEnter（入力は表示されません）: `;
  return `${s.target}（${s.secret}）を貼り付けてEnter（入力は表示されません）: `;
}

/** Ask for one secret (without echo unless `echo`). Empty input is an error (nothing is stored). */
async function askSecret(ctx: CliContext, s: NamedSecret, echo = false): Promise<string> {
  const ask = echo ? ctx.deps.prompt : (ctx.deps.promptSecret ?? ctx.deps.prompt);
  const value = (await ask(promptLabel(s, echo))).trim();
  if (value === '')
    throw new CliError(
      '入力を読み取れませんでした（何も保存していません）',
      1,
      'PowerShellなどのターミナルで直接実行してください',
    );
  return value;
}

/**
 * Used by `unicontext login <source>` for a source that can sign in again by itself
 * (SavedCredentialsAdapter): offer to store the sign-in credentials in the OS keychain, ask for
 * the missing ones (the password without echo), and reset the adapter's attempt limits. `choice`
 * is `--save-password` (true: no question) / `--no-save-password` (false: never). Returns the
 * secret names that were stored. Never asks without a terminal or in `--json`.
 */
export async function offerSavedCredentials(
  ctx: CliContext,
  sourceId: string,
  adapter: SourceAdapter,
  choice: boolean | undefined,
): Promise<string[]> {
  if (choice === false || !supportsSavedCredentials(adapter)) return [];
  if (ctx.json || !ctx.canPrompt()) return [];
  const creds = adapter.credentialSecrets();
  if (creds.length === 0) return [];
  const store = await ctx.secrets();
  const missing: CredentialSecret[] = [];
  for (const c of creds) {
    const v = await store.get(secretKey(sourceId, c.secret));
    if (v === undefined || v === '') missing.push(c);
  }
  if (missing.length === 0) return [];
  if (choice !== true) {
    const answer = (
      await ctx.deps.prompt(
        'パスワードをOSキーチェーンに保存して、セッションが切れたらUniContextが自動でサインインし直すようにしますか？（二段階認証などが出たときは止まります） [y/N] ',
      )
    )
      .trim()
      .toLowerCase();
    if (answer !== 'y' && answer !== 'yes') return [];
  }
  if (store.backend === 'memory') {
    ctx.err(
      'OSキーチェーンを使えないため、パスワードは保存しません（このままサインインに進みます）',
    );
    return [];
  }
  const stored: string[] = [];
  for (const c of missing) {
    await store.set(secretKey(sourceId, c.secret), await askSecret(ctx, asNamed(c), c.echo));
    stored.push(c.secret);
  }
  await adapter.credentialsChanged();
  return stored;
}

/**
 * Used by `unicontext login <source>`: ask for every secret the source config names but the
 * SecretStore lacks, and store it. Returns the secret names that were stored. Throws when values
 * are missing and nobody can type them.
 */
export async function promptMissingSecrets(ctx: CliContext, sourceId: string): Promise<string[]> {
  const rt = await ctx.runtime();
  const config = rt.config.sources[sourceId];
  if (!config) return [];
  const named = namedSecrets(config as Record<string, unknown>);
  if (named.length === 0) return [];
  const store = await ctx.secrets();
  const missing = (await statusOf(store, sourceId, named)).filter((s) => !s.set);
  if (missing.length === 0) return [];
  if (!ctx.canPrompt())
    throw new CliError(
      `ソース「${sourceId}」の秘密情報が未設定です: ${missing.map((m) => m.secret).join(', ')}`,
      1,
      `端末から「unicontext login ${sourceId}」を実行するか、「unicontext secrets set ${sourceId} ${missing[0]?.secret ?? '<名前>'} --from-env <環境変数名>」を使ってください`,
    );
  if (!ctx.json)
    ctx.err(`ソース「${sourceId}」の秘密情報を入力してください（OSキーチェーンに保存します）`);
  const stored: string[] = [];
  for (const m of missing) {
    await store.set(m.key, await askSecret(ctx, m));
    stored.push(m.secret);
  }
  return stored;
}

function pickSecret(sourceId: string, named: NamedSecret[], name: string | undefined): NamedSecret {
  if (named.length === 0)
    throw new CliError(
      `ソース「${sourceId}」の設定には秘密情報（envSecrets / headerSecrets）がありません`,
      1,
      'config.yamlのsources.' +
        sourceId +
        'にenvSecretsを書いてください（docs/connectors/adapter-mcp.md）',
    );
  if (name === undefined) {
    const only = named.length === 1 ? named[0] : undefined;
    if (only) return only;
    throw new UsageError(
      `ソース「${sourceId}」には秘密情報が複数あります。名前を指定してください`,
      `候補: ${named.map((n) => n.secret).join(', ')}`,
    );
  }
  const hit = named.find((n) => n.secret === name);
  if (!hit)
    throw new UsageError(
      `ソース「${sourceId}」の設定に秘密情報「${name}」はありません`,
      `候補: ${named.map((n) => n.secret).join(', ')}`,
    );
  return hit;
}

export function registerSecrets(program: Command, h: Harness): void {
  const secrets = program
    .command('secrets')
    .description(
      'ソースのトークンなどをOSキーチェーンに保存する / Manage source credentials in the OS keychain',
    );

  secrets
    .command('list')
    .description(
      '設定が求める秘密情報と保存の有無（値は表示しない） / Show which named secrets are stored (never the values)',
    )
    .argument('[source]', 'ソースID（省略時はすべて） / source id (default: all)')
    .action(
      action(h, async (ctx, { args }) => {
        const only = args[0] === undefined ? undefined : String(args[0]);
        const rt = await ctx.runtime();
        const ids = only ? [only] : Object.keys(rt.config.sources).sort();
        const store = await ctx.secrets();
        const rows: SecretStatus[] = [];
        for (const id of ids)
          rows.push(...(await statusOf(store, id, await secretsOfSource(ctx, id))));
        if (ctx.json) {
          // key names avoid "secret"/"token": printJson redacts values under such keys
          ctx.printJson(
            {
              backend: store.backend,
              entries: rows.map((r) => ({
                sourceId: r.sourceId,
                name: r.secret,
                target: r.target,
                via: r.via,
                key: r.key,
                stored: r.set,
              })),
            },
            { local: true },
          );
          return 0;
        }
        if (rows.length === 0) {
          ctx.out(`  ${ctx.style.dim('秘密情報を使うソースはありません')}`);
          return 0;
        }
        printTable(
          ctx,
          [
            { header: 'ソース', value: (r: SecretStatus) => r.sourceId },
            { header: '名前', value: (r: SecretStatus) => r.secret },
            { header: '渡し先', value: (r: SecretStatus) => r.target },
            {
              header: '状態',
              value: (r: SecretStatus) => (r.set ? '保存済み' : '未設定'),
            },
          ],
          rows,
        );
        return 0;
      }),
    );

  secrets
    .command('set')
    .description(
      '秘密情報を入力してOSキーチェーンに保存する（表示しない） / Enter a secret without echo and store it',
    )
    .argument('<source>', 'ソースID（例: edstem） / source id')
    .argument(
      '[name]',
      '秘密情報の名前（1つだけなら省略可） / secret name (optional when there is one)',
    )
    .option(
      '--from-env <name>',
      '環境変数から読む（スクリプト用） / read it from an environment variable',
    )
    .action(
      action<{ fromEnv?: string }>(h, async (ctx, { args, opts }) => {
        const sourceId = String(args[0]);
        const name = args[1] === undefined ? undefined : String(args[1]);
        const target = pickSecret(sourceId, await secretsOfSource(ctx, sourceId), name);
        const store = await persistentStore(ctx);
        let value: string;
        if (opts.fromEnv) {
          const v = ctx.deps.env[opts.fromEnv]?.trim();
          if (!v) throw new UsageError(`環境変数${opts.fromEnv}が空です`);
          value = v;
        } else {
          if (!ctx.canPrompt())
            throw new UsageError(
              '対話できない環境では入力できません',
              '端末から実行するか --from-env <環境変数名> を使ってください',
            );
          const login = (await credentialAdapter(ctx, sourceId))
            ?.credentialSecrets()
            .find((c) => c.secret === target.secret);
          value = await askSecret(ctx, target, login?.echo === true);
        }
        const key = secretKey(sourceId, target.secret);
        await store.set(key, value);
        // New credentials: an automatic sign-in that stopped (e.g. a wrong password) may try again.
        if (target.via === 'login')
          await (await credentialAdapter(ctx, sourceId))?.credentialsChanged();
        if (ctx.json) {
          ctx.printJson({ ok: true, key, backend: store.backend }, { local: true });
          return 0;
        }
        ctx.out(ctx.style.green(`${key} を保存しました（${store.backend}）`));
        ctx.out(`  次: 「unicontext login ${sourceId}」で接続を確かめて同期します`);
        return 0;
      }),
    );

  secrets
    .command('delete')
    .description('保存した秘密情報を消す / Delete a stored secret')
    .argument('<source>', 'ソースID / source id')
    .argument('[name]', '秘密情報の名前（1つだけなら省略可） / secret name')
    .action(
      action(h, async (ctx, { args }) => {
        const sourceId = String(args[0]);
        const name = args[1] === undefined ? undefined : String(args[1]);
        const target = pickSecret(sourceId, await secretsOfSource(ctx, sourceId), name);
        const store = await ctx.secrets();
        const key = secretKey(sourceId, target.secret);
        const removed = await store.delete(key);
        if (target.via === 'login')
          await (await credentialAdapter(ctx, sourceId))?.credentialsChanged();
        if (ctx.json) ctx.printJson({ key, removed }, { local: true });
        else ctx.out(removed ? `${key} を消しました` : `${key} は保存されていません`);
        return 0;
      }),
    );
}
