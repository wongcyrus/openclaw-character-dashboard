import { useEffect, useRef } from "react";

import { useWorldStore } from "@/store/worldStore";
import { useCharacterStore } from "@/store/characterStore";
import { formatSenderHeader } from "@/utils/messageFormat";

import "./InspectorPanel.css";

/**
 * InspectorPanel
 *
 * Renders details about whatever the user has clicked on the map.
 * Reads from Zustand — no props needed.
 */
export function InspectorPanel(): JSX.Element {
  const selection = useWorldStore((s) => s.inspectorSelection);
  const worldConfig = useWorldStore((s) => s.worldConfig);
  const characterStates = useCharacterStore((s) => s.characterStates);
  const characterHistory = useCharacterStore((s) => s.characterHistory);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const selectedCharHistory =
    selection?.type === "character"
      ? (characterHistory[selection.characterId] ?? [])
      : [];

  useEffect(() => {
    if (selectedCharHistory.length > 0) {
      messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
    }
  }, [selectedCharHistory.length]);

  if (!selection) {
    return (
      <aside className="inspector-panel inspector-panel--empty">
        <p className="inspector-panel__hint">
          Click a character or room on the map
        </p>
      </aside>
    );
  }

  if (selection.type === "character") {
    const charState = characterStates[selection.characterId];
    const charConfig = worldConfig?.characters.find(
      (c) => c.id === selection.characterId,
    );
    const room = worldConfig?.rooms.find(
      (r) => r.id === charState?.currentRoomId,
    );

    return (
      <aside className="inspector-panel">
        <h2 className="inspector-panel__title">
          {charConfig?.name ?? selection.characterId}
        </h2>
        <dl className="inspector-panel__details">
          <dt>Agent ID</dt>
          <dd>{charConfig?.agentId ?? "—"}</dd>
          <dt>State</dt>
          <dd>{charState?.mainState ?? "—"}</dd>
          <dt>Sub-state</dt>
          <dd>{charState?.subState ?? "—"}</dd>
          <dt>Current room</dt>
          <dd>{room?.label ?? charState?.currentRoomId ?? "—"}</dd>
          <dt>Private room</dt>
          <dd>
            {worldConfig?.rooms.find((r) => r.id === charConfig?.privateRoomId)
              ?.label ??
              charConfig?.privateRoomId ??
              "—"}
          </dd>
        </dl>

        <section className="inspector-panel__dialogue">
          <div className="inspector-panel__section-header">
            <h3 className="inspector-panel__section-title">Recent Dialogue</h3>
            {selectedCharHistory.length > 0 && (
              <span className="inspector-panel__badge">
                {selectedCharHistory.length}
              </span>
            )}
          </div>
          {selectedCharHistory.length === 0 ? (
            <p className="inspector-panel__dialogue-empty">
              No recent messages
            </p>
          ) : (
            <div className="dialogue-list">
              {selectedCharHistory.map((msg, idx) => {
                const isUser = msg.role === "user";
                const timeStr = new Date(msg.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                });
                return (
                  <div
                    key={`${msg.timestamp}-${idx}`}
                    className={`dialogue-item dialogue-item--${isUser ? "user" : "agent"}`}
                  >
                    <div className="dialogue-item__header">
                      <span className="dialogue-item__sender">
                        {formatSenderHeader(
                          msg.role,
                          charConfig?.name ?? selection.characterId,
                          msg.channel,
                        )}
                      </span>
                      <span className="dialogue-item__time">{timeStr}</span>
                    </div>
                    <div className="dialogue-item__content">{msg.text}</div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          )}
        </section>
      </aside>
    );
  }

  if (selection.type === "room") {
    const room = worldConfig?.rooms.find((r) => r.id === selection.roomId);
    const occupants = Object.values(characterStates).filter(
      (s) => s.currentRoomId === selection.roomId,
    );

    return (
      <aside className="inspector-panel">
        <h2 className="inspector-panel__title">
          {room?.label ?? selection.roomId}
        </h2>
        <dl className="inspector-panel__details">
          <dt>ID</dt>
          <dd>{selection.roomId}</dd>
          <dt>Size</dt>
          <dd>{room ? `${room.width} × ${room.height} px` : "—"}</dd>
          <dt>Objects</dt>
          <dd>{room?.objects.length ?? "—"}</dd>
          <dt>Occupants</dt>
          <dd>
            {occupants.length === 0
              ? "Empty"
              : occupants.map((s) => s.characterId).join(", ")}
          </dd>
        </dl>
      </aside>
    );
  }

  if (selection.type === "resource-wall") {
    return (
      <aside className="inspector-panel">
        <h2 className="inspector-panel__title">Resource Wall</h2>
        <p className="inspector-panel__hint">
          Shared files browser — click the resource wall on the map to open.
        </p>
      </aside>
    );
  }

  return <aside className="inspector-panel inspector-panel--empty" />;
}
