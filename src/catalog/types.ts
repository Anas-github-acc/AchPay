export interface Product {
  sku: string;
  title: string;
  /** Integer paise. Never a float, never parsed from a request body. */
  price_paise: number;
  stock: number;
  category: string;
  /**
   * Free text. Displayed to humans and returned to agents, but NEVER read by
   * the policy engine — see src/policy. Treated as untrusted content.
   */
  description?: string;
}

export interface ProductQuery {
  q?: string;
  max_price_paise?: number;
  category?: string;
  limit?: number;
}
