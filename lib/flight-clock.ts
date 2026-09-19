// Every predicted aircraft position is its last reported position advanced by
// `speed x (now - report time)`. The report time is stamped by the feed, so that
// subtraction is only ever as good as the clock doing the subtracting — and
// neither end of this app owns a dependable one. A stopped time service, a
// dual-boot machine whose hardware clock holds local time, a laptop resuming
// from suspend, a VM on a drifted host: any of these leaves `Date.now()` minutes
// or hours away from the time the feed stamps its reports in. A clock running
// slow makes every report look like it arrives from the future, pins the whole
// fleet against the prediction clamp, and freezes the sky.
//
// So nothing places an aircraft using `Date.now()`. Both sides read this clock
// instead, and both discipline it the way NTP disciplines a system clock: each
// response is one round trip whose midpoint estimates the reference clock, and
// the sample with the shortest round trip wins because it has the least room to
// be wrong. The API routes discipline theirs against the upstream feeds, which
// are the authority on when a position was seen; the browser disciplines
// against the routes. Aircraft timestamps and the clock they are compared with
// then share one time base end to end, whatever either machine believes.

/** Seconds to add to this machine's clock to land on flight-feed time. */
let offsetSeconds = 0;
let synced = false;
// Half a round trip plus timestamp granularity: how far this offset could be off.
let uncertaintySeconds = Infinity;
let measuredAtMs = 0;

// A response slower than this could have been generated anywhere in a wide
// window, so it says too little about the reference clock to be worth adopting.
const maxUsableRoundTripSeconds = 8;
// A better sample always replaces a worse one, but a *newer* sample has to be
// able to take over eventually or the clock could never follow genuine drift.
// The incumbent's claim therefore weakens with age.
const uncertaintyGrowthPerSecond = 0.02;
// Below this, two samples are equally good and swapping only adds jitter.
const negligibleImprovementSeconds = 0.05;
// A gap this wide is a clock that has actually moved — a resume, an NTP step, a
// corrected time zone — rather than measurement noise, so it is adopted at once
// instead of waiting for the incumbent's confidence to decay.
const resyncThresholdSeconds = 30;

function currentUncertainty() {
  if (!synced) return Infinity;
  const ageSeconds = Math.max(0, (Date.now() - measuredAtMs) / 1000);
  return uncertaintySeconds + ageSeconds * uncertaintyGrowthPerSecond;
}

/**
 * Records one observation of the reference clock: the time the other end stated
 * (in seconds), and the local time at which that request was *sent*.
 */
export function syncFlightClock(referenceSeconds: number, requestSentAtMs: number) {
  if (!Number.isFinite(referenceSeconds) || referenceSeconds <= 0) return;

  const receivedAtMs = Date.now();
  const roundTripSeconds = Math.max(0, (receivedAtMs - requestSentAtMs) / 1000);
  if (roundTripSeconds > maxUsableRoundTripSeconds) return;

  // The reference stamped its time somewhere inside the round trip; the midpoint
  // is the unbiased estimate and half the round trip bounds the error.
  // Whole-second timestamps add their own half second of rounding.
  const sample = referenceSeconds + roundTripSeconds / 2 - receivedAtMs / 1000;
  const sampleUncertainty = roundTripSeconds / 2
    + (Number.isInteger(referenceSeconds) ? 0.5 : 0);

  if (
    !synced
    || Math.abs(sample - offsetSeconds) > resyncThresholdSeconds
    || sampleUncertainty < currentUncertainty() - negligibleImprovementSeconds
  ) {
    offsetSeconds = sample;
    uncertaintySeconds = sampleUncertainty;
    measuredAtMs = receivedAtMs;
    synced = true;
  }
}

/** Flight-feed time in seconds, as a float — the clock predictions run on. */
export function preciseNowSeconds() {
  return Date.now() / 1000 + offsetSeconds;
}

/** Flight-feed time in whole seconds. */
export function nowSeconds() {
  return Math.floor(preciseNowSeconds());
}

/** How far this machine's own clock is from flight-feed time, in seconds. */
export function clockOffsetSeconds() {
  return offsetSeconds;
}

/** Whether any response has disciplined this clock yet. */
export function clockSynced() {
  return synced;
}
