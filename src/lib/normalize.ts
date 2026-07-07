export function normalizeOrder(order: Record<string, unknown>) {
  return {
    id: order.id,
    shortId: order.shortId,
    orderToken: order.orderToken,
    listingId: order.listingId,
    sellerId: order.sellerId,
    buyerNpub: null,
    buyerPubkey: null,
    buyerName: order.buyerName,
    buyerPhone: order.buyerPhone ?? '',
    buyerEmail: order.buyerEmail ?? null,
    buyerCity: '',
    buyerAddress: order.deliveryAddress ?? null,
    contactMethod: null,
    variant: order.variant ?? null,
    itemNGN: order.priceNGN,
    deliveryFee: 0,
    amountNGN: order.priceNGN,
    status: order.status,
    nombaPaymentRef: (order as any).nombaReference ?? null,
    trackingNumber: (order as any).trackingNumber ?? null,
    carrier: (order as any).carrier ?? null,
    shippedAt: dateOrNull((order as any).shippedAt),
    deliveredAt: dateOrNull((order as any).deliveredAt),
    releasedAt: dateOrNull((order as any).releasedAt),
    refundedAt: dateOrNull((order as any).refundedAt),
    autoReleaseAt: dateOrNull((order as any).autoReleaseAt),
    notes: (order as any).notes ?? null,
    createdAt: dateStr((order as any).createdAt),
    updatedAt: dateStr((order as any).updatedAt),
  };
}

export function normalizeSeller(seller: Record<string, unknown>) {
  if (!seller) return null;
  return {
    id: seller.id,
    npub: seller.npub,
    pubkey: seller.npub,
    handle: seller.handle,
    name: seller.name,
    location: (seller as any).location ?? '',
    category: (seller as any).category ?? '',
    bio: (seller as any).bio ?? null,
    verified: (seller as any).verified ?? false,
    avatarUrl: (seller as any).avatarUrl ?? (seller as any).avatar ?? null,
    createdAt: dateStr((seller as any).createdAt),
  };
}

export function normalizeListing(listing: Record<string, unknown>) {
  if (!listing) return null;
  return {
    id: listing.id,
    sellerId: listing.sellerId,
    title: listing.title,
    description: listing.description,
    priceNGN: listing.priceNGN,
    images: listing.images,
    category: listing.category,
    variants: (listing as any).variants ?? null,
    inStock: (listing as any).inStock,
    delivery: (listing as any).delivery ?? null,
    deliveryFee: (listing as any).deliveryFee ?? 0,
    active: (listing as any).active ?? true,
    nostrEventId: null,
    createdAt: dateStr((listing as any).createdAt),
    updatedAt: dateStr((listing as any).updatedAt),
  };
}

export function normalizeDispute(dispute: Record<string, unknown> | null) {
  if (!dispute) return null;
  return {
    id: dispute.id,
    orderId: dispute.orderId,
    reason: dispute.reason,
    summary: (dispute as any).summary ?? null,
    openedBy: (dispute as any).openedBy,
    priority: (dispute as any).priority ?? 'medium',
    status: (dispute as any).status,
    directResolutionUntil: dateOrNull((dispute as any).directResolutionUntil),
    evidenceDueAt: dateOrNull((dispute as any).evidenceDueAt),
    isReturn: (dispute as any).isReturn ?? false,
    evidence: [],
    sellerResponse: null,
    returnEvidence: (dispute as any).returnEvidence ?? null,
    resolution: (dispute as any).resolution ?? null,
    createdAt: dateStr((dispute as any).createdAt),
    resolvedAt: dateOrNull((dispute as any).resolvedAt),
  };
}

function dateOrNull(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function dateStr(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  return String(val);
}
