import { z } from "zod";

/**
 * Shape of a browser PushSubscription (from `pushManager.subscribe().toJSON()`)
 * as sent to savePushSubscriptionAction.
 */
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

export type PushSubscriptionInput = z.infer<typeof PushSubscriptionSchema>;
