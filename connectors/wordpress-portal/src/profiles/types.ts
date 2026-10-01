/** Deployment of a WordPress based university portal: nothing here is product logic. */
export interface PortalDeployment {
  id: string;
  /** Site root (REST lives at `<baseUrl>wp-json/wp/v2/`). */
  baseUrl: string;
  /** Display name used in citations, e.g. "学生教務ポータル". */
  label: string;
  /** Pages whose PDF links are worth watching (documentation / config examples). */
  exampleWatchPages?: string[];
}
