/**
 * timecode.js – SMPTE-style timecode formatting utility
 */

const NLE_TIME_BASE = 1_000_000; // microseconds

/**
 * Convert microseconds (NLE time base) to seconds.
 * @param {number} us — time in microseconds
 * @returns {number} time in seconds
 */
export function usToSecs(us) {
  return us / NLE_TIME_BASE;
}

/**
 * Convert seconds to microseconds (NLE time base).
 * @param {number} secs — time in seconds
 * @returns {number} time in microseconds
 */
export function secsToUs(secs) {
  return Math.round(secs * NLE_TIME_BASE);
}

/**
 * Get frame duration in microseconds for a given frame rate.
 * @param {number} fps — frames per second
 * @returns {number} frame duration in microseconds
 */
export function frameDurationUs(fps) {
  return Math.round((1 / Math.max(1, fps)) * NLE_TIME_BASE);
}

/**
 * Format a time in seconds as HH:MM:SS:FF using the given frame rate.
 * @param {number} secs
 * @param {number} fps
 * @returns {string}
 */
export function formatTimecode(secs, fps) {
  const f = Math.max(1, Math.round(fps));
  const totalFrames = Math.floor(secs * f);
  const ff = totalFrames % f;
  const totalSec = Math.floor(totalFrames / f);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return [hh, mm, ss, ff].map((n) => String(n).padStart(2, '0')).join(':');
}
