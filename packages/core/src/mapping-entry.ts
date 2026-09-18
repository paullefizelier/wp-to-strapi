/**
 * Browser-safe entry point: the mapping engine and the introspection types, with no Node
 * built-ins behind them. The mapping UI runs this in the browser, where importing the main
 * entry would drag in `node:fs` through the state store.
 */
export {
  applyMapping,
  defaultEntryMapping,
  defaultTermMapping,
  mergeMappings,
  readPath,
  setPath,
  validateMapping,
  TRANSFORMS,
} from "./mapping.js";
export type {
  FieldMapping,
  MappingContext,
  MappingIssue,
  MappingResult,
  MappingSet,
} from "./mapping.js";
export { decodeEntities, detectFlavour, findShortcodes, rewriteMediaUrls } from "./html-transform.js";
export type { ContentFlavour } from "./html-transform.js";
export { flattenEntity, VIRTUAL_SOURCES } from "./introspect.js";
export type { ContentTypeSummary, SourceField, TargetField, TargetSchema } from "./introspect.js";
export type { MigrationState, MediaFormat } from "./state.js";
