import { describe, expect, it } from 'vitest';
import entry, { cancellationsConnector, connector, syllabusConnector } from '../src/index.js';

describe('package entry', () => {
  it('selects the module from config.module', async () => {
    expect(entry).toBe(connector);
    await expect(connector({ sourceId: 's', config: {} })).resolves.toBe(syllabusConnector);
    await expect(
      connector({ sourceId: 'k', config: { module: 'public-cancellations' } }),
    ).resolves.toBe(cancellationsConnector);
    await expect(connector({ sourceId: 'x', config: { module: 'nope' } })).rejects.toThrow(
      /unknown syllabus module/,
    );
  });
});
