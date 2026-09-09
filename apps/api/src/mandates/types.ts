export type { MandateRecord, MandateStatus } from '@storefront/shared';

/** What createMandate() takes. An input DTO, so it stays beside the repo. */
export interface CreateMandateInput {
  owner_id?: string;
  user_ref: string;
  max_amount_paise: number;
  expires_at: string | Date;
  provider_token?: string | null;
  provider_customer_id?: string | null;
}
