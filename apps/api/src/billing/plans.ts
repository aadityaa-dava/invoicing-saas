// A paid plan only counts while Stripe says the subscription is in good
// standing. past_due keeps access because Stripe is still retrying the card.
export const ENTITLED_STATUSES = ['active', 'trialing', 'past_due'] as const;

export function isEntitledStatus(status: string): boolean {
  return (ENTITLED_STATUSES as readonly string[]).includes(status);
}

export function hasPaidPlan(
  subscription: { plan: string; status: string } | null | undefined,
): boolean {
  return (
    !!subscription &&
    subscription.plan === 'pro' &&
    isEntitledStatus(subscription.status)
  );
}
