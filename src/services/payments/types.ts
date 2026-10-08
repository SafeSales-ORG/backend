/**
 * Provider-agnostic payment interface. Escrow logic talks only to this;
 * each provider (Nomba today, OPay next) implements it in its own file.
 *
 * All amounts are whole naira. Providers convert to their own units.
 */

export interface PayInAccount {
  accountNumber: string;
  accountName: string;
  bankName: string;
  /** Our reference for this collection (the order token). */
  reference: string;
}

export interface TransferRequest {
  /** Deterministic, unique per payout. Retries MUST reuse it. */
  reference: string;
  amountNGN: number;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  narration: string;
}

export interface TransferResult {
  /**
   * succeeded — provider confirmed the transfer.
   * pending   — accepted or outcome unknown (timeout, 5xx); safe to retry
   *             with the same reference.
   * failed    — provider rejected it; needs a human.
   */
  status: 'succeeded' | 'pending' | 'failed';
  providerRef: string | null;
  message?: string;
}

export interface PaymentProvider {
  readonly name: string;
  createPayInAccount(params: {
    reference: string;
    accountName: string;
    amountNGN: number;
  }): Promise<PayInAccount>;
  resolveBankAccount(params: { accountNumber: string; bankCode: string }): Promise<{ accountName: string }>;
  transfer(params: TransferRequest): Promise<TransferResult>;
}
