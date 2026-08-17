/**
 * Exercises the harness exactly the way an adapter package will consume it:
 * `runConformanceSuite` registered directly in a Vitest file. The in-memory
 * reference adapter must pass every registered rule.
 */
import { runConformanceSuite } from "../src/conformance/vitest-suite.js";
import {
  createReferenceAdapter,
  REFERENCE_KNOWN_OFFER_ID,
  REFERENCE_KNOWN_QUERY,
} from "../src/index.js";

runConformanceSuite(createReferenceAdapter, {
  searchQuery: REFERENCE_KNOWN_QUERY,
  knownOfferId: REFERENCE_KNOWN_OFFER_ID,
});
