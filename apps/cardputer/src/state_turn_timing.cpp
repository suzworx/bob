// Bob Cardputer v2 — the turn's timing record and its one summary (#1004).
// Main-loop only. One static record (~120 bytes) and a stack buffer at send
// time; nothing is queued for retry and nothing ever waits for the server.
// The journal line uses the same milestones and offsets as the wire message,
// so a serial capture and the exported span agree field for field.
#include "state_internal.h"
#include "control_queue.h"
#include "turn_timing.h"

namespace bob {
namespace fsm {

static_assert(kTurnTimingBytes == kControlMaxBytes, "the summary is bounded by the control queue's message limit");

static bool g_timingNegotiated = false;
static TurnTimingRecord g_timing;

void configureTurnTiming(const String& welcome) {
  // Re-read each connection: an older server never receives turn_timing.
  g_timingNegotiated = welcomeSupportsTurnTiming(welcome.c_str());
  g_timing = TurnTimingRecord();  // a turn from before a reconnect never reports.
}

void timingBegin(TimingSource source, uint32_t audioLeadMs) {
  g_timing.begin(source, millis(), audioLeadMs);
  g_timing.muted = settings().muted;
}

void timingMark(Milestone milestone) { g_timing.mark(milestone, millis()); }

void timingCaptureEnded(TimingEnd reason) {
  g_timing.setEnd(reason);
  timingMark(Milestone::kCaptureEnd);
}

void timingUplinkSent(uint32_t framesSent) {
  g_timing.upFrames = framesSent;
  if (framesSent > 0) timingMark(Milestone::kFirstUp);  // the first batch (marks once).
}

void timingCaptureStats(size_t backlog, uint32_t fps) {
  const TxBusyTracker& busy = network.txBusy();
  g_timing.setCaptureStats(vadHeardSpeech(), vadSpeechEndMs(), static_cast<uint32_t>(backlog), fps,
                           busy.count(), busy.maxMsIncludingOpen(millis()));
}

void timingPlaybackStarted() { g_timing.muted = g_timing.muted || settings().muted; }

void timingDrop() { g_timing.active = false; }

// One journal field per milestone: the offset, "skipped", or left out (unknown).
static String timingDetail(TimingOutcome outcome) {
  String detail = String("outcome=") + timingOutcomeName(outcome) +
                  ",source=" + timingSourceName(g_timing.source) +
                  ",end_reason=" + timingEndName(g_timing.endSet ? g_timing.end : TimingEnd::kError) +
                  ",muted=" + (g_timing.muted ? "1" : "0");
  for (size_t i = 0; i < kMilestoneCount; ++i) {
    uint32_t value = 0;
    bool isNull = false;
    const Milestone m = static_cast<Milestone>(i);
    if (g_timing.offset(m, &value, &isNull)) {
      detail += String(",") + milestoneKey(m) + "=" + value;
    } else if (isNull) {
      detail += String(",") + milestoneKey(m) + "=skipped";
    }
  }
  detail += String(",up_frames=") + g_timing.upFrames + ",down_frames=" + g_timing.downFrames;
  if (!g_timing.statsSet) return detail;
  detail += g_timing.speechHeard ? String(",speech_end_ms=") + g_timing.speechEndMs : String(",speech_end_ms=skipped");
  return detail + ",uplink_backlog=" + g_timing.uplinkBacklog + ",mic_fps=" + g_timing.micFps +
         ",tx_busy=" + g_timing.txBusy + ",tx_busy_max_ms=" + g_timing.txBusyMaxMs;
}

void timingFinish(TimingFinish how) {
  if (!g_timing.active) return;
  const PlaybackStamps& stamps = playback.stamps();
  // Muted at any of capture start, playback_start or now. DND silences only
  // earcons and announcements, never a reply, so it is not recorded.
  g_timing.muted = g_timing.muted || settings().muted;
  g_timing.close(stamps);
  const TimingOutcome outcome = how == TimingFinish::kCancelled
                                    ? TimingOutcome::kCancelled
                                    : timingOutcome(how == TimingFinish::kStopped,
                                                    how == TimingFinish::kFailed, stamps);
  journalEvent("turn_timing", timingDetail(outcome));
  if (!g_timingNegotiated || !welcomed) return;
  char body[kTurnTimingBytes];
  const size_t length = encodeTurnTiming(body, sizeof(body), turnRef.c_str(), g_timing, outcome, millis());
  if (length > 0) network.sendControl(String(body));
}

}  // namespace fsm
}  // namespace bob
