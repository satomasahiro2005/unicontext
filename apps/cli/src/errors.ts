import {
  AuthRequiredError,
  ConfigError,
  ConnectorError,
  errorMessage,
  MigrationError,
  NotFoundError,
  OfflineError,
  PolicyViolationError,
  RateLimitedError,
  UniContextError,
  ValidationError,
} from '@unicontext/core';
import { DaemonApiError } from '@unicontext/daemon/lib';

/** A failure with a ready-to-print message. Exit code 1 (failure) or 2 (usage). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Wrong arguments or an unsupported combination (exit code 2). */
export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, 2, hint);
    this.name = 'UsageError';
  }
}

export interface DescribedError {
  message: string;
  hint?: string;
  exitCode: 1 | 2;
}

export function loginHint(sourceId?: string): string {
  return `「unicontext login ${sourceId ?? '<ソース名>'}」でログインし直してください`;
}

function sqliteCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_') ? code : undefined;
}

function isConnectionFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause = (e as { cause?: { code?: string } }).cause;
  return (
    e.name === 'TimeoutError' ||
    (e instanceof TypeError && /fetch failed/i.test(e.message)) ||
    cause?.code === 'ECONNREFUSED' ||
    cause?.code === 'ECONNRESET'
  );
}

/** Map any thrown value to a Japanese one-liner plus a fix hint (core errors get specific hints). */
export function describeError(e: unknown): DescribedError {
  if (e instanceof CliError) {
    return { message: e.message, ...(e.hint ? { hint: e.hint } : {}), exitCode: e.exitCode };
  }
  if (e instanceof AuthRequiredError) {
    const sourceId = typeof e.details?.sourceId === 'string' ? e.details.sourceId : undefined;
    return { message: `ログインが必要です: ${e.message}`, hint: loginHint(sourceId), exitCode: 1 };
  }
  if (e instanceof ConfigError) {
    return {
      message: `設定に問題があります: ${e.message}`,
      hint: '「unicontext doctor」で設定ファイルを確認してください',
      exitCode: 1,
    };
  }
  if (e instanceof MigrationError) {
    return {
      message: `データベースのマイグレーションに失敗しました: ${e.message}`,
      hint: '「unicontext backup」で退避してから「unicontext doctor」で状態を確認してください。新しい版で作られたDBはUniContextを更新すると開けます',
      exitCode: 1,
    };
  }
  if (e instanceof NotFoundError) {
    return {
      message: `見つかりません: ${e.message}`,
      hint: 'IDは「unicontext courses」「unicontext conflicts」「unicontext confirm --list」などで確認できます',
      exitCode: 1,
    };
  }
  if (e instanceof ValidationError) {
    return { message: `入力が正しくありません: ${e.message}`, exitCode: 1 };
  }
  if (e instanceof PolicyViolationError) {
    return {
      message: `安全のため実行できません: ${e.message}`,
      hint: 'AIが推論した値は本人が確認するまで事実として扱われません（「unicontext confirm」）',
      exitCode: 1,
    };
  }
  if (e instanceof RateLimitedError) {
    const wait = e.retryAfterMs
      ? `（${Math.ceil(e.retryAfterMs / 1000)}秒後に再試行できます）`
      : '';
    return {
      message: `接続先が制限中です${wait}: ${e.message}`,
      hint: 'しばらく待ってから再実行してください',
      exitCode: 1,
    };
  }
  if (e instanceof OfflineError) {
    return {
      message: `接続できません: ${e.message}`,
      hint: 'ネットワーク接続を確認してください。同期済みのデータは「unicontext today」などで読めます',
      exitCode: 1,
    };
  }
  if (e instanceof ConnectorError) {
    return {
      message: `コネクタでエラーが発生しました: ${e.message}`,
      hint: '「unicontext doctor」でソースの状態を確認してください',
      exitCode: 1,
    };
  }
  if (e instanceof DaemonApiError) {
    const hint =
      e.status === 401
        ? 'デーモンの書き込みトークンが無効です。「unicontext daemon stop」の後に「unicontext daemon start」をやり直してください'
        : '「unicontext daemon status」でデーモンの状態を確認してください';
    return {
      message: `デーモンがエラーを返しました（${e.status}）: ${e.message}`,
      hint,
      exitCode: 1,
    };
  }
  if (e instanceof UniContextError) {
    return {
      message: e.message,
      hint: '「unicontext doctor」で状態を確認してください',
      exitCode: 1,
    };
  }
  const code = sqliteCode(e);
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return {
      message: 'データベースが他のプロセスで使用中です',
      hint: '少し待って再実行するか、「unicontext daemon stop」でデーモンを止めてください',
      exitCode: 1,
    };
  }
  if (code) {
    return {
      message: `データベースエラー（${code}）: ${errorMessage(e)}`,
      hint: '「unicontext doctor」でデータ保存先を確認してください',
      exitCode: 1,
    };
  }
  if (isConnectionFailure(e)) {
    return {
      message: 'デーモンに接続できません',
      hint: '「unicontext daemon start」で起動するか、デーモンなしで実行してください',
      exitCode: 1,
    };
  }
  return {
    message: `予期しないエラー: ${errorMessage(e)}`,
    hint: '「--verbose」を付けると詳細を表示します',
    exitCode: 1,
  };
}
