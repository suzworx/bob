// Bob Cardputer v2 — the reply card (#318), HELP, announcements (#319-#321) and timers (#457).
#include "state_internal.h"
#if defined(BOB_BOARD_WAVESHARE_185C)
#include "round_feedback.h"
#include "turn_trouble.h"
#endif

namespace bob {

namespace fsm {

// Reply card (#318): the reply_text of the current turn, shown on READY after
// playback until any key or the next turn. RAM only; never journaled. The round
// board shows it as soon as it arrives, over the speaking Bob, and keeps it
// through the follow-up window (owner UX audit 2026-10-20, #1063).
ReplyText g_reply;
bool g_replyForTurn = false;
bool g_cardShown = false;
size_t g_cardLines = 0;
size_t g_cardScroll = 0;
bool g_replyLive = false;
#if defined(BOB_BOARD_WAVESHARE_185C)
static uint32_t g_replyPageAt = 0;     // when the reply on screen last turned its page.
static bool g_replyPagedByHand = false;  // a swipe took over: the auto-pager stops.

// reply_text arrived for the turn in flight: its words show now, the speaking Bob above them.
static void showLiveReply() {
  g_cardLines = layoutReplyCard(g_reply);
  g_replyLive = g_cardLines > 0;
  g_cardScroll = 0;
  g_replyPageAt = millis();
  g_replyPagedByHand = false;
  if (g_replyLive && state == State::kAwaiting) {
    drawSpeakingReply(g_reply, 0);
    journalEvent("reply_shown_live");
  }
}

// The reply on screen turns `delta` pages (a swipe; ; and .), without leaving it.
void pageReply(int delta) {
  const size_t next = replyPageStep(g_cardScroll, delta, false);
  g_replyPagedByHand = true;
  if (next == g_cardScroll) return;
  g_cardScroll = next;
  if (!drawReplyPage(g_reply, g_cardScroll)) drawReplyCard(g_reply, g_cardScroll);
}

// While the reply shows (speaking, or the card on READY) and no swipe took over, its
// page turns every kReplyPageMs and wraps round, like the demo's reply card.
void replyPageTick(uint32_t nowMs) {
  const bool showing = (state == State::kAwaiting && g_replyLive) || (state == State::kReady && g_cardShown);
  if (!showing || g_replyPagedByHand || !replyOnScreen()) return;
  if (nowMs - g_replyPageAt < kReplyPageMs) return;
  g_replyPageAt = nowMs;
  const size_t next = replyPageStep(g_cardScroll, 1, true);
  if (next != g_cardScroll && drawReplyPage(g_reply, next)) g_cardScroll = next;
}
#endif

size_t g_helpScroll = 0;

// Announcements (#319-#321): the card on screen, and the inbox (card_policy.h)
// of ones that arrived while busy and of recently acked ids, so a replay is
// never shown twice.
constexpr uint32_t kAnnounceLingerMs = 10000;  // after its message has played.
Announcement g_announce;
bool g_announceActive = false;
bool g_announcePlaying = false;
bool g_announceAcked = false;
bool g_announceMissed = false;  // #389: rang its full ring_seconds, acked "missed".
static uint32_t g_announcePlayedAt = 0;
AnnounceInbox g_announceInbox;

// #457: the last timers_state (fixed array, RAM only); reset by every welcome.
TimersModel g_timers;

// --- Reply card (#318) ---

void handleReplyText(const String& text) {
  // Parsed into scratch first: only the reply for the turn in flight replaces
  // g_reply, so a late reply for a stopped or earlier turn never overwrites
  // the current card. Static, not on the loop task's stack (~0.9 KB). The
  // text itself is never journaled.
  static ReplyText incoming;
  if (!parseReplyText(text, incoming)) {
    journalEvent("reply_text_bad");
    return;
  }
  const bool inTurn = state == State::kCapturing || state == State::kAwaiting;
  const ReplyTextFate fate =
      replyTextFate(inTurn, incoming.turnRef, turnRef.c_str(), g_cancelledTurnRef.c_str());
  if (fate != ReplyTextFate::kKeep) {
    journalEvent("reply_text_ignored",
                 String("reason=") + replyTextFateName(fate));
    return;
  }
  g_reply = incoming;
  g_replyForTurn = true;
  // Heard as nothing on ANY turn (wake, GO or follow-up), e.g. a TTS-stage 402
  // out-of-credit reply: no follow-up window opens after it (#1041).
  g_chain.replyHeard(g_reply.heard);
  journalEvent("reply_text_received",
               String("heard_len=") + strlen(g_reply.heard) +
                   ",reply_len=" + strlen(g_reply.reply) + ",kept=1");
#if defined(BOB_BOARD_WAVESHARE_185C)
  showLiveReply();
#endif
}

// The reply finished playing: back to READY, showing the card if the turn
// sent reply_text. In Always awake the follow-up window opens first and the
// card shows once it closes.
// allowFollowUp false: x or GO skipped the window during the guard. The card
// is journaled when it is actually drawn (after the window, if one opens).
void finishTurn(bool allowFollowUp) {
#if defined(BOB_BOARD_WAVESHARE_185C)
  // A hands-free turn the server heard as nothing ends with an empty reply_text.
  const bool heardNothing = g_replyForTurn && g_reply.heard[0] == '\0' && g_reply.reply[0] == '\0';
#endif
  g_cardLines = g_replyForTurn ? layoutReplyCard(g_reply) : 0;
  g_cardShown = g_cardLines > 0;
#if defined(BOB_BOARD_WAVESHARE_185C)
  if (!g_replyLive || !g_cardShown) g_cardScroll = 0;  // the card opens on the page the reply ended on.
  g_replyLive = false;
#else
  g_cardScroll = 0;
#endif
  g_replyForTurn = false;
  const bool window = allowFollowUp && openFollowUp();
  if (!window) enterReady();
#if defined(BOB_BOARD_WAVESHARE_185C)
  if (heardNothing && !window) roundUiTrouble(troubleCaption(TurnTrouble::kNotHeard), millis());
#endif
  if (g_cardShown && !window) {
    journalEvent("reply_card_shown", String("lines=") + g_cardLines);
  }
  journalTurnHeap();
}

void closeReplyCard() {
  if (!g_cardShown) return;
  g_cardShown = false;
  enterReady();
  journalEvent("reply_card_closed");
}

// --- HELP ---

void openHelp() {
  g_cardShown = false;
  g_helpScroll = 0;
  transitionTo(State::kHelp, "HELP", "", kColorWhite, "");
  journalEvent("help_opened");
}

void closeHelp() {
  enterReady();
  journalEvent("help_closed");
}

// --- Announcements (#319-#321) ---

// Dedupes by announce_id: the one on screen, the held ones and recent acks.
static bool announceSeen(const char* id) {
  return (g_announceActive && strcmp(g_announce.id, id) == 0) || g_announceInbox.seen(id);
}

// Announcements show over READY and HELP only; anywhere else (a turn, a
// picker, a card already up) they wait in the queue.
static bool canPresentAnnouncement() {
  return (state == State::kReady || state == State::kHelp) && !playback.active();
}

static void presentAnnouncement(const Announcement& announcement) {
  closeFollowUp(FollowUpClose::kAnnounce);  // announcements take priority.
  stopWakeListening();  // the chime and ring need the speaker's GPIO 43.
  g_announce = announcement;
  g_announceActive = true;
  g_announcePlaying = false;
  g_announceAcked = false;
  g_announcePlayedAt = 0;
  g_announceMissed = false;
  g_cardShown = false;
  if (announcement.ring) {
    ringStart(millis(), settings().ringSound, settings().ringSeconds,
              announcement.kind == AnnounceKind::kAlarm);
  } else {
    switch (announcement.kind) {
      case AnnounceKind::kTimer: playEarcon(Earcon::kTimer); break;
      case AnnounceKind::kAlarm: playEarcon(Earcon::kAlarm); break;
      case AnnounceKind::kReminder: playEarcon(Earcon::kChime); break;
      case AnnounceKind::kNotice: playEarcon(Earcon::kNotice); break;
    }
  }
  transitionTo(State::kAnnounce, "", "", kColorYellow, "");
  journalEvent("announce_shown",
               String("announce_id=") + announcement.id +
                   ",kind=" + announceKindName(announcement.kind) +
                   ",ring=" + (announcement.ring ? 1 : 0));
  if (announcement.ring) {
    journalEvent("ring_started",
                 String("kind=") + announceKindName(announcement.kind) +
                     ",ring_s=" + settings().ringSeconds + ",sound=" + ringSoundName(settings().ringSound));
  }
}

void handleAnnounce(const String& text) {
  Announcement announcement;
  if (!parseAnnounce(text, announcement)) {
    journalEvent("announce_bad");
    return;
  }
  if (announceSeen(announcement.id)) {
    journalEvent("announce_duplicate",
                 String("announce_id=") + announcement.id);
    return;
  }
  // A ringing timer closes Settings and rings (#669). If leaving Settings does
  // not land on Ready (reconnecting, pairing), it is held like any other.
  if (state == State::kSettings && settingsYieldsTo(announcement.ring)) leaveSettings();
  if (canPresentAnnouncement()) {
    presentAnnouncement(announcement);
    return;
  }
  if (!g_announceInbox.hold(announcement)) {
    // Not acked, so the server replays it on the next connection.
    journalEvent("announce_queue_full",
                 String("announce_id=") + announcement.id);
    return;
  }
  journalEvent("announce_held",
               String("announce_id=") + announcement.id + ",depth=" + g_announceInbox.held());
}

// #457: the account's running timers. Stored at any time (even mid-turn); the
// band only paints on the plain Ready screen. A bad message keeps the last list.
void handleTimersState(const String& text) {
  TimersMessage parsed;
  if (!parseTimersState(text, parsed)) {
    journalEvent("timers_state_bad");
    return;
  }
  timersApply(g_timers, parsed, millis());
  journalEvent("timers_state", String("count=") + parsed.count);
}

void presentNextAnnouncement() {
  if (g_announceInbox.held() == 0 || !canPresentAnnouncement()) return;
  Announcement next;
  g_announceInbox.takeNext(next);
  presentAnnouncement(next);
}

static void ackAnnouncement(AnnounceAction action) {
  if (g_announceAcked) return;
  network.sendControl(buildAnnounceAck(g_announce.id, action));
  g_announceAcked = true;
  g_announceInbox.rememberAcked(g_announce.id);
  journalEvent("announce_acked",
               String("announce_id=") + g_announce.id + ",action=" + announceActionName(action));
}

// Any key or BtnA: stop the ring or the message and acknowledge.
void dismissAnnouncement(const char* source) {
  if (!g_announceActive) return;
  // A key can arrive before playback_start, while only the prelude is active.
  stopEarcon();
  if (ringing()) {
    const uint32_t ringMs = ringElapsedMs(millis());
    ringStop();
    journalEvent("ring_stopped",
                 String("reason=dismissed,ring_ms=") + ringMs);
  }
  if (g_announcePlaying) {
    playback.abort();
    g_announcePlaying = false;
  }
  ackAnnouncement(AnnounceAction::kDismissed);
  g_announceActive = false;
  enterReady();
  journalEvent("announce_closed", String("source=") + source);
}

// Housekeeping while the card is up: ack "played" when its message ends,
// close the card a little later, and end a ring that ran its ring_seconds:
// it stops, the card says "Missed timer" until a key, and the server hears
// "missed" (#389).
void tickAnnouncement(uint32_t nowMs) {
  if (state != State::kAnnounce || !g_announceActive) return;
  if (g_announcePlaying && !playback.active()) {
    g_announcePlaying = false;
    g_announcePlayedAt = nowMs;
    ackAnnouncement(AnnounceAction::kPlayed);
  }
  if (g_announcePlayedAt != 0 && nowMs - g_announcePlayedAt >= kAnnounceLingerMs) {
    g_announceActive = false;
    enterReady();
    journalEvent("announce_closed", "source=played");
    return;
  }
  if (ringTick(nowMs)) {
    g_announceMissed = true;
    journalEvent("ring_stopped",
                 String("reason=missed,ring_ms=") + ringElapsedMs(nowMs));
    ackAnnouncement(AnnounceAction::kMissed);
    transitionTo(State::kAnnounce, "", "", kColorYellow, "");
  }
}

}  // namespace fsm

}  // namespace bob
