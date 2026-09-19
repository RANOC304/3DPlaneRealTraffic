// How long a frame takes to build and draw city-scale buildings depends on the
// GPU under it and on how dense the ground below happens to be, so no fixed
// tile budget can promise a frame rate on every machine. This tracks actual
// frame time instead and hands back a 0-1 detail scale that heavy scene
// content reads to shed detail — fewer building tiles, no trees — when frames
// are running long, and restore it once there is headroom again.

const targetFrameSeconds = 1 / 30;
const rollingWindow = 40;
const samples: number[] = [];
let scale = 1;
let displayFps = 60;

/** Feed one frame's delta time (seconds) in from the render loop. */
export function sampleFrameTime(deltaSeconds: number) {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
  // A backgrounded tab can resurface with a multi-second delta on its first
  // frame back; clamped to a 4fps floor so that one stale sample cannot yank
  // the display or the detail scale down further than genuine load would.
  const clamped = Math.min(deltaSeconds, 0.25);
  displayFps += (1 / clamped - displayFps) * 0.1;

  samples.push(clamped);
  if (samples.length > rollingWindow) samples.shift();
  if (samples.length < rollingWindow) return;

  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  // Quick to shed detail when frames are running long, slow to bring it back,
  // so one stutter (a GC pause, a tab switch) does not visibly downgrade the
  // scene and full detail only returns once performance is reliably good.
  if (average > targetFrameSeconds * 1.15) {
    scale = Math.max(0.35, scale - 0.08);
  } else if (average < targetFrameSeconds * 0.85) {
    scale = Math.min(1, scale + 0.03);
  }
}

/** Current detail scale: 1 is full detail, down to a 0.35 floor under load. */
export function getDetailScale() {
  return scale;
}

/** Smoothed frames-per-second, for on-screen display only. */
export function getFps() {
  return displayFps;
}
