// The rule-based extractor lives in @unicontext/core so mappings can use it at normalization time
// ($extractDeadline); re-exported here for existing importers.
export { extractDeadlines, type ExtractedDeadline, type ExtractOptions } from '@unicontext/core';
