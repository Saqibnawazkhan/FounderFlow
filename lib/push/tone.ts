"use client";

/**
 * A short, pleasant two-note chime played via the Web Audio API — no asset to
 * bundle and no CSP headache. Used to guarantee an audible cue in the open app
 * when a new notification arrives, independent of the OS notification-sound
 * setting. Best-effort: silently no-ops if Web Audio is unavailable or blocked.
 */

let ctx: AudioContext | null = null;

export function playNotificationTone(): void {
  try {
    if (typeof window === "undefined") return;
    const AC: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") void ctx.resume();

    const now = ctx.currentTime;
    // Rising two-note "ding-ding" (A5 → D6).
    [880, 1174.66].forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(start);
      osc.stop(start + 0.36);
    });
  } catch {
    // Autoplay policy / no audio device — the OS notification still fires.
  }
}
