import { CommanderError, Command } from 'commander';
import { redact } from '@unicontext/core';
import { registerAdditions } from './commands/additions.js';
import { registerAnnouncements } from './commands/announcements.js';
import { registerConfirm } from './commands/confirm.js';
import { registerCorrect } from './commands/correct.js';
import { registerDaemon } from './commands/daemon.js';
import { registerDataCommands } from './commands/data.js';
import { registerDoctor } from './commands/doctor.js';
import { registerGrades } from './commands/grades.js';
import { registerLogin } from './commands/login.js';
import { registerMcp } from './commands/mcp.js';
import { registerPace } from './commands/pace.js';
import { registerRemote } from './commands/remote.js';
import { registerService } from './commands/service.js';
import { registerStatus } from './commands/status.js';
import { registerSync } from './commands/sync.js';
import { registerViewCommands } from './commands/views.js';
import type { CliDeps } from './deps.js';
import { describeError } from './errors.js';
import { sanitizeText } from './format/table.js';
import type { Harness } from './harness.js';
import { VERSION } from './version.js';

const harnesses = new WeakMap<Command, Harness>();

/**
 * Build the `unicontext` command tree. Nothing is read or opened until a command runs; every
 * side effect goes through `deps`, so tests can drive it completely.
 */
export function buildProgram(deps: CliDeps): Command {
  const harness: Harness = { deps, state: { exitCode: 0 } };
  const program = new Command('unicontext');
  harnesses.set(program, harness);

  program
    .description(
      '大学生活のコンテキストを1つにまとめて表示・操作する / One unified context for university life',
    )
    .version(VERSION, '-V, --version', 'バージョンを表示する / print the version')
    .helpOption('-h, --help', 'ヘルプを表示する / show help')
    .option('--json', '機械可読のJSONで出力する / machine-readable JSON output')
    .option('--data-dir <dir>', 'データ保存先 / data directory')
    .option('--config <file>', '設定ファイル / config.yaml path')
    .option('--dev', '見本データで動かす（実データには触れない） / use synthetic seed data')
    .option('--no-keychain', 'OSキーチェーンを使わない / keep secrets in memory only')
    .option('--verbose', '詳細なログとエラーの内部情報を表示する / verbose logs and stack traces')
    .configureOutput({
      writeOut: (text) => deps.stdout(text),
      writeErr: (text) => deps.stderr(text),
      outputError: (text, write) => {
        const message = text.trim().replace(/^error:\s*/i, '');
        write(
          `エラー: 使い方が正しくありません（${message}）\nヒント: 「unicontext --help」で使い方を確認してください\n`,
        );
      },
    })
    .exitOverride();

  registerStatus(program, harness);
  registerSync(program, harness);
  registerLogin(program, harness);
  registerViewCommands(program, harness);
  registerGrades(program, harness);
  registerCorrect(program, harness);
  registerConfirm(program, harness);
  registerAdditions(program, harness);
  registerAnnouncements(program, harness);
  registerPace(program, harness);
  registerDoctor(program, harness);
  registerDataCommands(program, harness);
  registerMcp(program, harness);
  registerService(program, harness);
  registerDaemon(program, harness);
  registerRemote(program, harness);
  return program;
}

function commanderExitCode(e: CommanderError): number {
  if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return 0;
  return 2;
}

/** Print an error as a Japanese one-liner plus a hint; a stack trace only with --verbose. */
function printError(deps: CliDeps, e: unknown, verbose: boolean): number {
  const described = describeError(e);
  const clean = (s: string): string => sanitizeText(redact(s) as string);
  deps.stderr(`エラー: ${clean(described.message)}\n`);
  if (described.hint) deps.stderr(`ヒント: ${clean(described.hint)}\n`);
  if (verbose && e instanceof Error && e.stack) deps.stderr(`${redact(e.stack) as string}\n`);
  return described.exitCode;
}

/**
 * Run the CLI for `argv` (without node and script) and return the exit code:
 * 0 ok, 1 failure, 2 usage error.
 */
export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  const program = buildProgram(deps);
  const harness = harnesses.get(program);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return harness?.state.exitCode ?? 0;
  } catch (e) {
    if (e instanceof CommanderError) return commanderExitCode(e);
    return printError(deps, e, program.opts<{ verbose?: boolean }>().verbose === true);
  }
}
