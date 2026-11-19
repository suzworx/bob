# Cardputer vs an Alexa device: gap analysis

**Date:** 2026-09-23 · **Status:** owner-reviewed; tracked as epic #311 · **Baseline:** `main` at `1673f56`; status refreshed against `main` at `a69b7c4` (2026-09-24)

The goal is not to clone Alexa. It is "an Alexa-class voice device that is also a window into
what only Bob has": personal memory, tasks and agenda, Spaces shared with a household, and a
conversation that follows you between the web and the device. This document compares what the
Cardputer does today with the voice-device baseline people expect, then proposes where to spend
effort.

Evidence for every "today" claim was taken from the code on 2026-09-23 and refreshed on
2026-09-24; references cite symbols where they can.

## 1. Where we stand in one paragraph

The Cardputer is a **push-to-talk, request/response** terminal. Hold BtnA, speak, release; the
server runs speech-to-text → agent → text-to-speech in **batch**, then streams a 32 kbps MP3.
It remembers the conversation (last 40 messages, follow-me pointer shared with the web), can start
a new conversation (#328) and pick its active Space (#331, #332, #338), and a device turn gets
memory, task, agenda, timer, reminder, note, search and inbox tools. Since #377 the **server**
supports stopping a turn (`cancel` aborts it), announcements, the `device_control` channel
(volume, mute, mode, DND) and the account time zone. The **firmware** half (volume keys, stop,
reply card, announcement and ring cards, earcons, battery, Always awake wiring) is in open PR
#378, so on `main` the device still cannot be spoken to hands-free, interrupted or shown the
reply, has fixed volume, and its Wi-Fi is compiled into the firmware.

## 2. Capability matrix

Status: ✅ works · 🟡 partial · ❌ missing. Priority is for Bob, not a general ranking.

### 2.1 Voice interaction core

| Capability | Alexa | Bob Cardputer today | Gap | Priority |
| --- | --- | --- | --- | --- |
| Start a request | wake word, far-field | 🟡 PTT only on `main` (BtnA in `state.cpp`); wake-word module merged (#336, `wake_word.cpp`), wiring in PR #378 / #313 | no hands-free until #378 lands and #313 is proven on hardware | **P0 — owner decision 2026-09-23** (#312 done, #313; no PSRAM makes RAM the risk) |
| Time to first audio | ~1–2 s, streaming | 🟡 batch STT → full agent reply → full TTS → MP3 — `turn.ts`, `audio.ts` | user hears nothing until every stage finishes | **P0** (#317, not started) |
| Barge-in / stop | "Alexa, stop" | 🟡 server `cancel` aborts the in-flight turn (#377, `session.ts` `turnAbort`); firmware keys and BtnA in PR #378 | cannot cut off a reply until #378 lands | **P0** |
| Follow-up without re-trigger | follow-up mode | ❌ back to Ready, wait for BtnA | every turn needs a press | P2 (PTT makes this cheap already) |
| Earcons / listening cues | light ring + tones | ❌ on `main`; earcons in PR #378 | eyes-free use impossible | P1 |
| Volume | voice + buttons | 🟡 server `device_control` + `set_volume` tool (#377); firmware still fixed `kSpeakerVolume = 160` (`config.h`), keys in PR #378 | no fix on the device until #378 | **P0 — owner decision** (#314) |
| Language | many | 🟡 STT pinned to `en` — `BOB_STT_LANGUAGE` in `ai/src/config.ts` | | P3 |
| Reply on screen | Echo Show cards | 🟡 server sends `reply_text` (#377); reply card in PR #378 | a device *with a screen* hides the answer until #378 | **P1** |
| Max request length | long | 🟡 no firmware cap; server drops at `ACCUMULATE_MAX_BYTES` (1 MB ≈ 31 s of 16 kHz PCM16) | the stale "device-side PTT cap is 6 s" comment above `ACCUMULATE_MAX_BYTES` in `schemas.ts` | P3 (doc fix) |

### 2.2 Proactive and time-based

| Capability | Alexa | Bob today | Gap | Priority |
| --- | --- | --- | --- | --- |
| Timers | "set a 10 min timer" | 🟡 storage + `set_timer`/`list_timers`/`cancel_timer` tools (#334); wired into device turns with a restart-safe scheduler (`startTimerScheduler`, #377); device ringing in PR #378 | no ring on the device until #378 | **P0** |
| Alarms | yes | 🟡 `set_alarm` tool (#334, #377); ringing in PR #378 | | P1 |
| Reminders | spoken at due time | 🟡 `create_reminder`/`list_reminders`/`cancel_reminder` tools (#335); due reminders are also announced to the device (`reminder-fanout.ts`, #377) | spoken on the device only once #378 plays announcements | **P0** |
| Announcements / push | notifications chime | 🟡 server outbox and `announce` (`device-sessions.ts`, #377) alongside `active_conversation` / `active_space` (#332); announcement cards in PR #378 | | **P0** (enables timers, reminders, Spaces) |
| Do not disturb | yes | 🟡 server holds announcements for a DND device (#377, `device-settings.ts`); device and web controls in PRs #378 and #381 | | P2 |
| Time zone | device-local | ✅ device turns use the account zone (#316 via #377, `getAccountTimeZone` in `turn.ts`) | — | — |

### 2.3 Information and skills

| Capability | Alexa | Bob today | Priority |
| --- | --- | --- | --- |
| Date/time | ✅ | ✅ `currentDateTime` | — |
| Weather | ✅ | ❌ no tool | P1 |
| Web search / Q&A with fresh facts | ✅ | ❌ model knowledge only | P1 |
| Music / radio / podcasts | ✅ | ❌ (3 MB MP3 cap, no media transport) | P3 — not our lane |
| Smart home | ✅ | ❌ | P3 — not our lane yet |
| Shopping / lists | ✅ | 🟡 tasks on the active Space can stand in for lists | P2 |
| Calling / drop-in | ✅ | ❌ | out of scope |

### 2.4 Setup, reliability, device life

| Capability | Alexa | Bob today | Priority |
| --- | --- | --- | --- |
| Wi-Fi setup without a rebuild | app / BLE provisioning | ❌ `secrets.h` at compile time (#324, not started) | **P0** for anyone but the owner |
| Multiple saved networks | ✅ | ❌ one SSID (#324) | P1 |
| Pairing to account | app | ✅ code + web approve, token in NVS | — |
| OTA firmware updates | ✅ | ❌ version hard-coded | moved to epic #343 (decision PR #382) |
| Battery level / sleep | n/a (plugged) | ❌ on `main`; battery in the status line in PR #378; idle sleep open (#326) | P1 (the Cardputer *is* portable) |
| Offline feedback | "I'm having trouble…" | 🟡 screen shows "WS RECONNECT" only | P2 |
| Internet without Wi-Fi | — | ❌ #303 deferred by the owner (2026-09-23) | see decision record |
| Device settings on web | Alexa app | 🟡 Devices page picks the device's Space (#338); volume, mute, mode and DND in PR #381 (#327) | P1 |

## 3. What only Bob can do (lean into this)

| Bob ability | Today on the device | Gap to close |
| --- | --- | --- |
| Follow-me conversation (web ↔ device) | ✅ pick from 10 recent with `c`; start a fresh one from the keyboard (#302, #328) | — |
| Personal memory (`remember`, `forget`, actions) | ✅ first turn of a new conversation keeps its tools (#328), degrades to the base agent on a tool failure | — |
| Tasks and agenda by voice | ✅ act on the active Space (#329) | — |
| Spaces shared with a household | ✅ active Space on the device (#331, #332) and on the Devices page (#338) | Space announcements |
| Reminders that reach the right person | 🟡 voice tools (#335) + device announce fan-out (#377) | spoken on the device once #378 lands |
| Notes | ✅ `create_note` / `append_note` / `read_note` (#335, wired into device turns by #377) | — |
| Unified search (tasks, notes, events, threads) | ✅ `search` tool (#335); web route `createSearchRouter` in `web-search.ts` | — |
| "What did I miss?" catch-up | ✅ `read_inbox` tool (#335) | — |

## 4. Recommended roadmap

Ordered by user value per unit of effort. Each line is a candidate issue.

**Wave A — make the core feel like a voice device (P0)**; always-on wake word (#312, #313) and volume (#314) lead this wave by owner decision.
1. Stop / barge-in: a key (and BtnA during playback) sends `cancel`; server aborts the turn and
   the stream (server done, #377); firmware flushes the ring (PR #378).
2. Volume: `+`/`-` keys, persisted in NVS, shown on screen (PR #378); web setting (PR #381).
3. Streaming reply: agent `stream` + sentence-chunked TTS, so first audio arrives after the first
   sentence, not the whole answer. Biggest perceived-latency win (#317, not started).
4. Reply text on screen: a scrollable last-reply card (bounded, not logged) (server #377, firmware PR #378).

**Wave B — proactive device (P0/P1)**
5. Server→device announcement channel: a bounded `announce` message + pre-rendered audio,
   delivered outside a turn, held during capture/playback like `active_conversation` (server #377, firmware PR #378).
6. Timers and alarms: agent tools + scheduler (#334, #377); device ringing (PR #378, #320).
7. Reminder tool + reminders announced on the device (#335, #377; firmware PR #378).
8. Earcons: listening start/stop, error, announcement chime (PR #378).

**Wave C — Bob-only abilities on the device** — done
9. ✅ **#302** new conversation from the keyboard (#328).
10. ✅ **#301** active Space on the device, and voice tasks/agenda into that Space (#310, #329, #331, #332, #338).
11. ✅ Notes, unified search and "what did I miss" as agent tools (#335, wired by #377).

**Wave D — shippable to someone who is not the owner**
12. Wi-Fi provisioning without a rebuild (SoftAP captive portal or BLE), multiple networks (#324).
13. OTA updates with signed images and rollback: moved to epic #343 (decision PR #382).
14. Battery indicator (PR #378), idle sleep (#326), web device settings (PR #381).
15. Bluetooth internet: **deferred by the owner (2026-09-23)**; see the #303 decision record.

**Quality foundation:** host tests + shared wire fixtures + a memory budget (#333, #379); HIL
over USB + a merge gate for firmware (#340, #380, `docs/cardputer/hil.md`). The first real device
run of PR #378 passed 11/13 scenarios and found a `reply_text` parser bug on hardware.

## 5. Bugs and doc drift found during the inventory

- ~~Device turns with no active conversation ran with no memory or productivity tools~~ — fixed (#328).
- ~~The server's `cancel` reset fields but did not stop an in-flight turn~~ — fixed (#377).
- ~~Device turns dated in UTC~~ — fixed (#316 via #377).
- The comment above `ACCUMULATE_MAX_BYTES` in `schemas.ts` says the device PTT cap is 6 s;
  firmware has no cap (the server bound is 1 MB ≈ 31 s).
- Firmware ignores `credit_bytes` (no reference in `apps/cardputer/src` or `include`); uplink has
  no flow control (fine at 272 kbps on LAN, a prerequisite before any Bluetooth path).

## 6. Decisions from the owner

1. Streaming reply (#317) comes after stop (#315).
2. Timers are server-scheduled (#334), with the device ringing (#320).
3. Always-on wake word is required (#312, #313), decided 2026-09-23.
4. All of sections 4 A–D are sub-issues of epic #311.

## 7. Tracking

Epic **#311** sub-issues: wake word #312 (closed) / #313, volume #314, stop #315, device time zone
#316 (closed), streaming #317, reply text #318, announcements #319, timers #320, reminders #321,
earcons #322, notes/search/inbox tools #323, Wi-Fi setup #324, battery #326, web device settings
#327, listening modes #330, firmware tests #333 (closed), HIL #340 (closed), #301 (closed), #302
(closed), #53 and #303. OTA #325 moved to epic #343. #303 is deferred by the owner.
