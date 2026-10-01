import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

// Resolve @unicontext/* to TypeScript sources so tests do not depend on a prior build.
const alias: { find: RegExp; replacement: string }[] = [];
for (const group of ['packages', 'apps', 'connectors']) {
  const groupDir = join(root, group);
  if (!existsSync(groupDir)) continue;
  for (const name of readdirSync(groupDir)) {
    const src = join(groupDir, name, 'src');
    if (!existsSync(src)) continue;
    alias.push({ find: new RegExp(`^@unicontext/${name}/(.+)$`), replacement: `${src}/$1.ts` });
    alias.push({ find: new RegExp(`^@unicontext/${name}$`), replacement: join(src, 'index.ts') });
  }
}

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['{packages,apps,connectors}/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
