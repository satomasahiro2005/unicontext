/** A frozen, versioned migration (§67). Never edit an applied migration; add a new one. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}
