#!/usr/bin/env node
import { defaultDeps } from './deps.js';
import { run } from './main.js';
import { commandOf, remoteTarget, runOverSsh } from './remote-host.js';

const argv = process.argv.slice(2);
const remote = remoteTarget(argv, process.env);
// UNICONTEXT_REMOTE: run on that machine; `login` opens the browser here and hands the result over.
process.exitCode = !remote
  ? await run(argv, defaultDeps())
  : commandOf(argv) === 'login'
    ? await run([...argv, '--hand-off'], defaultDeps())
    : await runOverSsh(remote, argv, {
        tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
      });
