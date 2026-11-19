# Cabin sound family

The source recipe is `apps/cardputer/scripts/earcons_wave.py`. PlatformIO and the
host runner generate immutable unsigned 8-bit, 4 kHz PCM into ignored build
folders; no recording, generated audio asset or private wake weight is committed.
The browser proof is `docs/cardputer/device-ux-prototype.html`. For this task the
user's exact proof file is D:/pc-worx/Bob/docs/cardputer/device-ux-prototype.html.
Its 16 procedural buttons must stay sample-identical to the source recipe.

The analytical reference is [Shamrock 132's CC 0 Airbus A 320 interphone recording](https://freesound.org/people/Shamrock 132/sounds/245851/): dominant notes near 587 and 494 Hz,
about 1.05 seconds apart. This is an original synthesis inspired by those measured
properties, not the recording. Each note has 8 ms smooth attack, an exponential
decay capped at 270 ms, and an 80 ms fade at the end. Short notes scale their decay.

| Event | Motif |
| --- | --- |
| Microphone ready | 587 Hz,130 ms |
| Turn sent | 494 then 587 Hz,300 ms total |
| Follow-up expires without speech | 440 Hz,180 ms |
| Volume/unmute preview | 659 Hz,65 ms |
| Error | 392 Hz,400 ms |
| Connection lost after welcome | 392 then 330 Hz,540 ms |
| Reminder without ring | 587 then 494 Hz,2100 ms |
| Notice without ring | 494 Hz,480 ms |
| Timer without ring | 587 then 494 Hz,550 ms |
| Alarm without ring | 494 then 659 Hz,550 ms |
| Classic timer/alarm | 587-494-587 /494-587-494;5200 ms period |
| Chime timer/alarm | 659-494 /494-659;4800 ms period |
| Pulse timer/alarm | 587 /494;3000 ms period |

Ring notes last 1050 ms. Existing ring length, dismiss, snooze, volume, mute and DND
semantics remain. No startup or keypress sounds were added. Interaction cues
still yield to the microphone, held replies and other playing audio. Announcement
MP 3 may wait for its cue in the decoder task while incoming frames fill the
existing 48 KB ring; cancellation,24 KB pressure or 2200 ms ends that wait. Normal
replies and PCM playback keep immediate priority. Late ring ticks replace the
channel instead of filling its two-slot queue and blocking the main loop.

## Verification lessons

Audit every generated-sound call site, including repeating rings and follow-up
expiry, before describing a change as covering all device sounds. Include both
ringing and non-ringing announcement kinds. Speech/content audio and the explicit
measurement-only tone-test build are separate from product cues.

An exact flashed image hash proves installation, not physical audibility or a
user's subjective acceptance. Host waveform tests, browser previews, HIL and a
real-speaker audition are different evidence. Preserve private model support and
current NVS when flashing; a public image does not contain the private Bob model.
