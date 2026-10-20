/**
 * The app's one timestamp formatter. Four screens each carried their own copy,
 * and each invented a different fallback word ("recently", "Unknown",
 * "Unavailable") for the same two failure cases. They collapse here.
 *
 * Output is a *relative* age ("just now", "5m ago", "3h ago", "2d ago") — the
 * text-diet rule: a phone row wants "how long ago", not a locale date-time
 * string. The two failures stay distinct and visible: a value the desktop never
 * sent is *missing* ("Unavailable"), a value it sent that will not parse is
 * *broken* ("Unknown"). Neither is "recently" — that claims a fact the snapshot
 * does not carry. A future timestamp (clock skew) reads as "just now".
 */
export function formatTimestamp(value?: string | null, now: number = Date.now()): string {
  if (!value) {
    return "Unavailable";
  }

  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) {
    return "Unknown";
  }

  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  const weeks = Math.round(days / 7);
  return `${weeks}w ago`;
}
