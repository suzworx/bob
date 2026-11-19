// Bob Cardputer v2 — HELP, reply and announcement cards.
#include "cards.h"

#include <M5Cardputer.h>
#include <cstring>
#include "build_id.h"
#include "chrome.h"
#include "config.h"
#include "display.h"

namespace bob {

namespace {

constexpr int16_t kScreenWidth = 240;
constexpr int16_t kCardTop = kStatusLineHeight;
constexpr int16_t kCardHeight = kStripY - kStatusLineHeight;
constexpr int16_t kFirstLineY = kCardTop + 3;
constexpr int16_t kLineHeight = 12;
constexpr int16_t kLeft = 6;
constexpr size_t kCardColumns = 37;  // (240 - 6 left - 12 for the scrollbar) / 6.
constexpr size_t kMaxReplyLines = 48;
constexpr uint32_t kColorDim = 0x505050;

// One wrapped line: `length` chars of a source text starting at `start`.
enum class LineKind : uint8_t { kHeadingYou, kHeard, kBlank, kHeadingBob, kReply };
struct Span {
  uint16_t start;
  uint8_t length;
  LineKind kind;
};

Span g_replyLines[kMaxReplyLines];
size_t g_replyLineCount = 0;

// Word-wraps `text` into at most `max` spans of `columns`, breaking at the
// last space that fits (or mid-word when a word is longer than a line).
size_t wrapText(const char* text, size_t columns, LineKind kind, Span* out, size_t max) {
  const size_t length = strlen(text);
  size_t pos = 0;
  size_t count = 0;
  while (count < max) {
    while (pos < length && text[pos] == ' ') ++pos;
    if (pos >= length) break;
    size_t take = length - pos;
    if (take > columns) {
      take = columns;
      size_t space = take;
      while (space > 0 && text[pos + space] != ' ') --space;
      if (space > 0) take = space;
    }
    out[count++] = Span{static_cast<uint16_t>(pos), static_cast<uint8_t>(take), kind};
    pos += take;
  }
  return count;
}

void clearCard() {
  M5Cardputer.Display.fillRect(0, kCardTop, kScreenWidth, kCardHeight, kColorBlack);
  M5Cardputer.Display.setTextSize(1);
}

int16_t lineY(size_t row) { return kFirstLineY + static_cast<int16_t>(row) * kLineHeight; }

// Thin scrollbar at the right edge, only when the content overflows.
void drawScrollbar(size_t firstLine, size_t total) {
  if (total <= kCardVisibleLines) return;
  const int16_t trackY = kFirstLineY;
  const int16_t trackH = static_cast<int16_t>(kCardVisibleLines) * kLineHeight - 4;
  const int16_t thumbH = static_cast<int16_t>(trackH * kCardVisibleLines / total);
  const int16_t thumbY =
      trackY + static_cast<int16_t>((trackH - thumbH) * firstLine / (total - kCardVisibleLines));
  M5Cardputer.Display.fillRect(kScreenWidth - 4, trackY, 2, trackH, kColorDim);
  M5Cardputer.Display.fillRect(kScreenWidth - 4, thumbY, 2, thumbH, kColorWhite);
}

void printSpan(const char* text, const Span& span) {
  M5Cardputer.Display.printf("%.*s", static_cast<int>(span.length), text + span.start);
}

// HELP content: a null key is a section heading.
struct HelpLine {
  const char* key;
  const char* action;
};
constexpr char kAwakeKey[] = "Awake";
constexpr char kAwakeOff[] = "Off. k turns it on";
constexpr char kBuildKey[] = "fw";
constexpr HelpLine kHelpLines[] = {
    {nullptr, "Ready"},
    {"GO", "Hold to talk, let go to send"},
    {kAwakeKey, nullptr},  // "Say <phrase> to talk" while on, else kAwakeOff.
    {"- =", "Volume down / up"},
    {"m", "Mute or unmute"},
    {"k", "Change listening mode"},
    {"w", "Switch the wake word"},
    {"c", "Pick a conversation"},
    {"n", "Start a new chat"},
    {"s", "Pick a space"},
    {"h ?", "Show this help"},
    {",", "Settings: Wi-Fi, About"},
    {nullptr, "While Bob replies"},
    {"x GO", "Stop the reply"},
    {"- = m", "Volume and mute"},
    {nullptr, "Reply card"},
    {"; .", "Scroll"},
    {"Any key", "Close"},
    {nullptr, "Announcements"},
    {"Any key", "Dismiss, stop ringing"},
    {nullptr, "Lists"},
    {"; .", "Move up / down"},
    {"Enter", "Select"},
    {"`", "Back"},
    {nullptr, "This help"},
    {"; .", "Scroll"},
    {"` GO", "Back"},
    {kBuildKey, ""},  // "fw <version> build <id>", dim: what is flashed.
};
constexpr size_t kHelpLineCount = sizeof(kHelpLines) / sizeof(kHelpLines[0]);

}  // namespace

size_t helpLineCount() { return kHelpLineCount; }

void drawHelp(size_t firstLine, const char* wakePhrase) {
  clearCard();
  auto& d = M5Cardputer.Display;
  for (size_t row = 0; row < kCardVisibleLines && firstLine + row < kHelpLineCount; ++row) {
    const HelpLine& line = kHelpLines[firstLine + row];
    if (line.key == nullptr) {
      d.setTextColor(kColorCyan);
      d.setCursor(kLeft, lineY(row));
      d.print(line.action);
      continue;
    }
    if (line.key == kBuildKey) {
      d.setTextColor(0x808080);
      d.setCursor(kLeft, lineY(row));
      d.printf("Firmware %s", kFirmwareNumericVersion);
      continue;
    }
    d.setTextColor(kColorYellow);
    d.setCursor(kLeft + 6, lineY(row));
    d.print(line.key);
    d.setTextColor(kColorWhite);
    d.setCursor(kLeft + 54, lineY(row));
    if (line.key != kAwakeKey) {
      d.print(line.action);
    } else if (wakePhrase == nullptr) {
      d.print(kAwakeOff);
    } else {
      d.printf("Say %s to talk", wakePhrase);
    }
  }
  drawScrollbar(firstLine, kHelpLineCount);
}

size_t layoutReplyCard(const ReplyText& reply) {
  size_t n = 0;
  if (reply.heard[0] != '\0') {
    g_replyLines[n++] = Span{0, 0, LineKind::kHeadingYou};
    n += wrapText(reply.heard, kCardColumns, LineKind::kHeard, g_replyLines + n,
                  kMaxReplyLines - n);
  }
  if (reply.reply[0] != '\0' && n + 2 < kMaxReplyLines) {
    if (n > 0) g_replyLines[n++] = Span{0, 0, LineKind::kBlank};
    g_replyLines[n++] = Span{0, 0, LineKind::kHeadingBob};
    n += wrapText(reply.reply, kCardColumns, LineKind::kReply, g_replyLines + n,
                  kMaxReplyLines - n);
  }
  g_replyLineCount = n;
  return n;
}

void drawReplyCard(const ReplyText& reply, size_t firstLine) {
  clearCard();
  auto& d = M5Cardputer.Display;
  for (size_t row = 0; row < kCardVisibleLines && firstLine + row < g_replyLineCount; ++row) {
    const Span& span = g_replyLines[firstLine + row];
    d.setCursor(kLeft, lineY(row));
    switch (span.kind) {
      case LineKind::kHeadingYou:
        d.setTextColor(kColorCyan);
        d.print("You said");
        break;
      case LineKind::kHeard:
        d.setTextColor(0xb0b0b0);
        printSpan(reply.heard, span);
        break;
      case LineKind::kBlank:
        break;
      case LineKind::kHeadingBob:
        d.setTextColor(kColorGreen);
        d.print("Bob");
        break;
      case LineKind::kReply:
        d.setTextColor(kColorWhite);
        printSpan(reply.reply, span);
        break;
    }
  }
  drawScrollbar(firstLine, g_replyLineCount);
}

void drawAnnouncementCard(const Announcement& announcement, bool ringing, bool missed) {
  constexpr size_t kBodyLines = 5;
  constexpr size_t kTitleBigChars = 19;  // 228 px / 12 px per char at size 2.
  clearCard();
  auto& d = M5Cardputer.Display;
  const char* label = "Notice";
  switch (announcement.kind) {
    case AnnounceKind::kTimer: label = missed ? "Missed timer" : "Timer"; break;
    case AnnounceKind::kAlarm: label = missed ? "Missed alarm" : "Alarm"; break;
    case AnnounceKind::kReminder: label = missed ? "Missed reminder" : "Reminder"; break;
    case AnnounceKind::kNotice: label = missed ? "Missed notice" : "Notice"; break;
  }
  d.setTextColor(ringing || missed ? kColorRed : kColorYellow);
  d.setCursor(kLeft, lineY(0));
  d.print(label);
  if (ringing) {
    d.setCursor(kScreenWidth - kLeft - 7 * 6, lineY(0));
    d.print("Ringing");
  }
  d.setTextSize(strlen(announcement.title) <= kTitleBigChars ? 2 : 1);
  d.setTextColor(kColorWhite);
  d.setCursor(kLeft, lineY(1) + 2);
  d.print(announcement.title);
  d.setTextSize(1);
  Span lines[kBodyLines];
  const size_t count =
      wrapText(announcement.body, kCardColumns, LineKind::kReply, lines, kBodyLines);
  d.setTextColor(0xb0b0b0);
  for (size_t i = 0; i < count; ++i) {
    d.setCursor(kLeft, lineY(3 + i));
    printSpan(announcement.body, lines[i]);
  }
}

}  // namespace bob
