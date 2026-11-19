// Bob Cardputer v2 — full-screen cards drawn between the chrome rows: the
// HELP shortcut list, the reply card (#318) and the announcement card
// (#319-#321). Each clears only its own area, so the status line and the
// shortcut strip stay on screen.
#pragma once

#include <cstddef>
#include "types.h"

namespace bob {

// Text lines visible between the status line and the shortcut strip.
constexpr size_t kCardVisibleLines = 9;

// HELP: every state's shortcuts as one scrollable list.
size_t helpLineCount();
// wakePhrase: the phrase Always awake listens for (wake_models.h), or nullptr
// when it is off, which turns the phrase line into how to switch it on.
void drawHelp(size_t firstLine, const char* wakePhrase);

// Reply card: layoutReplyCard() word-wraps "You said" + heard and "Bob" +
// reply once into a bounded line table and returns the line count;
// drawReplyCard() then draws from any first line without re-wrapping.
size_t layoutReplyCard(const ReplyText& reply);
void drawReplyCard(const ReplyText& reply, size_t firstLine);

// Announcement card: kind, title, wrapped body; `ringing` adds the ring label,
// `missed` (#389: it rang its full ring_seconds) heads it "Missed timer".
void drawAnnouncementCard(const Announcement& announcement, bool ringing, bool missed);

}  // namespace bob
