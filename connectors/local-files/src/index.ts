export { default, metadata } from './connector.js';
export {
  chokidarWatcherFactory,
  externalIdFor,
  LocalFilesAdapter,
  rootKeyFor,
  type FileEventKind,
  type LocalFilesAdapterOptions,
  type WatcherFactory,
  type WatcherLike,
  type WatcherOptions,
} from './adapter.js';
export { chunkMarkdown, chunkText, type TextChunk } from './chunk.js';
export {
  DEFAULT_EXCLUDE,
  DEFAULT_TERM_FOLDER_PATTERN,
  type LocalFilesConfig,
  LocalFilesConfigSchema,
  resolveRoots,
} from './config.js';
export {
  academicYearFromFolder,
  inferCourseFolder,
  parseDateFromName,
  type CourseInference,
} from './course.js';
export {
  decodeText,
  extractContent,
  extractPptx,
  htmlToText,
  mimeTypeFor,
  pptxSlidePaths,
  relTargets,
  type ExtractedContent,
} from './extract.js';
export { compileGlobs, globToRegExp, matchesExclude, matchesInclude } from './glob.js';
export { Manifest, type ManifestEntry } from './manifest.js';
export {
  buildChunks,
  createLocalFilesNormalizer,
  documentText,
  materialKindFor,
  type NormalizerOptions,
} from './normalizer.js';
export {
  type FileDocumentPayload,
  FileDocumentPayloadSchema,
  type FileSlide,
  RAW_TYPE_DOCUMENT,
} from './types.js';
export { DebouncedBatch } from './watch-batch.js';
export { default as connector } from './connector.js';
