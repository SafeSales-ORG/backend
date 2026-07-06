import { env } from '../env.js';
import { logger } from '../lib/logger.js';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 8_000;

interface BuyerOrderEmailInput {
  order: {
    id: string;
    shortId: string;
    orderToken: string;
    buyerEmail: string | null;
    buyerName: string;
    amountNGN: number;
  };
  listing: {
    title: string;
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNGN(amount: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(amount);
}

function buildOrderLink(orderToken: string): string {
  return `${env.FRONTEND_APP_URL}/order/${encodeURIComponent(orderToken)}`;
}

function usesResendTestSender(): boolean {
  return /@resend\.dev\b/i.test(env.RESEND_FROM_EMAIL);
}

function resolveRecipient(order: BuyerOrderEmailInput['order']): string | null {
  if (env.NODE_ENV !== 'production' && usesResendTestSender()) {
    if (!env.RESEND_TEST_TO_EMAIL) {
      logger.warn(
        { orderId: order.id },
        'RESEND_TEST_TO_EMAIL missing; resend.dev can only email the verified Resend account',
      );
      return null;
    }
    return env.RESEND_TEST_TO_EMAIL;
  }

  return order.buyerEmail;
}

export async function sendBuyerOrderLinkEmail({
  order,
  listing,
}: BuyerOrderEmailInput): Promise<void> {
  if (!order.buyerEmail) {
    logger.warn({ orderId: order.id }, 'Buyer email missing; order link email skipped');
    return;
  }

  const recipient = resolveRecipient(order);
  if (!recipient) {
    logger.warn({ orderId: order.id }, 'Order link email skipped; no valid Resend recipient');
    return;
  }

  if (!env.RESEND_API_KEY) {
    logger.warn({ orderId: order.id }, 'RESEND_API_KEY missing; order link email skipped');
    return;
  }

  const orderLink = buildOrderLink(order.orderToken);
  const safeName = escapeHtml(order.buyerName);
  const safeTitle = escapeHtml(listing.title);
  const safeShortId = escapeHtml(order.shortId);
  const safeOrderLink = escapeHtml(orderLink);
  const amount = escapeHtml(formatNGN(order.amountNGN));

  const subject = `Your SafeSale order ${order.shortId} is secured`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #14231b;">
      <h1 style="font-size: 22px; margin-bottom: 12px;">Your SafeSale order is secured</h1>
      <p>Hello ${safeName},</p>
      <p>Your payment for <strong>${safeTitle}</strong> has been locked in escrow.</p>
      <p><strong>Order:</strong> ${safeShortId}<br><strong>Amount:</strong> ${amount}</p>
      <p>Use this private link to track your order, confirm delivery, or open a dispute:</p>
      <p>
        <a href="${safeOrderLink}" style="display: inline-block; padding: 12px 16px; background: #0f7a4f; color: #ffffff; text-decoration: none; border-radius: 6px;">
          Track my order
        </a>
      </p>
      <p style="word-break: break-all; font-size: 13px; color: #506158;">${safeOrderLink}</p>
      <p style="font-size: 13px; color: #506158;">Keep this link safe. It is your private access to this order.</p>
    </div>
  `;

  let res: Response;
  try {
    res = await fetch(RESEND_EMAILS_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL,
        to: [recipient],
        subject,
        html,
      }),
    });
  } catch (err) {
    logger.warn(
      { orderId: order.id, err: err instanceof Error ? err.message : err },
      'Resend order link email failed (non-fatal)',
    );
    return;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn(
      { orderId: order.id, status: res.status, body },
      'Resend order link email rejected (non-fatal)',
    );
    return;
  }

  logger.info(
    {
      orderId: order.id,
      buyerEmail: order.buyerEmail,
      recipient,
      redirectedForResendTest: recipient !== order.buyerEmail,
    },
    'Buyer order link email sent',
  );
}
