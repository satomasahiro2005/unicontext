import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PACE_SLOT_EXAMPLE } from '@unicontext/context-engine';
import {
  ConfigError,
  defaultConfig,
  errorMessage,
  loadConfig,
  loadProfile,
  type UniContextConfig,
  type UniversityProfile,
} from '@unicontext/core';
import { currentSchemaVersion, getAppliedMigrations, MIGRATIONS } from '@unicontext/database';
import { readApiToken, type Runtime } from '@unicontext/daemon/lib';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { shortTime, stateLabel } from '../format/common.js';
import { padEnd } from '../format/table.js';
import { action, type Harness } from '../harness.js';
import { daemonInfo } from './status.js';

export type CheckStatus = 'ok' | 'warn' | 'ng';

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  /** Display label: OK / 警告 / NG. */
  label: string;
  message: string;
  /** What to do about it (shown as `fix:`). */
  fix?: string;
}

const LABELS: Record<CheckStatus, string> = { ok: 'OK', warn: '警告', ng: 'NG' };

function check(
  id: string,
  title: string,
  status: CheckStatus,
  message: string,
  fix?: string,
): DoctorCheck {
  return { id, title, status, label: LABELS[status], message, ...(fix ? { fix } : {}) };
}

const MIN_NODE = { major: 22, minor: 12 };

function nodeOk(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

const TIMEOUT = Symbol('timeout');

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function keychainFix(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'linux':
      return 'Secret Service（gnome-keyring・KWalletなど）を起動してください。使わない場合は--no-keychainを付けます';
    case 'darwin':
      return 'キーチェーンアクセスでログインキーチェーンのロックを解除してください';
    default:
      return 'Windows資格情報マネージャーが使えるか確認してください。使わない場合は--no-keychainを付けます';
  }
}

async function checkSources(
  ctx: CliContext,
  rt: Runtime,
  timeoutMs: number,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const tz = rt.uc.timezone;
  if (rt.sourceInfo.size === 0) {
    return [
      check(
        'sources',
        'ソース',
        'warn',
        'ソースが設定されていません',
        'config.yamlのsourcesに接続したいサービスを追加してください',
      ),
    ];
  }
  for (const [sourceId, info] of rt.sourceInfo) {
    const id = `source:${sourceId}`;
    const title = `ソース「${sourceId}」`;
    if (!info.enabled) {
      out.push(check(id, title, 'ok', '無効（enabled: false）のためスキップしました'));
      continue;
    }
    if (info.loadError) {
      out.push(
        check(
          id,
          title,
          'ng',
          `コネクタを読み込めません: ${ctx.text(info.loadError)}`,
          info.connector
            ? `「pnpm add ${info.connector}」でインストールするか、使わないならconfig.yamlでenabled: falseにしてください`
            : 'config.yamlのconnector:かadapter:を指定するか、enabled: falseにしてください',
        ),
      );
      continue;
    }
    if (!info.loaded) {
      out.push(
        check(
          id,
          title,
          'warn',
          'コネクタが登録されていません',
          '「unicontext sources」で状態を確認してください',
        ),
      );
      continue;
    }
    let result: Awaited<ReturnType<typeof rt.uc.sync.checkHealth>> | typeof TIMEOUT;
    try {
      result = await withTimeout(rt.uc.sync.checkHealth(sourceId), timeoutMs);
    } catch (e) {
      out.push(
        check(
          id,
          title,
          'ng',
          `接続状態を確認できません: ${ctx.text(errorMessage(e))}`,
          `「unicontext sync ${sourceId}」で再試行してください`,
        ),
      );
      continue;
    }
    if (result === TIMEOUT) {
      out.push(
        check(
          id,
          title,
          'warn',
          `接続状態の確認が${Math.round(timeoutMs / 1000)}秒以内に終わりませんでした`,
          'ネットワークを確認して、もう一度「unicontext doctor」を実行してください',
        ),
      );
      continue;
    }
    const last = result.lastSuccessAt ?? rt.uc.sync.health(sourceId)?.lastSuccessAt;
    const lastText = last ? `最終成功: ${shortTime(last, tz)}` : '同期の成功記録はまだありません';
    const note = result.message ? `（${ctx.text(result.message)}）` : '';
    const base = `${stateLabel(result.state)}${note}、${lastText}`;
    switch (result.state) {
      case 'healthy':
        out.push(check(id, title, 'ok', base));
        break;
      case 'degraded':
        out.push(
          check(
            id,
            title,
            'warn',
            base,
            '「unicontext sources」でバージョンやドリフトの状況を確認してください',
          ),
        );
        break;
      case 'auth_required':
        out.push(
          check(id, title, 'warn', base, `「unicontext login ${sourceId}」でログインしてください`),
        );
        break;
      case 'rate_limited':
      case 'offline':
        out.push(
          check(id, title, 'warn', base, 'しばらく待ってから「unicontext sync」を実行してください'),
        );
        break;
      default:
        out.push(
          check(
            id,
            title,
            'ng',
            base,
            `「unicontext sync ${sourceId}」で再試行し、直らなければログ（${rt.paths.logs}）を確認してください`,
          ),
        );
    }
  }
  return out;
}

/** Enrolled 時間割外 / 集中講義 courses of the current term without self-study slots (warnings). */
function checkPace(ctx: CliContext, rt: Runtime): DoctorCheck[] {
  try {
    return rt.uc.context.admin().unscheduledWithoutPace.map(({ course }) => {
      const arg = course.courseCode ?? `"${course.title}"`;
      return check(
        `pace:${course.id}`,
        '自習時間',
        'warn',
        `時間割外の科目に自習時間が未設定: ${ctx.text(course.title)}（unicontext pace set ${ctx.text(arg)} --slot "${PACE_SLOT_EXAMPLE}"）`,
      );
    });
  } catch {
    return [];
  }
}

/** Run every check. Never throws: failures become NG entries. */
export async function runDoctor(ctx: CliContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const probes = ctx.deps.probes;
  const platform = probes.platform();

  // 1. Node.js
  const nodeVersion = probes.nodeVersion();
  checks.push(
    nodeOk(nodeVersion)
      ? check('node', 'Node.js', 'ok', `v${nodeVersion.replace(/^v/, '')}（22.12以上）`)
      : check(
          'node',
          'Node.js',
          'ng',
          `v${nodeVersion.replace(/^v/, '')}は古すぎます（22.12以上が必要）`,
          'Node.js 22.12以上をインストールしてください（https://nodejs.org/）',
        ),
  );

  // dev mode: everything runs on the synthetic seed in a temp dir
  let rt: Runtime | undefined;
  let config: UniContextConfig = defaultConfig();
  let profile: UniversityProfile | undefined;
  let configOk = true;

  // 2. config file
  if (ctx.dev) {
    checks.push(
      check('config', '設定ファイル', 'ok', '見本データ（--dev）では設定ファイルを使いません'),
    );
  } else {
    const file = ctx.configFile();
    if (!existsSync(file)) {
      checks.push(
        check(
          'config',
          '設定ファイル',
          'warn',
          `設定ファイルがありません（既定値で動作します）: ${file}`,
          'config.yamlを作成してsourcesに接続先を追加してください',
        ),
      );
    } else {
      try {
        config = loadConfig(file);
        checks.push(
          check(
            'config',
            '設定ファイル',
            'ok',
            `読み込めました: ${file}（ソース${Object.keys(config.sources).length}件）`,
          ),
        );
      } catch (e) {
        configOk = false;
        checks.push(
          check(
            'config',
            '設定ファイル',
            'ng',
            e instanceof ConfigError ? e.message : errorMessage(e),
            `「${file}」を直してください（パスワードやトークンは書かずキーチェーンに保存します）`,
          ),
        );
      }
    }
  }

  // 3. profile
  if (ctx.dev) {
    checks.push(check('profile', 'プロファイル', 'ok', 'shizuoka-university（見本データ）'));
  } else if (!config.profile) {
    checks.push(
      check(
        'profile',
        'プロファイル',
        'warn',
        configOk
          ? '大学プロファイルが未設定です（時限の時刻などが使えません）'
          : '設定ファイルの問題のため確認できません',
        'config.yamlにprofile: shizuoka-universityのように指定してください',
      ),
    );
  } else {
    try {
      profile = loadProfile(config.profile, {
        searchPaths: [path.join(ctx.paths().configDir, 'profiles')],
      });
      checks.push(check('profile', 'プロファイル', 'ok', `${profile.id}を読み込めました`));
    } catch (e) {
      checks.push(
        check(
          'profile',
          'プロファイル',
          'ng',
          `「${config.profile}」を読み込めません: ${errorMessage(e)}`,
          `プロファイル名を確認するか、${path.join(ctx.paths().configDir, 'profiles', config.profile, 'profile.yaml')}を置いてください`,
        ),
      );
    }
  }

  // 4. data dir (+ permissions)
  let paths = ctx.dev ? undefined : ctx.paths();
  if (ctx.dev) {
    try {
      rt = await ctx.runtime();
      paths = rt.paths;
    } catch (e) {
      checks.push(
        check('data-dir', 'データ保存先', 'ng', `見本データを準備できません: ${errorMessage(e)}`),
      );
    }
  }
  let dataDirExists = false;
  if (paths) {
    const root = paths.root;
    if (!existsSync(root)) {
      checks.push(
        check(
          'data-dir',
          'データ保存先',
          'warn',
          `まだ作成されていません: ${root}`,
          '「unicontext sync」を最初に実行すると作成されます',
        ),
      );
    } else {
      dataDirExists = true;
      const probeFile = path.join(root, `.doctor-${Date.now().toString(36)}`);
      try {
        accessSync(root, constants.W_OK);
        mkdirSync(root, { recursive: true });
        writeFileSync(probeFile, 'ok');
        rmSync(probeFile, { force: true });
        checks.push(check('data-dir', 'データ保存先', 'ok', `書き込めます: ${root}`));
      } catch (e) {
        checks.push(
          check(
            'data-dir',
            'データ保存先',
            'ng',
            `書き込めません: ${root}（${errorMessage(e)}）`,
            '保存先の権限を確認するか、--data-dirで別の場所を指定してください',
          ),
        );
      }
      if (platform === 'win32') {
        checks.push(
          check(
            'data-dir-permissions',
            'データ保存先の権限',
            'ok',
            'Windowsでは%LOCALAPPDATA%配下の既定ACL（ユーザー本人のみ）で保護されます',
          ),
        );
      } else {
        try {
          const mode = statSync(root).mode & 0o777;
          if ((mode & 0o077) !== 0)
            checks.push(
              check(
                'data-dir-permissions',
                'データ保存先の権限',
                'warn',
                `他のユーザーも読める権限です（${mode.toString(8)}）`,
                `chmod 700 "${root}"`,
              ),
            );
          else
            checks.push(
              check(
                'data-dir-permissions',
                'データ保存先の権限',
                'ok',
                `本人のみ（${mode.toString(8)}）`,
              ),
            );
        } catch (e) {
          checks.push(
            check(
              'data-dir-permissions',
              'データ保存先の権限',
              'warn',
              `権限を調べられません: ${errorMessage(e)}`,
            ),
          );
        }
      }
    }
  }

  // 5. database + migrations
  const dbFile = paths?.database;
  if (!ctx.dev && (!dataDirExists || !dbFile || !existsSync(dbFile))) {
    checks.push(
      check(
        'database',
        'データベース',
        'warn',
        'データベースはまだありません（初回の同期で作られます）',
        '「unicontext sync」を実行してください',
      ),
    );
  } else if (!rt) {
    try {
      rt = await ctx.runtime({ config, ...(profile ? { profile } : {}) });
    } catch (e) {
      checks.push(
        check(
          'database',
          'データベース',
          'ng',
          errorMessage(e),
          '「unicontext backup」で退避したうえで、データベースを新しい版のUniContextで開くか、バックアップから戻してください',
        ),
      );
    }
  }
  if (rt) {
    try {
      const version = currentSchemaVersion(rt.uc.db.sqlite);
      const applied = getAppliedMigrations(rt.uc.db.sqlite).length;
      const latest = MIGRATIONS.length;
      checks.push(
        version === latest
          ? check(
              'database',
              'データベース',
              'ok',
              `スキーマv${version}（${applied}件適用済み、最新）`,
            )
          : check(
              'database',
              'データベース',
              'warn',
              `スキーマv${version}（最新はv${latest}）`,
              '次のコマンド実行時に自動で更新されます',
            ),
      );
    } catch (e) {
      checks.push(check('database', 'データベース', 'ng', errorMessage(e)));
    }
  }

  // 6. sources
  if (rt) {
    checks.push(...(await checkSources(ctx, rt, ctx.deps.healthTimeoutMs ?? 15_000)));
  } else if (!ctx.dev) {
    const notCreated = !dataDirExists || !dbFile || !existsSync(dbFile);
    checks.push(
      check(
        'sources',
        'ソース',
        'warn',
        notCreated
          ? 'データベースがまだないため確認していません'
          : 'データベースを開けないため確認できません',
        notCreated
          ? '「unicontext sync」の後にもう一度実行してください'
          : '上のデータベースの項目を先に直してください',
      ),
    );
  }

  if (rt) checks.push(...checkPace(ctx, rt));

  // 7. keychain
  if (ctx.dev) {
    checks.push(
      check('keychain', 'OSキーチェーン', 'ok', '見本データ（--dev）ではキーチェーンを使いません'),
    );
  } else if (ctx.noKeychain) {
    checks.push(
      check(
        'keychain',
        'OSキーチェーン',
        'warn',
        'キーチェーンを使わない設定です。秘密情報はメモリ上にだけ保持され、終了すると失われます',
        '--no-keychainを外すとログイン情報を保存できます',
      ),
    );
  } else {
    const kc = await probes
      .keychain()
      .catch((e: unknown) => ({ ok: false, detail: errorMessage(e) }));
    checks.push(
      kc.ok
        ? check(
            'keychain',
            'OSキーチェーン',
            'ok',
            `読み書きできました${kc.detail ? `（${kc.detail}）` : ''}`,
          )
        : check(
            'keychain',
            'OSキーチェーン',
            'warn',
            `使えません${kc.detail ? `（${ctx.text(kc.detail)}）` : ''}。秘密情報はメモリ上にだけ保持され、終了すると失われます`,
            keychainFix(platform),
          ),
    );
  }

  // 8. daemon + 9. write token
  const daemon = await daemonInfo(ctx);
  if (daemon.running)
    checks.push(
      check(
        'daemon',
        'デーモン',
        'ok',
        `稼働中: ${daemon.url}（pid ${daemon.pid}、v${daemon.version}）`,
      ),
    );
  else
    checks.push(
      check(
        'daemon',
        'デーモン',
        'warn',
        daemon.lock
          ? `応答がありません（ロックファイルにpid ${daemon.lock.pid}が残っています）`
          : '起動していません（読み取り系のコマンドはデーモンなしで動きます）',
        '「unicontext daemon start」で起動、常駐させるには「unicontext service install」',
      ),
    );
  if (!ctx.dev) {
    let token: string | undefined;
    try {
      token = await readApiToken(await ctx.secrets(), ctx.paths());
    } catch {
      token = undefined;
    }
    if (token)
      checks.push(check('api-token', '書き込みトークン', 'ok', 'あります（値は表示しません）'));
    else if (daemon.running)
      checks.push(
        check(
          'api-token',
          '書き込みトークン',
          'ng',
          'デーモンは動いていますがトークンを読めません。CLIからデーモン経由の書き込みができません',
          '「unicontext daemon stop」の後に「unicontext daemon start」をやり直してください（キーチェーンの権限も確認）',
        ),
      );
    else
      checks.push(
        check(
          'api-token',
          '書き込みトークン',
          'warn',
          'まだありません（初回のデーモン起動時に作られます）',
          '「unicontext daemon start」',
        ),
      );
  }

  // 10. Playwright
  const browserSources = Object.entries(config.sources)
    .filter(([, s]) => s.enabled && s.adapter === 'browser')
    .map(([id]) => id);
  const pw = await probes
    .playwright()
    .catch((e: unknown) => ({ ok: false, detail: errorMessage(e) }));
  checks.push(
    pw.ok
      ? check('playwright', 'Playwright', 'ok', `使えます${pw.detail ? `（${pw.detail}）` : ''}`)
      : check(
          'playwright',
          'Playwright',
          'warn',
          browserSources.length > 0
            ? `見つかりません。ブラウザ操作で取得するソース（${browserSources.join('、')}）が動きません`
            : '見つかりません。ブラウザ操作で取得するソース（adapter: browser）でだけ必要です',
          '「pnpm add playwright」の後に「npx playwright install chromium」を実行してください',
        ),
  );

  // 11. desktop notifications
  const dn = await probes
    .desktopNotifications()
    .catch((e: unknown) => ({ ok: false, detail: errorMessage(e) }));
  checks.push(
    dn.ok
      ? check(
          'desktop-notifications',
          'デスクトップ通知',
          'ok',
          `使えます${dn.detail ? `（${dn.detail}）` : ''}`,
        )
      : check(
          'desktop-notifications',
          'デスクトップ通知',
          'warn',
          '使えません。通知はコンソールと通知ログにだけ出力されます',
          '任意の機能です。必要なら「pnpm add node-notifier」で追加してください',
        ),
  );

  // 12. telemetry
  checks.push(
    config.telemetry.enabled
      ? check(
          'telemetry',
          'テレメトリ',
          'warn',
          'テレメトリが有効になっています',
          'config.yamlでtelemetry.enabled: falseにすると送信しません',
        )
      : check('telemetry', 'テレメトリ', 'ok', '無効です（何も送信しません）'),
  );

  return checks;
}

export function registerDoctor(program: Command, h: Harness): void {
  program
    .command('doctor')
    .description('環境と接続の診断（NGがあれば終了コード1） / Diagnose the environment and sources')
    .action(
      action(h, async (ctx) => {
        const checks = await runDoctor(ctx);
        const ng = checks.filter((c) => c.status === 'ng').length;
        const warn = checks.filter((c) => c.status === 'warn').length;
        if (ctx.json) {
          ctx.printJson(checks);
          return ng > 0 ? 1 : 0;
        }
        const s = ctx.style;
        const paint = (c: DoctorCheck): string => {
          const label = padEnd(c.label, 4);
          return c.status === 'ok'
            ? s.green(label)
            : c.status === 'warn'
              ? s.yellow(label)
              : s.red(label);
        };
        ctx.out(s.bold('UniContext doctor'));
        ctx.out('');
        for (const c of checks) {
          ctx.out(`${paint(c)}  ${padEnd(c.title, 22)}  ${c.message}`);
          if (c.fix && c.status !== 'ok') ctx.out(`      fix: ${c.fix}`);
        }
        ctx.out('');
        ctx.out(
          `${ng > 0 ? s.red(`NG ${ng}件`) : `NG ${ng}件`} / ${warn > 0 ? s.yellow(`警告${warn}件`) : `警告${warn}件`} / OK ${checks.length - ng - warn}件`,
        );
        return ng > 0 ? 1 : 0;
      }),
    );
}
