import type { LcuDeploymentProfileInput } from '../core/deployment.js';
import { SHIZUOKA_DEPLOYMENT } from './shizuoka.js';

export { SHIZUOKA_DEPLOYMENT } from './shizuoka.js';

/** Built-in deployment profiles, selected by `deployment: <key>`. */
export const DEPLOYMENTS: Readonly<Record<string, LcuDeploymentProfileInput>> = {
  shizuoka: SHIZUOKA_DEPLOYMENT,
};
