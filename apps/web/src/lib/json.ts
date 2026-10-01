/** Same shape as the canonical model's JsonValue; redeclared so src/lib has no package imports. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
