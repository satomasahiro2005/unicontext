import { shizuokaDeployment } from './shizuoka.js';
import type { LcuDeployment } from './types.js';

/** Built-in deployment profiles, selected by `deployment: <id>` in config or profile settings. */
export const DEPLOYMENTS: Map<string, LcuDeployment> = new Map([
  [shizuokaDeployment.id, shizuokaDeployment],
]);

/** Add a deployment (other universities running LiveCampusU, tests). */
export function registerDeployment(deployment: LcuDeployment): void {
  DEPLOYMENTS.set(deployment.id, deployment);
}

export function getDeployment(id: string): LcuDeployment | undefined {
  return DEPLOYMENTS.get(id);
}
