/**
 * Rate Limiter for API requests and token usage
 *
 * This implements:
 * - Sliding-window request limiting
 * - Sliding-window token limiting
 * - Maximum concurrent requests
 * - FIFO waiting queue
 */

export interface RateLimiterConfig {
  /** Maximum requests per minute */
  maxRequestsPerMinute: number;

  /** Maximum tokens per minute */
  maxTokensPerMinute: number;

  /** Maximum concurrent requests */
  maxConcurrent: number;
}

export const DEFAULT_RATE_LIMITS: RateLimiterConfig = {
  maxRequestsPerMinute: 50,
  maxTokensPerMinute: 100000,
  maxConcurrent: 5
};

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

/**
 * Token/request rate limiter using a sliding 60-second window.
 */
export class RateLimiter {
  private config: RateLimiterConfig;

  private requestHistory: RequestRecord[] = [];

  private activeRequests = 0;

  private waitQueue: Array<() => void> = [];

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = {
      ...DEFAULT_RATE_LIMITS,
      ...config
    };
  }

  /**
   * Wait until a request can be made within all configured limits.
   */
  async acquire(estimatedTokens: number = 1000): Promise<void> {
    if (estimatedTokens < 0) {
      throw new Error('estimatedTokens cannot be negative');
    }

    /*
     * Wait for an available concurrent slot.
     *
     * The condition is checked again after every wake-up because
     * multiple requests may be waiting for the same slot.
     */
    while (this.activeRequests >= this.config.maxConcurrent) {
      await this.waitForSlot();
    }

    /*
     * Wait until both request-per-minute and token-per-minute
     * limits allow this request.
     */
    await this.waitForRateLimit(estimatedTokens);

    /*
     * Record the request only after all limits have been satisfied.
     */
    this.activeRequests++;

    this.requestHistory.push({
      timestamp: Date.now(),
      tokens: estimatedTokens
    });
  }

  /**
   * Release a request slot after completion.
   *
   * @param actualTokens Actual token usage if available.
   */
  release(actualTokens?: number): void {
    this.activeRequests = Math.max(
      0,
      this.activeRequests - 1
    );

    /*
     * If actual token usage is supplied, update the most recent
     * request record.
     */
    if (
      actualTokens !== undefined &&
      this.requestHistory.length > 0
    ) {
      const lastRequest =
        this.requestHistory[this.requestHistory.length - 1];

      if (lastRequest !== undefined) {
        lastRequest.tokens = actualTokens;
      }
    }

    /*
     * Wake the next waiter in FIFO order.
     */
    const next = this.waitQueue.shift();

    if (next !== undefined) {
      next();
    }
  }

  /**
   * Get current rate limit status.
   */
  getStatus(): {
    activeRequests: number;
    requestsInWindow: number;
    tokensInWindow: number;
    availableRequests: number;
    availableTokens: number;
  } {
    this.pruneOldRecords();

    const requestsInWindow =
      this.requestHistory.length;

    const tokensInWindow =
      this.requestHistory.reduce(
        (sum, request) => sum + request.tokens,
        0
      );

    return {
      activeRequests: this.activeRequests,

      requestsInWindow,

      tokensInWindow,

      availableRequests: Math.max(
        0,
        this.config.maxRequestsPerMinute -
          requestsInWindow
      ),

      availableTokens: Math.max(
        0,
        this.config.maxTokensPerMinute -
          tokensInWindow
      )
    };
  }

  /**
   * Check if a request can proceed immediately.
   */
  canProceed(
    estimatedTokens: number = 1000
  ): boolean {
    if (estimatedTokens < 0) {
      return false;
    }

    this.pruneOldRecords();

    /*
     * Check concurrent request limit.
     */
    if (
      this.activeRequests >=
      this.config.maxConcurrent
    ) {
      return false;
    }

    /*
     * Check request-per-minute limit.
     */
    const requestsInWindow =
      this.requestHistory.length;

    if (
      requestsInWindow >=
      this.config.maxRequestsPerMinute
    ) {
      return false;
    }

    /*
     * Check token-per-minute limit.
     */
    const tokensInWindow =
      this.requestHistory.reduce(
        (sum, request) => sum + request.tokens,
        0
      );

    if (
      tokensInWindow + estimatedTokens >
      this.config.maxTokensPerMinute
    ) {
      return false;
    }

    return true;
  }

  /**
   * Wait for a concurrent request slot to become available.
   */
  private async waitForSlot(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  /**
   * Wait until request/token rate limits allow the request.
   */
  private async waitForRateLimit(
    estimatedTokens: number
  ): Promise<void> {
    while (!this.canProceed(estimatedTokens)) {
      this.pruneOldRecords();

      /*
       * If there are no historical requests, there is nothing
       * meaningful to wait for.
       */
      if (this.requestHistory.length === 0) {
        break;
      }

      const oldestRequest =
        this.requestHistory[0];

      /*
       * TypeScript's noUncheckedIndexedAccess setting can make
       * indexed array access possibly undefined. Although the
       * length check above guarantees an item exists at runtime,
       * explicitly guard it for type safety.
       */
      if (oldestRequest === undefined) {
        break;
      }

      const now = Date.now();

      /*
       * A record expires 60 seconds after it was created.
       */
      const expirationTime =
        oldestRequest.timestamp + 60000;

      /*
       * Add a small buffer to avoid repeatedly waking up just
       * before the record expires.
       */
      const calculatedWait =
        expirationTime - now + 100;

      /*
       * Minimum wait: 100ms.
       * Maximum wait: 5 seconds.
       */
      const waitTime = Math.min(
        5000,
        Math.max(100, calculatedWait)
      );

      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitTime);
      });
    }
  }

  /**
   * Remove request records older than 60 seconds.
   */
  private pruneOldRecords(): void {
    const cutoff =
      Date.now() - 60000;

    this.requestHistory =
      this.requestHistory.filter(
        (record) => record.timestamp > cutoff
      );
  }
}

/**
 * Wrap an async function with rate limiting.
 */
export async function withRateLimit<T>(
  rateLimiter: RateLimiter,
  fn: () => Promise<T>,
  estimatedTokens: number = 1000
): Promise<T> {
  await rateLimiter.acquire(
    estimatedTokens
  );

  try {
    return await fn();
  } finally {
    rateLimiter.release();
  }
}

/**
 * Global rate limiter instance.
 */
export const globalRateLimiter =
  new RateLimiter();