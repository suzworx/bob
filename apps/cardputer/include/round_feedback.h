// Bob — what the Waveshare round screen says during and after a spoken turn (owner UX audit 2026-10-20,
// #1063): the reply's words while it plays, paged three lines at a time like the demo's reply card, and a
// short kind caption when a turn goes wrong. Implemented in round_ui_cards.cpp; the Cardputer has none of it
// (its reply card and toasts are unchanged).
#pragma once

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <stddef.h>
#include <stdint.h>

#include "bob_tokens.h"
#include "types.h"

namespace bob
{

// The demo's reply card turns its page every 4.2 s (docs/waveshare/device-ux-prototype.html, `reply`).
constexpr uint32_t kReplyPageMs = bobtok::kReplyPageMs;
// A turn that went wrong: Bob looks confused and the caption names why, for this long.
constexpr uint32_t kTroubleMs = bobtok::kTroubleMs;

// The demo's Speaking: Bob small and high, speaking, the reply's lines under him three at a time with page dots.
// layoutReplyCard() must have laid the reply out first.
void drawSpeakingReply(const ReplyText& reply, size_t firstLine);

// Turns the page of the reply on screen (the speaking reply or the reply card): only its lines and dots are
// repainted, Bob keeps moving. False, drawing nothing, when no reply is on screen (the info view covers it).
bool drawReplyPage(const ReplyText& reply, size_t firstLine);

// The first line of the page `delta` pages from the one showing `firstLine`; with `wrap`, past the last page is
// the first (the auto-pager), else it stops at the ends.
size_t replyPageStep(size_t firstLine, int delta, bool wrap);

// True while the reply (speaking or the card) is what the screen shows.
bool replyOnScreen();

// On the Ready screen just drawn: Bob confused and `caption` in place of the greeting for kTroubleMs, then Ready again.
// Any redraw ends it early.
void roundUiTrouble(const char* caption, uint32_t nowMs);

}  // namespace bob

#endif  // BOB_BOARD_WAVESHARE_185C
