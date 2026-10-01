export const PACKAGE_NAME = '@unicontext/cli';

export { buildProgram, run } from './main.js';
export {
  defaultDeps,
  defaultProbes,
  type CliDeps,
  type DoctorProbes,
  type ProbeResult,
} from './deps.js';
export { runDoctor, type DoctorCheck, type CheckStatus } from './commands/doctor.js';
export { describeError, CliError, UsageError } from './errors.js';
export {
  charWidth,
  displayWidth,
  padEnd,
  padStart,
  renderTable,
  truncate,
} from './format/table.js';
export { VERSION } from './version.js';
