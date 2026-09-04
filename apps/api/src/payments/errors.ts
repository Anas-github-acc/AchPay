/**
 * Thrown by an adapter for a rail that exists on paper but cannot be called
 * yet. Distinct from a declined charge: nothing was attempted, so there is
 * nothing to reconcile.
 */
export class NotYetAvailableError extends Error {
  readonly code = 'NOT_YET_AVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'NotYetAvailableError';
  }
}

/** The provider rejected the request. Carries whatever it told us, verbatim. */
export class ProviderError extends Error {
  readonly code = 'PROVIDER_ERROR';

  constructor(
    message: string,
    readonly providerCode?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
