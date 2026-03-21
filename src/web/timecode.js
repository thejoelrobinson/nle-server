/**
 * timecode.js – SMPTE-style timecode formatting utility
 */

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
