export { default, metadata } from './connector.js';
export {
  ChatGptRecordAdapter,
  chokidarWatcherFactory,
  externalIdFor,
  rootKeyFor,
  type ChatGptRecordAdapterOptions,
  type FileEventKind,
  type ImportTextOptions,
  type WatcherFactory,
  type WatcherLike,
  type WatcherOptions,
} from './adapter.js';
export {
  ChatGptRecordConfigSchema,
  DEFAULT_TERM_FOLDER_PATTERN,
  resolveWatchDir,
  type ChatGptRecordConfig,
} from './config.js';
export { decodeText } from './decode.js';
export {
  defaultTranscriptImporter,
  RAW_TYPE_TRANSCRIPT,
  recordedAtFromFileName,
  TranscriptImporter,
  TranscriptPayloadSchema,
  type ImportOptions,
  type TranscriptInput,
  type TranscriptPayload,
} from './importer.js';
export { Manifest, type ManifestEntry } from './manifest.js';
export {
  academicTermOf,
  academicYearOf,
  courseKeyOf,
  createChatGptRecordNormalizer,
  inferPeriod,
  type NormalizerOptions,
} from './normalizer.js';
export {
  DEFAULT_FORMATS,
  jsonFormat,
  joinText,
  mdFormat,
  srtFormat,
  txtFormat,
  vttFormat,
  type ParsedTranscript,
  type ParseOptions,
  type TranscriptFormat,
  type TranscriptSegment,
} from './parsers.js';
export {
  findLocalDateTime,
  formatTimestamp,
  localDateOf,
  localMinutesOf,
  localToIso,
  parseDateTimeText,
  parseTimestampMs,
  type LocalDateTime,
} from './time.js';
export { DebouncedBatch } from './watch-batch.js';
export { default as connector } from './connector.js';
