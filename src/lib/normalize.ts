/**
 * API response shapes. These are the ONLY way DB rows leave the server:
 * never return raw Prisma rows (they carry bank details and user ids).
 */
import type { Dispute, Listing, Order, Seller } from '@prisma/client';

type PublicSellerInput = Pick<Seller, 'id' | 'npub' | 'handle' | 'name' | 'avatar' | 'bio' | 'verified' | 'createdAt'> &
  Partial<Pick<Seller, 'delivery'>>;

export function normalizeOrder(order: Order) {
  return {
    id: order.id,
    shortId: order.shortId,
    orderToken: order.orderToken,
    listingId: order.listingId,
    sellerId: order.sellerId,
    buyerName: order.buyerName,
    buyerPhone: order.buyerPhone ?? '',
    buyerEmail: order.buyerEmail ?? null,
    buyerCity: '',
    buyerAddress: order.deliveryAddress ?? null,
    contactMethod: null,
    quantity: order.quantity,
    variant: order.variant ?? null,
    itemNGN: order.priceNGN - order.deliveryFeeNGN,
    deliveryFee: order.deliveryFeeNGN,
    amountNGN: order.priceNGN,
    paidAmountNGN: order.paidAmountNGN ?? null,
    status: order.status,
    paymentRef: order.paymentReference ?? null,
    trackingNumber: order.trackingNumber ?? null,
    carrier: order.carrier ?? null,
    paidAt: iso(order.paidAt),
    shippedAt: iso(order.shippedAt),
    deliveredAt: iso(order.deliveredAt),
    releasedAt: iso(order.releasedAt),
    refundedAt: iso(order.refundedAt),
    autoReleaseAt: iso(order.autoReleaseAt),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

/** Public seller profile — no bank details, no user id. */
export function normalizeSeller(seller: PublicSellerInput) {
  return {
    id: seller.id,
    npub: seller.npub,
    pubkey: seller.npub,
    handle: seller.handle,
    name: seller.name,
    location: '',
    category: '',
    bio: seller.bio ?? null,
    delivery: seller.delivery ?? null,
    verified: seller.verified,
    avatarUrl: seller.avatar ?? null,
    createdAt: seller.createdAt.toISOString(),
  };
}

export function normalizeListing(listing: Listing) {
  return {
    id: listing.id,
    sellerId: listing.sellerId,
    title: listing.title,
    description: listing.description,
    priceNGN: listing.priceNGN,
    images: listing.images,
    category: listing.category,
    variants: listing.variants ?? null,
    inStock: listing.inStock,
    delivery: listing.delivery ?? null,
    deliveryFee: listing.deliveryFee ?? 0,
    active: listing.active,
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
  };
}

export function normalizeDispute(dispute: Dispute | null) {
  if (!dispute) return null;
  return {
    id: dispute.id,
    orderId: dispute.orderId,
    reason: dispute.reason,
    summary: dispute.summary ?? null,
    openedBy: dispute.openedBy,
    priority: dispute.priority,
    status: dispute.status,
    directResolutionUntil: iso(dispute.directResolutionUntil),
    evidenceDueAt: iso(dispute.evidenceDueAt),
    isReturn: dispute.isReturn,
    evidence: Array.isArray(dispute.evidence) ? dispute.evidence : [],
    sellerResponse: dispute.sellerResponse ?? null,
    returnEvidence: dispute.returnEvidence ?? null,
    resolution: dispute.resolution ?? null,
    createdAt: dispute.createdAt.toISOString(),
    resolvedAt: iso(dispute.resolvedAt),
  };
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
