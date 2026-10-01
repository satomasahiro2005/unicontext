import type { Command } from 'commander';
import { CliContext, type GlobalOptions } from './context.js';
import type { CliDeps } from './deps.js';

/** Shared state of one `run()`: the dependencies and the exit code the command asked for. */
export interface Harness {
  deps: CliDeps;
  state: { exitCode: number };
}

export interface ActionInput<Opts> {
  /** Positional arguments as parsed by commander (variadic arguments arrive as arrays). */
  args: unknown[];
  /** Options of this command only. */
  opts: Opts;
  command: Command;
}

export type ActionHandler<Opts> = (
  ctx: CliContext,
  input: ActionInput<Opts>,
) => Promise<number | void>;

/**
 * Wrap a command handler: builds the CliContext from the global options, records the exit code
 * the handler returns and always closes what the handler opened. Errors propagate to run().
 */
export function action<Opts = Record<string, never>>(
  harness: Harness,
  handler: ActionHandler<Opts>,
  options: { alwaysLog?: boolean } = {},
): (...raw: unknown[]) => Promise<void> {
  return async (...raw: unknown[]): Promise<void> => {
    const command = raw[raw.length - 1] as Command;
    const opts = raw[raw.length - 2] as Opts;
    const args = raw.slice(0, -2);
    const globals = command.optsWithGlobals() as GlobalOptions;
    const ctx = new CliContext(harness.deps, globals, options.alwaysLog === true);
    try {
      const code = await handler(ctx, { args, opts, command });
      if (typeof code === 'number') harness.state.exitCode = code;
    } finally {
      await ctx.close();
    }
  };
}
