import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { VISIT_STAMP_INTERVAL_MS } from "./chatLifecycleLogic";
import { useChats } from "./ChatsContext";

/**
 * Tells the chat's desktop, while the chat is on screen here, that a person
 * has it on screen: on opening, every `VISIT_STAMP_INTERVAL_MS` while the app
 * is in front, at once when a turn ends in view, and on leaving (the screen
 * going, or the app going to the back). Whether each stamp is actually sent
 * is `visitStampDue`'s to say, and a desktop that does not advertise
 * `conversation-lifecycle` is sent nothing (`ChatsValue.visitChat`).
 *
 * A turn the person watched end here then no longer shows on the desktop as
 * finished and unseen, and the desktop's list says the same to every phone.
 */
export function useChatVisits(chat: { deviceId: string; workspaceId: string }, busy: boolean): void {
  const { visitChat } = useChats();
  const visit = useRef(visitChat);
  visit.current = visitChat;
  // When this screen last saw a turn end, on the phone's clock: the stamp
  // that covers it is due at once.
  const turnEndedAt = useRef<number | null>(null);
  const { deviceId, workspaceId } = chat;

  useEffect(() => {
    const target = { deviceId, workspaceId };
    let inFront = AppState.currentState === "active";
    visit.current(target, "open", turnEndedAt.current);
    const heartbeat = setInterval(() => {
      if (inFront) visit.current(target, "tick", turnEndedAt.current);
    }, VISIT_STAMP_INTERVAL_MS);
    const subscription = AppState.addEventListener("change", (next) => {
      const wasInFront = inFront;
      inFront = next === "active";
      if (inFront && !wasInFront) visit.current(target, "tick", turnEndedAt.current);
      if (!inFront && wasInFront) visit.current(target, "leave", turnEndedAt.current);
    });
    return () => {
      clearInterval(heartbeat);
      subscription.remove();
      if (inFront) visit.current(target, "leave", turnEndedAt.current);
    };
  }, [deviceId, workspaceId]);

  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      turnEndedAt.current = Date.now();
      visit.current({ deviceId, workspaceId }, "tick", turnEndedAt.current);
    }
    wasBusy.current = busy;
  }, [busy, deviceId, workspaceId]);
}
