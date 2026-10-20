import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "@react-navigation/native";

// Whether the app is in the foreground, read without a render per change
// elsewhere: one listener for every clock.
const subscribeAppState = (listener: () => void) => {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
};
const appActive = () => AppState.currentState === "active";

/**
 * Whether a clock on this screen is seen: the screen is the one in front and
 * the app is in the foreground. A chat list under an open chat, or a chat
 * under its agents, ticked on unseen, every row drawn again each second for
 * nobody: work the JS thread did while the screen in front was the one that
 * needed it. A clock
 * that comes back into view reads the time at once, so it never shows a
 * stale one.
 */
function useClockSeen(): boolean {
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribeAppState, appActive);
  return focused && active;
}

/**
 * A shared clock for every elapsed time on a screen.
 *
 * The studio's `WorkingElapsed` owns a tick per row because there the row is
 * one text node in a virtual DOM. Here a list of thirty rows would be thirty
 * intervals against one JS thread, so the LIST owns the tick and passes `now`
 * down — one re-render a second instead of thirty.
 *
 * `fast` is the caller's answer to "is anything on this screen counting
 * seconds": true while a turn is in flight, false otherwise, and the interval
 * relaxes to 30s the moment nothing needs the seconds. A screen that always
 * ticked at 1s would keep the phone awake for a list of idle threads.
 */
export function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  const seen = useClockSeen();

  useEffect(() => {
    if (!seen) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), fast ? 1_000 : 30_000);
    return () => clearInterval(timer);
  }, [fast, seen]);

  return now;
}

// One ticker for every subscriber on every screen, running only while
// something is subscribed.
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | undefined;
let tickNow = Date.now();
function subscribeTick(listener: () => void) {
  tickListeners.add(listener);
  if (!tickTimer) {
    tickNow = Date.now();
    tickTimer = setInterval(() => {
      tickNow = Date.now();
      for (const each of tickListeners) each();
    }, 1_000);
  }
  return () => {
    tickListeners.delete(listener);
    if (!tickListeners.size && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };
}
const noSubscribe = () => () => undefined;

/**
 * The seconds clock for one piece of text inside a virtualized list, such as
 * an agent's "Working · 42s". Ticking the list itself (`extraData`) re-lays
 * out every row each second, and on Android `maintainVisibleContentPosition`
 * then re-pins the first visible row on every pass, so the list could not be
 * scrolled while anything counted. Only the text that counts re-renders here,
 * all of it on one shared interval. `active` false reads the clock once and
 * stops.
 */
export function useSecondsClock(active: boolean): number {
  // A snapshot must be stable between reads, so the idle clock is the moment
  // this text last rendered, not a fresh Date.now().
  const [still] = useState(() => Date.now());
  // Unseen, a counting text stops listening and holds the last second read;
  // seen again, it subscribes and the ticker's fresh time draws it.
  const seen = useClockSeen();
  return useSyncExternalStore(active && seen ? subscribeTick : noSubscribe, () => (active ? tickNow : still));
}
