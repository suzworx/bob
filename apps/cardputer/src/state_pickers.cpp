// Bob Cardputer v2 — conversations, Spaces and the new-chat confirmation (#301, #302).
#include "state_internal.h"

namespace bob {

namespace fsm {

// On-device conversation picker state. g_conversationListReceived distinguishes
// "list reply arrived (possibly empty)" from "no reply yet", so the 5 s timeout
// only fires when the server never answered the list request.
constexpr uint32_t kConversationListTimeoutMs = 5000;
static ListedConversation g_conversations[kMaxListedConversations];
static size_t g_conversationCount = 0;
static size_t g_selectionIndex = 0;
static uint32_t g_selectingEnteredAt = 0;
static bool g_conversationListReceived = false;

// New-conversation confirmation (#302). The request id is made once per
// confirmation and kept after a failure, so a retry is deduplicated by the
// server; g_newConversationPending debounces Enter while awaiting the ack.
constexpr uint32_t kNewConversationTimeoutMs = 5000;
String g_newConversationRequestId;
bool g_newConversationPending = false;
static uint32_t g_newConversationSentAt = 0;

// Space picker (#301). kSelecting serves both lists; g_pickerKind says which.
// Row 0 is "No space", rows 1..n are g_spaces. g_spaceSelectPending debounces
// Enter until space_selected, an error, or kSpaceSelectTimeoutMs.
constexpr uint32_t kSpaceSelectTimeoutMs = 5000;
PickerKind g_pickerKind = PickerKind::kConversations;
static ListedSpace g_spaces[kMaxListedSpaces];
static size_t g_spaceCount = 0;
static bool g_spaceListReceived = false;
bool g_spaceSelectPending = false;
static uint32_t g_spaceSelectSentAt = 0;
static const char* g_spaceLabels[kMaxPickerRows];

// Active Space: RAM only, overwritten by every welcome. Pushes arriving during
// capture/awaiting are held and applied at playback end.
ActiveSpace g_activeSpace;
ActiveSpace g_pendingSpace;
bool g_pendingSpaceValid = false;

ActiveConversation g_activeConversation;
ActiveConversation g_pendingActive;   // held during playback, applied at end.
bool g_pendingActiveValid = false;

void applyActiveConversation(const ActiveConversation& conv) {
  g_activeConversation = conv;
  if (state == State::kReady) enterReady();
  journalEvent("active_conversation_applied");
}

void handleActiveConversation(const String& text) {
  ActiveConversation conv;
  if (!parseActiveConversation(text, conv)) return;
  // Never redraw during playback (contract R10): hold the push in RAM and
  // apply it at playback_end.
  if (state == State::kCapturing || state == State::kAwaiting) {
    g_pendingActive = conv;
    g_pendingActiveValid = true;
    journalEvent("active_conversation_held");
  } else {
    applyActiveConversation(conv);
  }
}

void applyActiveSpace(const ActiveSpace& space) {
  g_activeSpace = space;
  if (state == State::kReady) enterReady();
  journalEvent("active_space_applied",
               String("present=") + (space.present ? "1" : "0"));
}

// Applies server Space state now, or holds it while a turn is in flight and
// applies it at playback end (same rule as active_conversation, R10).
static void offerActiveSpace(const ActiveSpace& space) {
  if (state == State::kCapturing || state == State::kAwaiting) {
    g_pendingSpace = space;
    g_pendingSpaceValid = true;
    journalEvent("active_space_held");
  } else {
    applyActiveSpace(space);
  }
}

void handleActiveSpace(const String& text) {
  ActiveSpace space;
  if (!parseActiveSpace(text, space)) return;
  offerActiveSpace(space);
}

void enterPicker() {
  playback.abort();
  g_pickerKind = PickerKind::kConversations;
  g_conversationCount = 0;
  g_selectionIndex = 0;
  g_conversationListReceived = false;
  g_selectingEnteredAt = millis();
  transitionTo(State::kSelecting, "CONVERSATIONS", "Loading...", kColorYellow, "");
  network.sendControl(buildListConversations());
  journalEvent("picker_opened");
}

void cancelPicker() {
  g_spaceSelectPending = false;
  enterReady();
  journalEvent("picker_cancelled");
}

static size_t spaceRowCount() { return g_spaceListReceived ? g_spaceCount + 1 : 0; }

static void drawSpaceList() {
  g_spaceLabels[0] = "No space";
  for (size_t i = 0; i < g_spaceCount; ++i) g_spaceLabels[i + 1] = g_spaces[i].name;
  drawPickerList(PickerView{"SPACES", "No spaces", g_spaceLabels, g_spaceCount + 1},
                 g_selectionIndex);
}

void enterSpacePicker() {
  playback.abort();
  g_pickerKind = PickerKind::kSpaces;
  g_spaceCount = 0;
  g_selectionIndex = 0;
  g_spaceListReceived = false;
  g_spaceSelectPending = false;
  g_selectingEnteredAt = millis();
  transitionTo(State::kSelecting, "SPACES", "Loading...", kColorYellow, "");
  network.sendControl(buildListSpaces());
  journalEvent("space_picker_opened");
}

void handleSpaces(const String& text) {
  g_spaceCount = parseSpaces(text, g_spaces, kMaxListedSpaces);
  g_spaceListReceived = true;
  if (state != State::kSelecting || g_pickerKind != PickerKind::kSpaces) return;
  // Start on the active Space's row, or on "No space" when there is none.
  g_selectionIndex = 0;
  for (size_t i = 0; g_activeSpace.present && i < g_spaceCount; ++i) {
    if (strcmp(g_spaces[i].id, g_activeSpace.id) == 0) g_selectionIndex = i + 1;
  }
  drawSpaceList();
  journalEvent("spaces_received",
               String("count=") + g_spaceCount);
}

static void sendSelectSpace() {
  if (g_spaceSelectPending || !g_spaceListReceived) return;
  const bool none = g_selectionIndex == 0;
  network.sendControl(buildSelectSpace(none ? nullptr : g_spaces[g_selectionIndex - 1].id));
  g_spaceSelectPending = true;
  g_spaceSelectSentAt = millis();
  drawConversationPickerHint("SAVING...", kColorYellow);
  journalEvent("space_select_sent",
               String("none=") + (none ? "1" : "0"));
}

// Keeps the picker open with a hint; Enter retries.
static void failSpaceSelect(const char* reason, const char* hint) {
  g_spaceSelectPending = false;
  drawConversationPickerHint(hint, kColorRed);
  journalEvent("space_select_failed",
               String("reason=") + reason);
}

void handleSpaceSelected(const String& text) {
  const bool inPicker =
      state == State::kSelecting && g_pickerKind == PickerKind::kSpaces;
  ActiveSpace space;
  if (!parseSpaceSelected(text, space)) {
    if (inPicker) failSpaceSelect("bad_ack", "SELECT FAILED - Enter=retry");
    return;
  }
  journalEvent("space_selected",
               String("present=") + (space.present ? "1" : "0") +
                   ",in_picker=" + (inPicker ? "1" : "0"));
  if (!inPicker) {
    offerActiveSpace(space);  // the server's state is the truth either way.
    return;
  }
  g_spaceSelectPending = false;
  g_activeSpace = space;
  enterReady();
}

// An `error` while the Space picker is open. SPACE_NOT_FOUND keeps the picker
// with a hint; anything else (e.g. BAD_MESSAGE from a server without Spaces)
// returns cleanly to READY.
void handleSpacePickerError(const char* code) {
  if (strcmp(code, "SPACE_NOT_FOUND") == 0) {
    failSpaceSelect("not_found", "SPACE NOT FOUND");
    return;
  }
  if (g_spaceSelectPending) {
    journalEvent("space_select_failed",
                 String("reason=error,code=") + code);
  } else {
    journalEvent("picker_unavailable",
                 String("kind=spaces,code=") + code);
  }
  cancelPicker();
}

void enterNewConversation() {
  g_newConversationRequestId = "";
  g_newConversationPending = false;
  transitionTo(State::kNewConversation, "NEW CHAT?", "Next turn starts fresh",
               kColorYellow, "");
  journalEvent("new_conversation_opened");
}

static void sendNewConversation() {
  if (g_newConversationPending) return;
  if (g_newConversationRequestId.length() == 0) {
    g_newConversationRequestId = messageId("newc");
  }
  network.sendControl(buildNewConversation(g_newConversationRequestId));
  g_newConversationPending = true;
  g_newConversationSentAt = millis();
  transitionTo(State::kNewConversation, "NEW CHAT?", "Starting...", kColorYellow, "");
  journalEvent("new_conversation_sent");
}

static void cancelNewConversation() {
  g_newConversationPending = false;
  g_newConversationRequestId = "";
  enterReady();
  journalEvent("new_conversation_cancelled");
}

// Keeps the old conversation and the request id, so Enter retries the same
// request and the server answers a duplicate with the original ack.
void failNewConversation(const char* event) {
  g_newConversationPending = false;
  transitionTo(State::kNewConversation, "NEW CHAT?", "Failed - Enter=retry", kColorRed,
               "");
  journalEvent(event);
}

void handleConversationCleared() {
  if (state != State::kNewConversation || !g_newConversationPending) {
    journalEvent("new_conversation_ack_ignored");
    return;
  }
  g_newConversationPending = false;
  g_newConversationRequestId = "";
  g_activeConversation = ActiveConversation();
  enterReady();
  journalEvent("new_conversation_acked");
}

void handleConversations(const String& text) {
  g_conversationCount = parseConversations(text, g_conversations, kMaxListedConversations);
  g_conversationListReceived = true;
  if (state != State::kSelecting || g_pickerKind != PickerKind::kConversations) return;
  g_selectionIndex = 0;
  drawConversationList(g_conversations, g_conversationCount, g_selectionIndex);
  journalEvent("conversations_received",
               String("count=") + g_conversationCount);
}

// The READY screen draws from g_activeConversation, so the picked
// conversation is adopted at once; the server's follow-up
// active_conversation push confirms it (contract S-5).
void handleConversationSelected(const String& text) {
  if (state != State::kSelecting || g_pickerKind != PickerKind::kConversations) {
    journalEvent("conversation_selected_ignored");
    return;
  }
  char selectedId[kConversationIdBytes];
  if (extractSelectedConversationId(text, selectedId, sizeof(selectedId))) {
    journalEvent("conversation_selected");
    for (size_t i = 0; i < g_conversationCount; ++i) {
      if (strcmp(g_conversations[i].id, selectedId) != 0) continue;
      strncpy(g_activeConversation.id, g_conversations[i].id, kConversationIdBytes - 1);
      g_activeConversation.id[kConversationIdBytes - 1] = '\0';
      strncpy(g_activeConversation.title, g_conversations[i].title, kConversationTitleBytes - 1);
      g_activeConversation.title[kConversationTitleBytes - 1] = '\0';
      g_activeConversation.present = true;
      break;
    }
  }
  enterReady();
}

void pickerKeys(const Keyboard_Class::KeysState& keys) {
  const bool spaces = g_pickerKind == PickerKind::kSpaces;
  const size_t rowCount = spaces ? spaceRowCount() : g_conversationCount;
  auto redraw = []() {
    if (g_pickerKind == PickerKind::kSpaces) {
      drawSpaceList();
    } else {
      drawConversationList(g_conversations, g_conversationCount, g_selectionIndex);
    }
  };
  if (keys.enter) {
    if (spaces) {
      sendSelectSpace();
    } else if (g_conversationCount > 0) {
      network.sendControl(
          buildSelectConversation(g_conversations[g_selectionIndex].id));
      journalEvent("conversation_select_sent");
    }
  }
  const size_t lastRow = rowCount > 0 ? rowCount - 1 : 0;
  for (char c : keys.word) {
    if (c == ';' || c == '.') {
      if (stepWithin(&g_selectionIndex, lastRow, c == ';' ? -1 : 1)) redraw();
    } else if (c == '`') {
      cancelPicker();
      return;
    }
  }
}

void newConversationKeys(const Keyboard_Class::KeysState& keys) {
  for (char c : keys.word) {
    if (c == '`') {
      cancelNewConversation();
      return;
    }
  }
  if (keys.enter) sendNewConversation();
}

// The pickers and NEW CHAT? never strand the device on a server that does
// not answer.
void pickerTick() {
  // No list reply: back to READY after the timeout.
  const bool listReceived = g_pickerKind == PickerKind::kSpaces
                                ? g_spaceListReceived
                                : g_conversationListReceived;
  if (state == State::kSelecting && !listReceived &&
      millis() - g_selectingEnteredAt >= kConversationListTimeoutMs) {
    journalEvent("picker_timeout");
    cancelPicker();
  }

  // A select_space the server never answered re-enables Enter for a retry.
  if (state == State::kSelecting && g_pickerKind == PickerKind::kSpaces &&
      g_spaceSelectPending &&
      millis() - g_spaceSelectSentAt >= kSpaceSelectTimeoutMs) {
    failSpaceSelect("timeout", "NO REPLY - Enter=retry");
  }

  // A new_conversation never acknowledged: keep the old conversation and
  // offer a deduplicated retry.
  if (state == State::kNewConversation && g_newConversationPending &&
      millis() - g_newConversationSentAt >= kNewConversationTimeoutMs) {
    failNewConversation("new_conversation_timeout");
  }
}

}  // namespace fsm

}  // namespace bob
