/**
 * Custom error class for review operations
 */
export class ReviewError extends Error {
  constructor(
    message: string,
    public code: string,
    public metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ReviewError';
    Error.captureStackTrace(this, ReviewError);
  }
}

/**
 * Error codes for the review system
 */
export const ErrorCodes = {
  // Configuration errors
  MISSING_API_KEY: 'MISSING_API_KEY',
  MISSING_GITHUB_TOKEN: 'MISSING_GITHUB_TOKEN',
  INVALID_CONFIG: 'INVALID_CONFIG',

  // GitHub errors
  PR_NOT_FOUND: 'PR_NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  GITHUB_API_ERROR: 'GITHUB_API_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',

  // Agent errors
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  AGENT_FAILED: 'AGENT_FAILED',
  STRUCTURED_OUTPUT_FAILED: 'STRUCTURED_OUTPUT_FAILED',

  // General errors
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * Retry utility with exponential backoff and jitter.
 *
 * Retry behavior:
 * - Initial attempt happens immediately.
 * - Failed attempts are retried up to maxRetries.
 * - Delay uses exponential backoff.
 * - Random jitter is added to reduce synchronized retries.
 * - The final failure is wrapped in ReviewError.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // No more attempts remain.
      if (attempt > maxRetries) {
        break;
      }

      // Exponential backoff:
      // attempt 1 -> delayMs
      // attempt 2 -> delayMs * 2
      // attempt 3 -> delayMs * 4
      const backoff = delayMs * Math.pow(2, attempt - 1);

      // Random jitter between 0 and 100ms.
      const jitter = Math.random() * 100;

      const waitTime = backoff + jitter;

      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitTime);
      });
    }
  }

  const originalMessage =
    lastError instanceof Error
      ? lastError.message
      : String(lastError);

  throw new ReviewError(
    `Operation failed after ${maxRetries} retries: ${originalMessage}`,
    ErrorCodes.RETRY_EXHAUSTED,
    {
      maxRetries,
      delayMs,
      originalError: lastError
    }
  );
}

/**
 * Wrap an async function with timeout.
 *
 * The operation is raced against a timeout promise.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  errorMessage: string = 'Operation timed out'
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new ReviewError(
          errorMessage,
          ErrorCodes.AGENT_TIMEOUT,
          {
            timeoutMs
          }
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fn(),
      timeoutPromise
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Check if an error is a ReviewError
 */
export function isReviewError(error: unknown): error is ReviewError {
  return error instanceof ReviewError;
}

/**
 * Format error for logging/display
 */
export function formatError(error: unknown): string {
  if (isReviewError(error)) {
    return `[${error.code}] ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}