export type MandateStatus = 'active' | 'revoked' | 'expired';

export interface MandateRecord {
  id: string;
  user_ref: string;
  /** Integer paise. Lifetime ceiling for this mandate. */
  max_amount_paise: number;
  /** Integer paise already spent. Only ever increases. */
  used_paise: number;
  expires_at: string;
  status: MandateStatus;
  provider_token: string | null;
  created_at: string;
}

export interface CreateMandateInput {
  user_ref: string;
  max_amount_paise: number;
  expires_at: string | Date;
  provider_token?: string | null;
}
