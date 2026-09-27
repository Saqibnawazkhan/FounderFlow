/**
 * Boundary schema for the notification-preferences matrix.
 *
 * One toggle at a time rather than a whole-form submit: the settings UI flips
 * a single switch and shows it immediately, so the payload is (event, channel,
 * on/off) and a failure only ever rolls back the one cell the user touched.
 */

import { z } from "zod";
import { NOTIFY_CHANNELS, NOTIFY_EVENTS } from "@/lib/notify/events";

export const UpdateNotificationPreferenceSchema = z.object({
  event: z.enum(NOTIFY_EVENTS as unknown as [string, ...string[]], {
    errorMap: () => ({ message: "Unknown notification type" }),
  }),
  channel: z.enum(NOTIFY_CHANNELS as unknown as [string, ...string[]], {
    errorMap: () => ({ message: "Unknown delivery channel" }),
  }),
  enabled: z.boolean({ required_error: "Choose on or off" }),
});

export type UpdateNotificationPreferenceInput = z.infer<typeof UpdateNotificationPreferenceSchema>;
