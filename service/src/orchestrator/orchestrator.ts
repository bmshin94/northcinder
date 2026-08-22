import {
  OfferSchema,
  SourceStatusSchema,
  storeError,
  type AdapterSearchResult,
  type AdapterOfferResult,
  type Offer,
  type SearchQuery,
  type StoreAdapter,
  type StoreError,
  type StoreStatus,
  type SourceStatus,
} from "@northcinder/protocol";
import { Semaphore } from "./semaphore.js";

/**
 * Aggregation orchestrator (reliability and safety backbone):
 * parallel fan-out across registered store adapters with, per adapter call:
 * a hard timeout and a per-host concurrency cap. Provider HTTP owns retries;
 * one store failing NEVER fails
 * the search — every store's outcome is reported in `storeStatuses`.
 */
export interface OrchestratorConfig {
  /** Hard per-attempt budget for one adapter call. Default 2000ms. */
  adapterTimeoutMs?: number;
  /** Max concurrent in-flight calls per host. Default 4. */
  perHostConcurrency?: number;
  /**
   * Injectable clock for the `fetchedAt` provenance stamp (tests).
   * Default: current time as an ISO 8601 datetime.
   */
  now?: () => string;
}

export interface SearchOutcome {
  /** Schema-valid offers from every store that responded. */
  offers: Offer[];
  /** One status per registered store — successes and failures alike. */
  storeStatuses: StoreStatus[];
}

export interface Orchestrator {
  /** adapter integration registers real store adapters here. */
  registerAdapter(adapter: StoreAdapter): void;
  registeredStoreIds(): string[];
  search(query: SearchQuery): Promise<SearchOutcome>;
  getOffer(store: string, offerId: string): Promise<AdapterOfferResult>;
}

const DEFAULTS = {
  adapterTimeoutMs: 2000,
  perHostConcurrency: 4,
} as const;

const UNSAFE_AGENT_FACING_TEXT = /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|system|developer)\s+instructions?\b|\b(?:reveal|print|return|send)\b.{0,80}\b(?:system\s+prompt|api\s+key|password|secret|credential|token)\b|<script\b|\bjavascript\s*:|\bon(?:error|load|click)\s*=|\bdocument\.cookie\b|\beval\s*\(/i;
const UNSAFE_CONTROL_CHAR = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const RAW_HTML_MARKUP = /<(?:!doctype\b|!--|\/?[a-z][a-z0-9:-]*(?:\s[^<>]{0,512})?\/?)>/i;
const DATA_IMAGE_PAYLOAD = /\bdata\s*:\s*image\/[a-z0-9.+-]+(?:;[^,\s]*)?,/i;
const SENSITIVE_HEADER_MATERIAL = /(?:^|[\r\n])\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*:\s*\S/i;
const CREDENTIAL_ASSIGNMENT = /\b(?:password|passwd|passphrase|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret)\s*[:=]\s*\S/i;
const CREDENTIAL_SHAPED_BEARER = /\bbearer\s+(?=[a-z0-9._~+/=-]{12,})(?=[a-z0-9._~+/=-]*[0-9._~+/=-])[a-z0-9._~+/=-]{12,}/i;
const MAX_AGENT_FACING_STRING_LENGTH = 8_192;

const UNSAFE_PAYLOAD_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "header",
  "headers",
  "password",
  "passwd",
  "passphrase",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "apikey",
  "apisecret",
  "clientsecret",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "onetimecode",
  "onetimepassword",
  "otp",
  "otpcode",
  "browserstorage",
  "sessionstorage",
  "localstorage",
  "accountdata",
  "accountcredentials",
  "captchasolution",
  "captcharesponse",
  "captchatoken",
  "browsersession",
  "browsersessionid",
  "browsersessiondata",
  "authenticatedsession",
  "rawhtml",
  "screenshot",
  "screenshotdata",
]);

function isUnsafePayloadKey(key: string): boolean {
  return UNSAFE_PAYLOAD_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

export function containsUnsafeAgentFacingText(value: unknown): boolean {
  if (typeof value === "string") {
    return value.length > MAX_AGENT_FACING_STRING_LENGTH
      || UNSAFE_CONTROL_CHAR.test(value)
      || UNSAFE_AGENT_FACING_TEXT.test(value)
      || RAW_HTML_MARKUP.test(value)
      || DATA_IMAGE_PAYLOAD.test(value)
      || SENSITIVE_HEADER_MATERIAL.test(value)
      || CREDENTIAL_ASSIGNMENT.test(value)
      || CREDENTIAL_SHAPED_BEARER.test(value);
  }
  if (Array.isArray(value)) return value.some(containsUnsafeAgentFacingText);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nested]) => isUnsafePayloadKey(key)
        || containsUnsafeAgentFacingText(key)
        || containsUnsafeAgentFacingText(nested),
    );
  }
  return false;
}

export function createOrchestrator(
  adapters: StoreAdapter[],
  config: OrchestratorConfig = {},
): Orchestrator {
  const cfg = {
    adapterTimeoutMs: config.adapterTimeoutMs ?? DEFAULTS.adapterTimeoutMs,
    perHostConcurrency: config.perHostConcurrency ?? DEFAULTS.perHostConcurrency,
    now: config.now ?? (() => new Date().toISOString()),
  };

  const registry = new Map<string, StoreAdapter>();
  const hostLimiters = new Map<string, Semaphore>();

  function register(adapter: StoreAdapter): void {
    const id = adapter.manifest.id;
    if (registry.has(id)) throw new Error(`adapter "${id}" is already registered`);
    registry.set(id, adapter);
  }
  for (const a of adapters) register(a);

  /**
   * Concurrency-cap key: the adapter's first allowed host (its primary
   * upstream), falling back to the adapter id for network-less adapters.
   */
  function limiterFor(adapter: StoreAdapter): Semaphore {
    const key = adapter.manifest.permissions.allowedHosts[0] ?? `adapter:${adapter.manifest.id}`;
    let limiter = hostLimiters.get(key);
    if (limiter === undefined) {
      limiter = new Semaphore(cfg.perHostConcurrency);
      hostLimiters.set(key, limiter);
    }
    return limiter;
  }

  /**
   * One attempt under the hard timeout. Adapters never throw — but we also
   * defend against ones that do.
   *
   * `onCallSettled` (optional) is invoked once the *real* underlying adapter
   * call settles, regardless of whether the timeout branch already won the
   * race — this lets callers track true completion of abandoned/timed-out
   * attempts separately from the fast value returned here (spec: the
   * per-host concurrency slot must not free until an abandoned attempt
   * truly settles).
   */
  async function attemptSearch(
    adapter: StoreAdapter,
    query: SearchQuery,
    onCallSettled?: (p: Promise<unknown>) => void,
  ): Promise<AdapterSearchResult> {
    const store = adapter.manifest.id;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<AdapterSearchResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          ok: false,
          error: storeError(store, "timeout", `search timed out after ${cfg.adapterTimeoutMs}ms`, {
            retryable: true,
          }),
        });
      }, cfg.adapterTimeoutMs);
    });

    const call = adapter
      .search(query, { timeoutMs: cfg.adapterTimeoutMs, signal: controller.signal })
      .catch(
        (): AdapterSearchResult => ({
          ok: false,
          error: storeError(store, "internal", "store adapter failed unexpectedly", { retryable: false }),
        }),
      );
    onCallSettled?.(call);

    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function attemptOffer(
    adapter: StoreAdapter,
    offerId: string,
    onCallSettled?: (p: Promise<unknown>) => void,
  ): Promise<AdapterOfferResult> {
    const store = adapter.manifest.id;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<AdapterOfferResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, error: storeError(store, "timeout", `offer refresh timed out after ${cfg.adapterTimeoutMs}ms`, { retryable: true }) });
      }, cfg.adapterTimeoutMs);
    });
    const call = adapter.getOffer(offerId, { timeoutMs: cfg.adapterTimeoutMs, signal: controller.signal }).catch(
      (): AdapterOfferResult => ({ ok: false, error: storeError(store, "internal", "store adapter failed unexpectedly", { retryable: false }) }),
    );
    onCallSettled?.(call);
    try { return await Promise.race([call, timeout]); } finally { clearTimeout(timer); }
  }

  function validateOffers(store: string, offers: Offer[]): { offers: Offer[] } | { error: StoreError } {
    const valid: Offer[] = [];
    let unsafeCount = 0;
    for (const raw of offers) {
      const parsed = OfferSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          error: storeError(store, "invalid_response", "store returned offers violating the protocol schema", {
            retryable: false,
            details: { firstIssue: parsed.error.issues[0]?.message ?? "unknown" },
          }),
        };
      }
      if (parsed.data.sourceStore !== store) {
        return {
          error: storeError(store, "invalid_response", "store returned an offer with mismatched sourceStore provenance", {
            retryable: false,
            details: { claimed: parsed.data.sourceStore },
          }),
        };
      }
      if (containsUnsafeAgentFacingText(parsed.data)) {
        unsafeCount += 1;
        continue;
      }
      // buyer brief provenance: every offer leaves the orchestrator with a fetchedAt
      // stamp. An adapter's own stamp (e.g. honestly-older cached data) is
      // preserved; anything unstamped gets the fetch time.
      valid.push(parsed.data.fetchedAt !== undefined ? parsed.data : { ...parsed.data, fetchedAt: cfg.now() });
    }
    if (offers.length > 0 && unsafeCount === offers.length) {
      return {
        error: storeError(store, "invalid_response", "store returned unsafe agent-facing content", {
          retryable: false,
          details: { category: "instruction_like_text" },
        }),
      };
    }
    return { offers: valid };
  }

  async function searchOneStore(adapter: StoreAdapter, query: SearchQuery): Promise<{ offers: Offer[]; status: StoreStatus }> {
    const store = adapter.manifest.id;
    const started = Date.now();

    const limiter = limiterFor(adapter);
    await limiter.acquire();
    const pendingCalls: Array<Promise<unknown>> = [];
    let result: AdapterSearchResult;
    try {
      result = await attemptSearch(adapter, query, (p) => pendingCalls.push(p));
    } finally {
      // Release the per-host slot only once every underlying adapter call
      // this attempt spawned has truly settled. An abandoned (timed-out)
      // call must not free the slot early — otherwise the per-host
      // concurrency cap can be exceeded by phantom in-flight work still
      // running against the real host. This is intentionally NOT awaited:
      // the caller gets its (possibly fast, timed-out) result immediately,
      // while the slot itself stays held until the real work finishes.
      void Promise.allSettled(pendingCalls).finally(() => limiter.release());
    }
    const durationMs = Math.max(0, Math.round(Date.now() - started));

    if (!result.ok) {
      return { offers: [], status: { store, ok: false, error: result.error, durationMs } };
    }
    const validated = validateOffers(store, result.offers);
    if ("error" in validated) {
      return { offers: [], status: { store, ok: false, error: validated.error, durationMs } };
    }
    const sourceStatuses = result.sourceStatuses?.map((sourceStatus) => SourceStatusSchema.safeParse(sourceStatus));
    if (sourceStatuses?.some((sourceStatus) =>
      !sourceStatus.success || (!sourceStatus.data.ok && sourceStatus.data.error.store !== store),
    )) {
      return { offers: [], status: { store, ok: false, error: storeError(store, "invalid_response", "store returned invalid source statuses", { retryable: false }), durationMs } };
    }
    return {
      offers: validated.offers,
      status: { store, ok: true, offerCount: validated.offers.length, durationMs, ...(sourceStatuses !== undefined ? { sourceStatuses: sourceStatuses.map((sourceStatus) => (sourceStatus as { success: true; data: SourceStatus }).data) } : {}) },
    };
  }

  return {
    registerAdapter: register,
    registeredStoreIds: () => [...registry.keys()].sort(),
    async search(query: SearchQuery): Promise<SearchOutcome> {
      const perStore = await Promise.all(
        [...registry.values()].map((adapter) => searchOneStore(adapter, query)),
      );
      return {
        offers: perStore.flatMap((s) => s.offers),
        storeStatuses: perStore.map((s) => s.status),
      };
    },
    async getOffer(store: string, offerId: string): Promise<AdapterOfferResult> {
      const adapter = registry.get(store);
      if (adapter === undefined) return { ok: false, error: storeError(store, "not_configured", "store adapter is not registered", { retryable: false }) };
      const limiter = limiterFor(adapter);
      await limiter.acquire();
      const pendingCalls: Array<Promise<unknown>> = [];
      let result: AdapterOfferResult;
      try { result = await attemptOffer(adapter, offerId, (p) => pendingCalls.push(p)); }
      finally { void Promise.allSettled(pendingCalls).finally(() => limiter.release()); }
      if (!result.ok) return result;
      const validated = validateOffers(store, [result.offer]);
      if ("error" in validated) return { ok: false, error: validated.error };
      const offer = validated.offers[0]!;
      if (offer.id !== offerId) {
        return { ok: false, error: storeError(store, "invalid_response", "store returned an offer with mismatched requested tuple", { retryable: false, details: { requestedOfferId: offerId, claimedOfferId: offer.id } }) };
      }
      return { ok: true, offer };
    },
  };
}
