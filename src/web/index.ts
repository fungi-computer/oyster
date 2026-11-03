export {
  createWebSource,
  fetchWebPage,
  WEB_FETCH_MAX_BYTES,
  type WebFetchResult,
} from "./source.js";
export {
  parallelWebSearch,
  unconfiguredWebSearch,
  WebSearchError,
  type WebSearchReport,
} from "./search.js";
export {
  webSearchInputSchema,
  webSearchOutputSchema,
  type WebSearch,
  type WebSearchInput,
  type WebSearchOutput,
} from "./search-contract.js";
