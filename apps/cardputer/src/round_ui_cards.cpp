// Bob — native round UI, part 2: the HELP, reply and announcement cards (cards.h) on the
// Waveshare 360x360 screen. Text is wrapped to a 232 px column, centred, and drawn in rows
// whose widest line still fits the circle; no Bob here (space).
#if defined(BOB_BOARD_WAVESHARE_185C)

#include "cards.h"

#include <M5Unified.h>
#include <stdio.h>
#include <string.h>

#include "bob_motion.h"
#include "build_id.h"
#include "chrome.h"
#include "display.h"
#include "picker_window.h"
#include "round_feedback.h"
#include "round_ring.h"
#include "chrome_identity.h"
#include "round_touch.h"
#include "settings.h"
#include "round_ui.h"
#include "timers_view.h"

namespace bob
{
using namespace roundui;
namespace
{

constexpr int16_t kColumnW = 232;
constexpr int16_t kFirstY = 84;
constexpr int16_t kRowH = 24;
constexpr size_t kMaxReplyLines = 48;

enum class LineKind : uint8_t { kHeadingYou, kHeard, kBlank, kHeadingBob, kReply };
struct CardSpan
{
  uint16_t start;
  uint8_t length;
  LineKind kind;
};
CardSpan g_lines[kMaxReplyLines];
size_t g_lineCount = 0;

bool g_infoOpen = false; // the Ready screen's info view is up (see roundUiToggleInfo)

int16_t rowY(size_t row) { return kFirstY + static_cast<int16_t>(row) * kRowH; }

// Clears the card area (below the status rows, above the chips) and Bob's zone with it.
bool g_replyDrawn = false;   // the reply (card or speaking) is on screen: a page turn repaints only its lines
uint32_t g_troubleUntil = 0; // roundUiTrouble: the confused caption is up until then (0: none)

void clearCard()
{
  hideBob();
  g_infoOpen = false; // a card replaces the info view too (roundUiToggleInfo sets it again after)
  g_replyDrawn = false;
  g_troubleUntil = 0;
  auto& d = fb();
  d.fillRect(0, 14, kRuiSize, 324, kRuiGround); // from the pairing screen's Bob clip top to below the chip rows
  dirty(0, 14, kRuiSize, 324);
  chromeInvalidate();
  dirtyArc(0, 360);
  d.fillArc(kRuiCenter, kRuiCenter, 160, 181, 0, 360, kRuiGround); // the light ring's annulus
  ringLightInvalidate();
  resetIndicators();
}

void scrollbar(size_t first, size_t total)
{
  if (total <= kCardVisibleLines) { return; }
  constexpr int16_t kTrackY = 100, kTrackH = 150, kX = 312;
  const int16_t thumb = static_cast<int16_t>(kTrackH * kCardVisibleLines / total);
  const int16_t at = kTrackY + static_cast<int16_t>((kTrackH - thumb) * first / (total - kCardVisibleLines));
  fb().fillRoundRect(kX, kTrackY, 4, kTrackH, 2, 0x2A5775);
  fb().fillRoundRect(kX, at, 4, thumb, 2, kRuiText);
}

void drawSpan(const char* text, const CardSpan& span, int16_t y, uint32_t color)
{
  char buf[64];
  snprintf(buf, sizeof(buf), "%.*s", static_cast<int>(span.length), text + span.start);
  textCentered(buf, y, color, detailFont(), kColumnW);
}

// The reply text wraps balanced (the demo's text-wrap: balance): the narrowest column that keeps the same line count.
size_t wrapBalanced(const char* text, LineKind kind, CardSpan* out, size_t max)
{
  fb().setFont(static_cast<const lgfx::IFont*>(detailFont()));
  const int16_t full = static_cast<int16_t>(bobtok::kSize - 2 * bobtok::kReplyTextInset);
  Span spans[kMaxReplyLines];
  const size_t limit = max < kMaxReplyLines ? max : kMaxReplyLines;
  const size_t n = wrapSpans(text, full, spans, limit);
  int16_t width = full;
  for (int16_t w = full - 6; w > 80; w = static_cast<int16_t>(w - 6))
  {
    Span probe[kMaxReplyLines];
    if (wrapSpans(text, w, probe, limit) != n) { break; }
    width = w;
  }
  const size_t m = wrapSpans(text, width, spans, limit);
  for (size_t i = 0; i < m; ++i) { out[i] = CardSpan{spans[i].start, spans[i].length, kind}; }
  return m;
}

size_t wrapInto(const char* text, LineKind kind, CardSpan* out, size_t max)
{
  fb().setFont(static_cast<const lgfx::IFont*>(detailFont()));
  Span spans[kMaxReplyLines];
  const size_t n = wrapSpans(text, kColumnW, spans, max < kMaxReplyLines ? max : kMaxReplyLines);
  for (size_t i = 0; i < n; ++i) { out[i] = CardSpan{spans[i].start, spans[i].length, kind}; }
  return n;
}

struct HelpLine
{
  const char* key;
  const char* action;
};
constexpr char kAwakeKey[] = "Awake";
constexpr char kBuildKey[] = "fw";
// The round screen's own words (owner UX audit 2026-10-20, #1063): what a finger does, never a Cardputer key.
constexpr HelpLine kHelpLines[] = {
    {nullptr, "Ready"},
    {"Tap", "Talk"},
    {"Tap Bob", "Info"},
    {"Swipe", "Volume"},
    {kAwakeKey, nullptr},
    {nullptr, "While %s replies"}, // %s: the assistant's name
    {"Tap", "Stop and talk"},
    {nullptr, "Cards and lists"},
    {"Swipe", "Scroll"},
    {"Tap", "Close or select"},
    {nullptr, "This help"},
    {"Tap", "Back"},
    {kBuildKey, ""},
};
constexpr size_t kHelpLineCount = sizeof(kHelpLines) / sizeof(kHelpLines[0]);
} // namespace

size_t helpLineCount() { return kHelpLineCount; }

void drawHelp(size_t firstLine, const char* wakePhrase)
{
  clearCard();
  auto& d = fb();
  for (size_t row = 0; row < kCardVisibleLines && firstLine + row < kHelpLineCount; ++row)
  {
    const HelpLine& line = kHelpLines[firstLine + row];
    const int16_t y = rowY(row);
    char buf[48];
    if (line.key == nullptr)
    {
      snprintf(buf, sizeof(buf), line.action, assistantDisplay(AssistantLabel::kName));
      textCentered(buf, y, kRuiSky, titleFont());
      continue;
    }
    if (line.key == kBuildKey)
    {
      snprintf(buf, sizeof(buf), "Firmware %s", kFirmwareNumericVersion);
      textCentered(buf, y, kRuiDim, smallFont());
      continue;
    }
    if (line.key == kAwakeKey)
    {
      if (wakePhrase == nullptr) { snprintf(buf, sizeof(buf), "Awake: off"); }
      else { snprintf(buf, sizeof(buf), "Say %s to talk", wakePhrase); }
      textCentered(buf, y, kRuiText, detailFont(), kColumnW);
      continue;
    }
    d.setFont(static_cast<const lgfx::IFont*>(detailFont()));
    d.setTextDatum(middle_left);
    const int16_t kw = d.textWidth(line.key), aw = d.textWidth(line.action);
    int16_t x = kRuiCenter - (kw + aw + 10) / 2;
    d.setTextColor(kRuiAccent);
    d.drawString(line.key, x, y);
    d.setTextColor(kRuiText);
    d.drawString(line.action, x + kw + 10, y);
  }
  scrollbar(firstLine, kHelpLineCount);
}

// The reply card is Bob-first: a small Bob at the top and the reply three short lines at a time (swipe or
// ;/. to page, dots show where you are). "You said" is not on the card. The state code scrolls by
// kCardVisibleLines (9, shared with the Cardputer): layoutReplyCard reports the reply's real line count
// plus the difference, so the existing scroll bound still reaches every line when only three show.
constexpr size_t kReplyRows = 3;

size_t g_demoPages = 0; // `T ui reply`: page dots for a sample that has one real page

size_t layoutReplyCard(const ReplyText& reply)
{
  g_demoPages = 0;
  size_t n = 0;
  const char* text = reply.reply[0] != '\0' ? reply.reply : reply.heard;
  const LineKind kind = reply.reply[0] != '\0' ? LineKind::kReply : LineKind::kHeard;
  n += wrapBalanced(text, kind, g_lines, kMaxReplyLines);
  g_lineCount = n;
  return n == 0 ? 0 : n + (kCardVisibleLines - kReplyRows); // nothing heard, nothing said: no card (it was an empty one)
}

namespace
{
size_t replyPages() { return (g_lineCount + kReplyRows - 1) / kReplyRows; }

// The page a first line belongs to: a first line between pages (the Cardputer's one-line scroll) counts as the next page,
// whose last line it shows.
size_t pageOf(size_t first)
{
  const size_t pages = replyPages();
  const size_t page = (first + kReplyRows - 1) / kReplyRows;
  return pages == 0 ? 0 : page >= pages ? pages - 1 : page;
}

void pageDots(size_t first, size_t total)
{
  size_t pages = (total + kReplyRows - 1) / kReplyRows;
  if (pages < g_demoPages) { pages = g_demoPages; }
  if (pages < 2) { return; }
  const size_t page = pageOf(first);
  constexpr int16_t kR = bobtok::kReplyDotSize / 2, kPitch = bobtok::kReplyDotSize + bobtok::kReplyDotGap;
  const int16_t x0 = kRuiCenter - static_cast<int16_t>((pages - 1) * kPitch / 2);
  for (size_t i = 0; i < pages && i < 8; ++i)
  {
    fb().fillCircle(x0 + static_cast<int16_t>(i) * kPitch, bobtok::kReplyDotsY, kR, i == page ? kRuiAccent : kRuiDim);
  }
}

// The reply's lines from `firstLine` (at most three) and the page dots, into the text area under Bob.
void replyLines(const ReplyText& reply, size_t firstLine)
{
  const char* text = g_lineCount > 0 && g_lines[0].kind == LineKind::kHeard ? reply.heard : reply.reply;
  const size_t first = g_lineCount > kReplyRows && firstLine > g_lineCount - kReplyRows ? g_lineCount - kReplyRows : firstLine;
  const size_t rows = first >= g_lineCount ? 0 : g_lineCount - first < kReplyRows ? g_lineCount - first : kReplyRows;
  // The lines are centred as a block in the text area, 24 px apart (the demo's 24 px line height).
  const int16_t top = bobtok::kReplyTextTop + (bobtok::kReplyTextHeight - static_cast<int16_t>(rows) * 24) / 2;
  for (size_t row = 0; row < rows; ++row)
  {
    drawSpan(text, g_lines[first + row], top + 12 + static_cast<int16_t>(row) * 24, kRuiText);
  }
  pageDots(firstLine, g_lineCount);
}
} // namespace

void drawReplyCard(const ReplyText& reply, size_t firstLine)
{
  clearCard();
  // Bob first: the rig, small and high (token grid), happy; his clip stops above the text block.
  hideBob();
  showBob(UiMood::kIdle, kRuiBobCy, kRuiBobClipTop, bobtok::kReplyTextTop - 4);
  sceneBob(BobEmotion::kHappy);
  bobMotionRestArmsDown(true); // the demo's reply card: happy, both arms down
  bobMotionSetStage(bobtok::kBobScaleReply, bobtok::kBobRiseReply);
  replyLines(reply, firstLine);
  g_replyDrawn = true;
}

void drawSpeakingReply(const ReplyText& reply, size_t firstLine)
{
  drawReplyCard(reply, firstLine);
  showBob(UiMood::kSpeaking, kRuiBobCy, kRuiBobClipTop, bobtok::kReplyTextTop - 4); // the demo's Speaking: small, high, speaking
}

bool replyOnScreen() { return g_replyDrawn; }

bool drawReplyPage(const ReplyText& reply, size_t firstLine)
{
  if (!g_replyDrawn) { return false; }
  // The text block and its dots only (x inside the ring at every row): Bob above keeps his frame.
  constexpr int16_t kX = 50, kW = 260, kY = bobtok::kReplyTextTop - 2;
  constexpr int16_t kH = bobtok::kReplyDotsY + bobtok::kReplyDotSize - kY + 4;
  fb().fillRect(kX, kY, kW, kH, kRuiGround);
  dirty(kX, kY, kW, kH);
  replyLines(reply, firstLine);
  return true;
}

size_t replyPageStep(size_t firstLine, int delta, bool wrap)
{
  const size_t pages = replyPages();
  if (pages < 2) { return 0; }
  int page = static_cast<int>(pageOf(firstLine)) + delta;
  if (page >= static_cast<int>(pages)) { page = wrap ? 0 : static_cast<int>(pages) - 1; }
  if (page < 0) { page = wrap ? static_cast<int>(pages) - 1 : 0; }
  return static_cast<size_t>(page) * kReplyRows;
}

void drawAnnouncementCard(const Announcement& announcement, bool ringing, bool missed)
{
  clearCard();
  ringLightSetMode(ringing ? RingMode::kNotify : RingMode::kOff, millis());
  const char* label = "Notice";
  switch (announcement.kind)
  {
    case AnnounceKind::kTimer: label = missed ? "Missed timer" : "Timer"; break;
    case AnnounceKind::kAlarm: label = missed ? "Missed alarm" : "Alarm"; break;
    case AnnounceKind::kReminder: label = missed ? "Missed reminder" : "Reminder"; break;
    case AnnounceKind::kNotice: label = missed ? "Missed notice" : "Notice"; break;
  }
  char head[40];
  snprintf(head, sizeof(head), ringing ? "%s - ringing" : "%s", label);
  textCentered(head, 86, ringing || missed ? kRuiAccent : kRuiSky, detailFont());
  textCentered(announcement.title, 120, kRuiText, titleFont());
  CardSpan lines[5];
  const size_t count = wrapInto(announcement.body, LineKind::kReply, lines, 5);
  for (size_t i = 0; i < count; ++i) { drawSpan(announcement.body, lines[i], 160 + static_cast<int16_t>(i) * kRowH, kRuiDim); }
}


// --- Moved from round_ui.cpp: pairing, field, lines and picker screens ---
namespace
{
uint32_t g_pairingExpiresAtMs = 0;
int32_t g_lastCountdownSecond = -1;

void drawCountdown(uint32_t nowMs)
{
  const uint32_t left = g_pairingExpiresAtMs > nowMs ? g_pairingExpiresAtMs - nowMs : 0;
  const uint32_t sec = (left + 999) / 1000;
  char text[24];
  snprintf(text, sizeof(text), "expires %lu:%02lu", static_cast<unsigned long>(sec / 60), static_cast<unsigned long>(sec % 60));
  fb().fillRect(kRuiCenter - 112, 291, 224, 24, kRuiGround);
  dirty(kRuiCenter - 112, 291, 224, 24);
  textCentered(text, 303, kRuiAccent, microFont()); // the demo: a small yellow countdown under the address
}
}

namespace
{
const lgfx::IFont* asFont(const void* f) { return static_cast<const lgfx::IFont*>(f); }
}

void drawPairingScreen(const PairingInfo& info, uint32_t nowMs)
{
  clearScreen();
  showBob(UiMood::kHello, kRuiBobCy, kRuiBobClipTop, 222);
  bobMotionSetStage(bobtok::kBobScalePairing, bobtok::kBobRisePairing); // Bob smaller and higher, the code below him (token grid)
  // The demo spaces the dash ("4K7 - Q2X").
  char spaced[24];
  {
    const char* raw = info.userCode[0] != '\0' ? info.userCode : "---------";
    size_t n = 0;
    for (const char* q = raw; *q != '\0' && n + 4 < sizeof(spaced); ++q)
    {
      if (*q == '-' && n > 0) { spaced[n++] = ' '; spaced[n++] = '-'; spaced[n++] = ' '; }
      else { spaced[n++] = *q; }
    }
    spaced[n] = '\0';
  }
  const char* code = spaced;
  // The code in the largest of hero, title and body that fits the chord.
  const lgfx::IFont* codeFonts[] = {static_cast<const lgfx::IFont*>(roundui::codeFont()), static_cast<const lgfx::IFont*>(titleFont()), static_cast<const lgfx::IFont*>(detailFont())};
  const lgfx::IFont* useFont = codeFonts[2];
  for (const lgfx::IFont* f : codeFonts)
  {
    fb().setFont(f);
    if (fb().textWidth(code) <= chordWidth(245)) { useFont = f; break; }
  }
  textCentered(code, 245, kRuiText, useFont); // y from the demo render (code glyph rows 233..262)
  textCentered(info.verificationUri, 282, kRuiSky, urlFont());
  g_pairingExpiresAtMs = info.expiresAtMs;
  g_lastCountdownSecond = -1;
  drawCountdown(nowMs);
  ringLightSetMode(RingMode::kOk, nowMs); // the demo pulses the ring grass while pairing
}

void updatePairingCountdown(uint32_t nowMs)
{
  if (g_pairingExpiresAtMs == 0) { return; }
  const int32_t sec = g_pairingExpiresAtMs > nowMs ? static_cast<int32_t>((g_pairingExpiresAtMs - nowMs + 999) / 1000) : 0;
  if (sec == g_lastCountdownSecond) { return; }
  g_lastCountdownSecond = sec;
  drawCountdown(nowMs);
}

void drawPairingDenied()
{
  clearScreen();
  showBob(UiMood::kOffline);
  textCentered("PAIRING DENIED", 252, kRuiAccent, titleFont());
  textCentered("Tap to try again", 278, kRuiText, detailFont());
  setTapAnyKey(true); // pairingKeys retries on any key: a tap is one here
}

void drawPairedAs(const char* name)
{
  clearScreen();
  showBob(UiMood::kHello);
  textCentered("PAIRED AS", 252, kRuiText, titleFont());
  textCentered(name, 278, kRuiAccent, detailFont());
  textCentered("Reconnecting...", 300, kRuiSky, smallFont());
}

void drawFieldScreen(const char* title, const char* subtitle, const char* shown, size_t cursorColumn,
                     const char* counter, const char* error)
{
  clearScreen();
  noteFieldScreen(counter); // touch: the on-screen keyboard follows this screen
  auto& d = fb();
  textCentered(title, 78, kRuiAccent, titleFont());
  textCentered(subtitle, 100, kRuiText, smallFont());
  const int16_t w = chordWidth(150) < 250 ? chordWidth(150) : 250;
  const int16_t x = kRuiCenter - w / 2;
  d.drawRoundRect(x, 126, w, 34, 8, kRuiSky);
  d.setFont(asFont(detailFont()));
  d.setTextDatum(middle_left);
  d.setTextColor(kRuiText);
  char buf[72];
  snprintf(buf, sizeof(buf), "%s", shown);
  const size_t len = strlen(buf);
  const size_t cursor = cursorColumn < len ? cursorColumn : len;
  size_t first = 0;
  while (first < cursor)
  {
    char head[72];
    snprintf(head, sizeof(head), "%.*s", static_cast<int>(cursor - first), buf + first);
    if (d.textWidth(head) <= w - 20) { break; }
    ++first;
  }
  d.drawString(buf + first, x + 10, 143);
  char head[72];
  snprintf(head, sizeof(head), "%.*s", static_cast<int>(cursor - first), buf + first);
  const int16_t cx = x + 10 + d.textWidth(head);
  d.drawFastHLine(cx, 154, 10, kRuiAccent);
  textCentered(counter, 178, kRuiDim, smallFont());
  if (error && error[0] != '\0') { textCentered(error, 196, kRuiBad, detailFont()); }
}

void drawLinesScreen(const char* title, uint32_t titleColor, const char* const* lines, size_t count)
{
  clearScreen();
  const bool warn = titleColor == kColorRed || titleColor == kColorYellow;
  textCentered(title, 82, warn ? kRuiAccent : kRuiText, titleFont());
  const size_t shown = count < kLinesScreenMax ? count : kLinesScreenMax;
  for (size_t i = 0; i < shown; ++i) { textCentered(lines[i], 118 + static_cast<int16_t>(i) * 24, kRuiSky, detailFont()); }
}

namespace
{
constexpr int16_t kPickerFirstY = 126;
constexpr int16_t kPickerRowH = 26;
constexpr size_t kPickerRows = 5; // y 126..230
constexpr int16_t kPickerHintY = 274;

bool g_pickerActive = false;
size_t g_pickerSelection = 0, g_pickerTop = 0, g_pickerShown = 0, g_pickerCount = 0;
uint32_t g_pickerSerial = 0; // screenSerial() when the rows were last drawn: touch row hit-rects
char g_pickerLast[kPickerRows][kPickerLabelBytes] = {};

void resetPicker()
{
  g_pickerActive = false;
  g_pickerSelection = g_pickerTop = g_pickerShown = g_pickerCount = 0;
  memset(g_pickerLast, 0, sizeof(g_pickerLast));
}

void pickerRow(const char* label, size_t row, bool selected)
{
  const int16_t y = kPickerFirstY + static_cast<int16_t>(row) * kPickerRowH;
  int16_t w = chordWidth(y + 11);
  if (w > 300) { w = 300; }
  const int16_t x = kRuiCenter - w / 2;
  fb().fillRect(kRuiCenter - 150, y - 13, 300, kPickerRowH, kRuiGround);
  dirty(kRuiCenter - 150, y - 13, 300, kPickerRowH);
  if (selected) { fb().fillRoundRect(x, y - 12, w, 24, 12, kRuiAccent); }
  textCentered(label, y, selected ? kRuiGround : kRuiText, detailFont(), w - 16);
}

void pickerHeader(const char* heading, size_t selection, size_t count)
{
  clearScreen();
  textCentered(heading, 80, kRuiAccent, titleFont());
  if (count > 1)
  {
    char pos[16];
    snprintf(pos, sizeof(pos), "%u/%u", static_cast<unsigned int>(selection + 1), static_cast<unsigned int>(count));
    textCentered(pos, 106, kRuiDim, smallFont());
  }
}

void copyLabel(size_t row, const char* label) { snprintf(g_pickerLast[row], kPickerLabelBytes, "%s", label); }
} // namespace

void drawPickerList(const PickerView& view, size_t selection)
{
  const size_t count = view.count < kMaxPickerEntries ? view.count : kMaxPickerEntries;
  if (count == 0)
  {
    pickerHeader(view.heading, 0, 0);
    textCentered(view.emptyText, kPickerFirstY, kRuiText, detailFont());
    resetPicker();
    g_pickerActive = true;
    g_pickerCount = 0;
    return;
  }
  const size_t top = pickerWindowTop(count, selection, kPickerRows);
  const size_t visible = kPickerRows < count - top ? kPickerRows : count - top;
  g_pickerShown = visible;
  const bool full = !g_pickerActive || top != g_pickerTop;
  if (full) { pickerHeader(view.heading, selection, count); }
  for (size_t i = 0; i < visible; ++i)
  {
    const size_t index = top + i;
    const bool changed = (index == selection) != (index == g_pickerSelection) || strncmp(g_pickerLast[i], view.labels[index], kPickerLabelBytes - 1) != 0;
    if (!full && !changed) { continue; }
    pickerRow(view.labels[index], i, index == selection);
    copyLabel(i, view.labels[index]);
  }
  if (!full && count > 1)
  {
    fb().fillRect(kRuiCenter - 40, 98, 80, 16, kRuiGround);
    dirty(kRuiCenter - 40, 98, 80, 16);
    char pos[16];
    snprintf(pos, sizeof(pos), "%u/%u", static_cast<unsigned int>(selection + 1), static_cast<unsigned int>(count));
    textCentered(pos, 106, kRuiDim, smallFont());
  }
  g_pickerActive = true;
  g_pickerSelection = selection;
  g_pickerTop = top;
  g_pickerCount = count;
  g_pickerSerial = screenSerial();
}

// The visible rows of the picker or Settings list on screen, for touch (false when none is current).
bool roundUiRows(RoundRows* out)
{
  if (!g_pickerActive || g_pickerCount == 0 || g_pickerSerial != screenSerial()) { return false; }
  out->x = kRuiCenter - 150;
  out->w = 300;
  out->firstTop = kPickerFirstY - 13;
  out->rowH = kPickerRowH;
  out->visible = static_cast<uint8_t>(g_pickerShown);
  out->top = static_cast<uint8_t>(g_pickerTop);
  out->selection = static_cast<uint8_t>(g_pickerSelection);
  return true;
}

// A tap on Bob opens the info view (the touch module's default does nothing).
void roundtouch::onBobTapped() { roundUiToggleInfo(millis()); }

void drawConversationList(const ListedConversation* entries, size_t count, size_t selection)
{
  const char* labels[kMaxListedConversations];
  const size_t shown = count < kMaxListedConversations ? count : kMaxListedConversations;
  for (size_t i = 0; i < shown; ++i) { labels[i] = entries[i].title; }
  drawPickerList(PickerView{"CONVERSATIONS", "No conversations", labels, shown}, selection);
}

void endConversationList() { resetPicker(); }

void drawConversationPickerHint(const char* message, uint32_t color)
{
  fb().fillRect(kRuiCenter - 130, kPickerHintY - 10, 260, 20, kRuiGround);
  dirty(kRuiCenter - 130, kPickerHintY - 10, 260, 20);
  textCentered(message, kPickerHintY, color == kColorRed || color == kColorYellow ? kRuiAccent : kRuiSky, smallFont());
}


// --- Ready screen and its timer line ---
namespace
{
bool g_timerDrawn = false;
uint32_t g_timerEvalAt = 0;
TimerBandView g_timerShown;

// The Ready screen's last line: the soonest running timer, else the talk hint.
// What the Ready screen was drawn with, kept for the info view (the Cardputer's details, one tap away).
struct ReadyInfo
{
  char device[48], title[kConversationTitleBytes], space[kSpaceNameBytes], server[24], ready[32];
  bool wifi, ws;
} g_ready;
bool g_demoHold = false; // `T ui`: the Ready screen's timer line must not repaint over a demo screen

// The Ready screen's one optional line: the soonest running timer.
void drawReadyLine(const TimerBandView& view)
{
  fb().fillRect(kRuiCenter - 112, kRuiCaptionY - 20, 224, 40, kRuiGround); // room for the text and its halo
  dirty(kRuiCenter - 112, kRuiCaptionY - 20, 224, 40);
  if (!view.visible)
  {
    textCentered(bobtok::kCaptionReady, kRuiCaptionY, kRuiText, detailFont()); // the demo's greeting when no timer runs
    return;
  }
  char text[64];
  snprintf(text, sizeof(text), "%s %s%s", view.label, view.clock, view.hours ? " hr" : "");
  if (view.more > 0) { snprintf(text + strlen(text), sizeof(text) - strlen(text), " +%u", static_cast<unsigned int>(view.more)); }
  textCentered(text, kRuiCaptionY, view.reached ? kRuiAccent : kRuiText, detailFont());
}

void copy(char* to, size_t n, const char* from) { snprintf(to, n, "%s", from != nullptr ? from : ""); }
} // namespace

void drawReadyScreen(const char* deviceName, const char* activeTitle, const char* spaceName, bool wifiConnected,
                     bool websocketConnected, const char* serverLabel, const char* readyTitle)
{
  copy(g_ready.device, sizeof(g_ready.device), deviceName);
  copy(g_ready.title, sizeof(g_ready.title), activeTitle);
  copy(g_ready.space, sizeof(g_ready.space), spaceName);
  copy(g_ready.server, sizeof(g_ready.server), serverLabel);
  copy(g_ready.ready, sizeof(g_ready.ready), readyTitle);
  g_ready.wifi = wifiConnected;
  g_ready.ws = websocketConnected;
  clearScreen();
  setServerOk(websocketConnected);
  showBob(UiMood::kIdle); // Bob is the hero; Ready shows no words
  ringLightSetMode(ringModeForMood(static_cast<uint8_t>(UiMood::kIdle), status().dnd), millis());
  TimerBandView none;
  drawReadyLine(none);
  g_timerDrawn = false;
}

void roundui::infoReset()
{
  g_infoOpen = false;
  g_replyDrawn = false; // a cleared screen holds no reply and no trouble caption
  g_troubleUntil = 0;
}

// The Ready screen was just drawn: Bob confused, the caption in the greeting's place (coral: kind, never alarming), then
// timersBandUpdate puts Ready back after kTroubleMs.
void roundUiTrouble(const char* caption, uint32_t nowMs)
{
  if (!bobVisible()) { return; }
  sceneBob(BobEmotion::kConfused);
  fb().fillRect(kRuiCenter - 112, kRuiCaptionY - 20, 224, 40, kRuiGround);
  dirty(kRuiCenter - 112, kRuiCaptionY - 20, 224, 40);
  textCentered(caption, kRuiCaptionY, bobtok::kCoral, detailFont());
  g_troubleUntil = nowMs + kTroubleMs;
  if (g_troubleUntil == 0) { g_troubleUntil = 1; }
  g_timerDrawn = true; // the timer line waits for the caption to go
}
void roundui::demoHold(bool on) { g_demoHold = on; }
void roundui::demoReplyPages(size_t pages) { g_demoPages = pages; }

bool roundui::infoOpen() { return g_infoOpen; }

// A tap on Bob: the details the Cardputer shows on its Ready screen. They stay until a tap or a swipe right closes them
// (the demo's info view; round_touch.cpp closes it through the state machine, which redraws the plain screen or the reply card).
void roundUiToggleInfo(uint32_t nowMs)
{
  (void)nowMs;
  if (g_infoOpen)
  {
    drawReadyScreen(g_ready.device, g_ready.title, g_ready.space, g_ready.wifi, g_ready.ws,
                    g_ready.server[0] != '\0' ? g_ready.server : nullptr, g_ready.ready);
    return;
  }
  clearCard();
  g_infoOpen = true;
  const StatusLineView& st = status();
  char line[64];
  textCentered(assistantDisplay(AssistantLabel::kName), 82, kRuiAccent, titleFont());
  snprintf(line, sizeof(line), "paired as %s", g_ready.device[0] != '\0' ? g_ready.device : "-");
  textCentered(line, 118, kRuiText, detailFont());
  textCentered(g_ready.title[0] != '\0' ? g_ready.title : "New conversation", 144, kRuiAccent, detailFont());
  snprintf(line, sizeof(line), "Space: %s", g_ready.space[0] != '\0' ? g_ready.space : "none");
  textCentered(line, 170, kRuiSky, detailFont());
  const char* mode = st.mode == DeviceMode::kPtt ? "Push to talk" : st.mode == DeviceMode::kAnnounceOnly ? "Announce only"
                     : st.wakeFallback ? "PTT (no wake)" : "Always awake";
  textCentered(mode, 202, kRuiText, detailFont());
  snprintf(line, sizeof(line), "%s  -  battery %d%%%s", st.muted ? "Muted" : (String("Volume ") + st.volume).c_str(),
           st.batteryPct < 0 ? 0 : st.batteryPct, st.charging == 1 ? "+" : "");
  textCentered(line, 228, kRuiText, detailFont());
  snprintf(line, sizeof(line), "WiFi %s  -  Server %s%s%s", g_ready.wifi ? "ok" : "down", g_ready.ws ? "ok" : "down",
           g_ready.server[0] != '\0' ? " " : "", g_ready.server);
  textCentered(line, 254, g_ready.wifi && g_ready.ws ? kRuiOk : kRuiAccent, detailFont());
}

// Called every loop pass from the chrome tick: timed screen details (the info view itself no longer closes by itself).
void roundui::infoTick(uint32_t nowMs) { (void)nowMs; }

void timersBandUpdate(const TimersModel& model, uint32_t nowMs)
{
  if (g_demoHold || g_infoOpen) { return; } // the timer line never paints over the info view
  if (g_troubleUntil != 0)
  {
    if (static_cast<int32_t>(nowMs - g_troubleUntil) < 0) { return; }
    g_troubleUntil = 0; // the trouble caption has had its time: Bob's own feeling and the Ready line come back
    sceneBobEnd();
    g_timerDrawn = false;
  }
  if (g_timerDrawn && nowMs - g_timerEvalAt < 100) { return; }
  g_timerEvalAt = nowMs;
  const TimerBandView view = timerBandView(model, nowMs);
  if (g_timerDrawn && view == g_timerShown) { return; }
  drawReadyLine(view);
  g_timerShown = view;
  g_timerDrawn = true;
}

void timersBandInvalidate() { g_timerDrawn = false; }

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
