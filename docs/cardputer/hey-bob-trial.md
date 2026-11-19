# Hey Bob controlled trial preparation

Status: **private, user-authorized device trial; wider qualification incomplete**. Upstream
TaterTotterson/Tater-Wake-Words revision
`5400697e1fb3fc454ac18f6a9d3f714f663f2842` has no explicit reuse licence.
The user explicitly authorized private testing and device flashing after the
licensing limitation was reported. Weights are held only in git-ignored
`data/wake-test/hey_bob.tflite`; they are not vendored, committed or distributed.
This authorization does not establish upstream reuse permission or commercial
clearance. Do not redistribute weights or contact the author as part of this task.
The trained phrase is **Hey Bob**, not bare Bob. Keep Alexa available.

The candidate manifest says microWakeWord v2, probability cutoff 0.97, sliding
window 5, feature step 10 ms and tensor arena 30,000 bytes. Firmware currently
reserves 28,672 bytes; this document does not increase it. A manifest is not an
allocator measurement or proof of frontend compatibility. Do not tune the cutoff
or window to improve the first comparison.

Static inspection found an INT8 `[1,2,40]` input: two 10 ms slices imply a
20 ms invocation interval. The 63,520-byte candidate has SHA-256
`b991a4f729028b916f3a5fc6e4a3e2c47b68e7240b64608e10f39067ba1121b1`.
The firmware preserves the previous approximately 1,020 ms settling/cooldown:
51 invocations at Bob's 20 ms interval, rather than 34 (680 ms). Alexa retains
34 at 30 ms. Neither static analysis nor this checksum grants reuse.

The optional `m5stack-cardputer-bob` environment defines
`BOB_WAKE_MODEL_BOB=1` and embeds the ignored local artifact; the corresponding
`m5stack-cardputer-bob-hil` adds the test console. Standard builds retain their
existing default and backup. The private build now embeds Alexa, Hey Bob and
Hey Bob together. Open Settings (`,`), select **Wake word**, then choose the exact
phrase; the choice persists across reboot. `w` toggles Hey Bob / Hey Bob in the
private build; Alexa remains available in Settings for rollback. Only one model
runs in the unchanged arena. The selected word listens in Always awake mode (`k`). Build privately
from `apps/cardputer` with:

```powershell
py -3.11 -m platformio run -e m5stack-cardputer-bob
py -3.11 -m platformio run -e m5stack-cardputer-bob-hil
```

The historical measurements below describe the earlier two-model trial; they
do not establish acoustic quality or timing for the combined firmware. Weights
remain private and ignored. No model reliability claim follows from selection
and persistence checks.

## Automated checks without hardware

From the repository root:

```powershell
npx vitest run apps/cardputer/scripts/wake-compare.test.mjs
node scripts/hil/run.mjs --dry-run --scenario wake-mode,wake-capture-rate,wake-followup,wake-followup-key,turn-error-recovers-wake,heap-per-mode
npm run device:compile
npm run validate
```

The comparison tests contain synthetic numeric observations, **not synthetic
audio, detections or performance results**. HIL dry-run validates the scenario
plan only. Firmware compilation cannot prove model allocation, sound detection,
NVS persistence or microphone performance. `T wake fire` bypasses detection;
HIL scenarios using it prove state transitions only. Existing
`wake-detect-speaker` expects Alexa and Hey Bob recordings, not Hey Bob, and
must not be reported as a Hey Bob acoustic test.

## Hardware procedure (flashing authorized for this private trial)

1. Reserve the shared Cardputer/COM3 and check who owns port 7444. Use
   `Get-NetTCPConnection -LocalPort 7444 -ErrorAction SilentlyContinue` and
   `py -3.11 -m serial.tools.list_ports`; listing ports does not establish that
   COM3 is unclaimed, so confirm the serial driver's owner. Do not stop another
   session's process without its owner's OK. Use local Supabase and a local
   test API, never production, for trial turns. Record firmware revision, build
   flags, model source/hash, device identity and audio setup in a local trial log.
2. Confirm COM3 ownership and the scope of the existing flash approval, then flash the
   reviewed build and capture serial telemetry using raw PlatformIO commands
   from `apps/cardputer`:

   ```powershell
   py -3.11 -m platformio run -e m5stack-cardputer-bob-hil --target upload --upload-port COM3
   py -3.11 -m platformio device monitor --port COM3 --baud 115200
   ```

   Avoid the npm flash/monitor wrappers here: their serial-port cleanup can
   terminate another session's port holder. Close the monitor before a HIL
   runner opens COM3. Run HIL commands from the repository root.
   The standard HIL runner may flash both at entry and restoration; even
   `--no-flash` alone can flash at exit. To reuse an already installed HIL build
   without either flash, use the following **only after verifying that build**:

   ```powershell
   node scripts/hil/run.mjs --no-flash --keep-hil --scenario wake-mode,wake-capture-rate,wake-followup,wake-followup-key,turn-error-recovers-wake,heap-per-mode
   ```

3. Enter Always awake with `k`; press `w` through every compiled choice. Verify
   the displayed name and `wake_word_changed`/`wake_listening word=` agree.
   For each choice, power-cycle and check the same choice resumes. Hey Bob uses
   stable slot 2 for Bob, while slot 1 remains Hey Bob (Jarvis only in its
   dedicated comparison build). The earlier private trial reused slot 1 for Bob;
   upgrading that trial now selects the actual Hey Bob for that stored byte.
   Standard builds fall back to Alexa for Bob slot 2. Explicitly select Alexa
   in Settings before rollback. Do not erase NVS to manufacture a persistence pass.
4. For each model, wait for `wake_listening`, allow at least two seconds for
   frontend settling, then speak its exact phrase. Confirm one wake transition,
   speech capture, a complete normal reply and listening again after the
   follow-up window closes. Test cancellation, a failed turn and reconnect.
   Repeat the phrase immediately after entry and after returning to listening
   to probe the settling/cooldown gate (Bob 51 invocations; Alexa 34). Record both
   observations; injected wakes do not exercise that gate. The nominal duration
   is 1,020 ms, while actual elapsed time also depends on capture/inference timing.
5. Collect `wake_listening arena_used,held,free,largest`, `wake_stats fps` and
   `wake_detected`/`wake_stopped max_invoke_us`. `held` includes allocations
   beyond the arena; `max_invoke_us` is a maximum, not a set of invocation
   samples and cannot yield an inference p50/p95. For percentile inference
   timing, explicitly instrument bounded per-invocation timing in a trial
   build or leave that metric null. Do not add prompts/audio to telemetry.
6. For this authorized private trial, measure the
   actual `MicroAllocator` with this pinned TFLM build: start with the unchanged
   arena, record allocation failure if present, then review a trial-only arena
   increase in aligned increments. For each approved candidate rerun
   AllocateTensors, sustained inference and repeated wake/voice/playback cycles.
   Record successful `arena_used_bytes()` and allocated capacity separately;
   use bounded binary search between known failing/successful capacities if
   the minimum is needed. 30,000 bytes is only a search starting hint.
7. Keep static RAM at or below 65,536 bytes and flash at or below 1,740,800 bytes
   unless a separately justified budget change is approved. Measure minimum
   free internal heap, largest free block, stack watermarks and failures during
   at least 100 wake/turn/reconnect cycles for both builds. Do not call an arena
   increase safe just because it compiles: require no allocation failures,
   no downward heap trend, enough contiguous heap for the existing runtime
   allocations in memory-budget.json, no watchdog resets or microphone frame
   loss, and inference maximum below the measured model invocation interval
   (input stride times 10 ms). Capture baseline and candidate numbers. Restore
   the shared development API when finished.

## Matched audio protocol and reporting

Use the **same Cardputer microphone**, orientation, recording/playback path and
fixed measured playback gain for each pair. Mark distances 0.5, 1 and 3 metres.
Record ambient/background level and geometry; counterbalance model order and
repeat under quiet, ordinary conversation, TV and music backgrounds. Include
normal and quiet speech. Recruitment and acceptance must follow the design-partner
coverage gate below; one pooled Indian-English group and one "other" group do not
satisfy it. These are planned counts, not results. Never substitute synthetic
voices silently; report them in separate strata.

For negatives, use the identical recordings for each model and include ordinary
conversation, TV/music and confusables such as “hey Rob”, “hey job”, “hey babe”,
“Bob”, “Alexa” and “Hey Bob” (the other model's phrase is negative for this model).
Exclude that model's intended phrase from its negative denominator. Target at
least one hour per background per model; rare false activations require much
longer exposure. Count only time when wake inference is active, excluding turns,
follow-up windows, disconnected periods and cooldown/settling. Report coverage
and skipped cells; zero activations in short exposure is not a reliability claim.

Synchronize audio phrase-end annotations and `wake_detected` timestamps to one
monotonic timebase (measure serial timing uncertainty). Success is the first
detection in the interval from phrase start through phrase end plus two seconds.
Latency is that detection time minus phrase end, and may be negative. Validate
the phrase-start lower bound against the sidecar annotations before reporting;
the compact reporter has no phrase duration and cannot check that lower bound.
Do not clip negative latency to zero. Count no detection in the interval as a
miss. Record repeated
activations separately. Do not infer a miss from absent/incomplete telemetry.

Store consented audio and annotations under git-ignored `data/wake-test/`.
Keep a local sidecar manifest with recording SHA-256, consent/synthetic source,
trial ID, model hash, repetitions, microphone/gain, distance, noise and phrase
timings. Never commit audio or speaker personal information. The compact
reporter consumes a JSON **array of annotated observations**, not WAV files:

```json
[
  {"model":"Alexa","condition":"quiet/1m/normal","speaker":"synthetic-demo","provenance":"synthetic","kind":"positive","durationMs":2000,"detected":false,"latencyMs":null},
  {"model":"Alexa","condition":"quiet/1m/normal","speaker":"synthetic-demo","provenance":"synthetic","kind":"negative","durationMs":3600000,"falseActivations":0}
]
```

This example is invented input syntax only, not trial evidence. Allowed optional
measurements are `inferenceUs`, `arenaUsedBytes` and `heapFreeBytes` (nonnegative
numbers or null). At most one inference timing field per observation is one
actual timed invocation, not the maximum from an interval. Keep additional
invocation samples in a separate sidecar analysis; duplicating observation rows
would inflate trial counts and exposure. Positive `durationMs` is the
two-second post-phrase response window;
negative `durationMs` is observed active listening exposure. `latencyMs` is null
when no synchronized timing is available. Use `provenance: "consented"` for
consented human recordings. The reporter keeps every model/condition/speaker/
provenance combination separate, rejects malformed rows, and returns null for
unmeasured metrics. Percentiles use nearest rank and include their sample count.

```powershell
node apps/cardputer/scripts/wake-compare.mjs data/wake-test/observations.json > data/wake-test/comparison.json
```

Present positive counts, misses/rate, negative hours, false activations/hour,
latency sample counts/mean/p50/p95/max, separately sampled inference timing and
memory with sample counts. Summarize recorded per-session inference maxima
separately. Include model/build hashes, planned versus completed cells and timing
uncertainty. Allocation, session-maximum timing and a limited synthetic acoustic
screen were measured below. The synthetic unit tests are solely reporter
verification and are separate from actual synthetic audio played to the device.

## Rollback

Select Alexa in Settings > Wake word and confirm persistence after reboot. Remove the optional
Hey Bob build flag and rebuild the standard firmware; stay within the approved
device flash scope. Retain the existing Alexa weights and 28,672-byte arena.
If initialization fails, the current firmware falls back to push-to-talk rather
than silently choosing another model; explicitly select Alexa to restore wake
operation. No production deployment, push or merge belongs to this trial.

## Local verification 2026-10-10

| Check | Observed result |
| --- | --- |
| `npm run device:compile` | Exit 0; static RAM 64,000 bytes, flash 1,623,045 bytes; arena unchanged at 28,672 bytes. Existing models only; this is not a Hey Bob build. |
| `npm run firmware:budget` | Exit 0; RAM and flash below limits. Flash growth warning of 45,832 bytes is relative to the historical baseline, **not this change's delta**. |
| Firmware host tests | 367 cases, 405,300 assertions, including two expected failures. No physical device involved. |
| Reporter Vitest tests | Four passed. Initial `node:test` discovery incompatibility with the repository's Vitest gate was fixed and explicitly rechecked. |
| Scoped HIL dry-run | Seven valid scenarios; no hardware execution. |
| Full `npm run validate` | **Completed FAIL, exit 1 after 18 steps.** AI/scripts/API checks failed: three existing telemetry Windows-path failures, one existing obs-local Windows-path failure and three existing supabase-report-sql CRLF failures. Firmware compile, host tests and budget passed. Log: `data/hey-bob-validate.log`. No final validation pass claimed. |
| Scripts recheck after Vitest correction | Exit 1 with only the existing obs-local failure: 54 test files passed, one failed; 861 tests passed, one failed. Log: `data/hey-bob-scripts-recheck.log`. |
| Private Bob product build | PASS; RAM 64,008 bytes, flash 1,624,933 bytes. Log: `data/hey-bob-product-build.log`. |
| Private Bob HIL build | PASS; RAM 64,104 bytes, flash 1,633,673 bytes. Log: `data/hey-bob-private-build.log`. |
| Physical selection/allocation/persistence | PASS in `data/wake-test/bob-private-1791662359101/results.json`: `w` selected Bob, Bob loaded after reboot, `w` returned to Alexa; cleanup restored Alexa/PTT. Reboot Wi-Fi recovery took approximately 108 seconds. |
| Acoustic screen | Completed, exit 0; 10/10 positives per model, one Bob activation in the confusable negative clip. See detailed limits below. |
| Bob state-transition HIL scenarios | Six of seven passed. `turn-error-recovers-wake` failed its step-24 loop bound: `loop_max=1342` ms against the existing <300 ms requirement. Evidence: `data/wake-test/bob-private-1791663012535/results.json`. This failure remains part of the record; injected wakes do not establish acoustic accuracy. |
| Isolated error-path comparison | Existing `turn-error-recovers-wake` assertions passed once with Alexa and once with Bob in `data/wake-test/bob-private-1791663116486/results.json`. The earlier failure is intermittent, not erased by this rerun. |
| Active profile restoration | PASS: original PROD/TLS profile restored, tokens preserved, in `data/wake-test/restore-profile-1791663159485/results.json`. The changed DEV endpoint remains test-local. |
| Final non-console Bob device flash | SUCCESS, exit 0; environment `m5stack-cardputer-bob`, without HIL console. Flash verification in `data/hey-bob-final-flash.log`; firmware binary SHA-256 `3bee456b5ac5caac8a8044343ff0087b0e7f7d8016439e29030377a859c62513`. Alexa/PTT saved and original PROD/TLS profile verified before flashing; local test server cleaned up. |

### Physical allocator observations

Two listening sessions per model, before/after reboot or selection. Capacity stayed
28,672 bytes. These are allocator-reported usage observations, not a minimum
capacity binary search or a long-duration heap stability test.

| Metric | Alexa | Hey Bob |
| --- | --- | --- |
| Arena used, bytes (2 observations) | 17,352; 17,344 | 24,248; 24,240 |
| Free heap readback, bytes (2 observations) | 190,428; 190,280 | 190,420; 190,284 |
| Largest free block readback, bytes | 176,116; 180,212 | 180,212; 180,212 |
| Capture FPS windows (2 observations) | 99; 99 | 100; 100 |
| Inference session maxima, microseconds (2 sessions) | 16,896; 18,264 | 18,193; 19,177 |

This allocation-only run's largest Bob invocation was 19.177 ms against its
nominal 20 ms interval. The later acoustic run exceeded that interval (below),
so real-time safety is not established. No invocation p50/p95 or synchronized
phrase-end latency was collected. The arena's largest observed Bob usage leaves
4,424 bytes inside the unchanged capacity; heap/stack endurance remains untested.

Raw evidence is in the run's `serial.log` and `results.json`. `held` fluctuates
with surrounding allocations and is not the tensor arena size. The trial changed
the DEV endpoint to this PC's local test server; its previous value was not
readable through the console and was not restored. Production endpoint and tokens
were not edited. The original active PROD/TLS profile was restored afterward;
this is restoration of device configuration, not a production service deployment.

### Limited physical acoustic screen

Evidence: `data/wake-test/bob-private-1791662526241/results.json` and its serial
log. One Microsoft David Desktop SAPI voice (`en-US`), one synthetic file per
phrase played ten times through the PC speaker to the same Cardputer. These
are repeated plays, **not ten distinct speakers or ten independent utterances**.
Speaker gain, distance, room noise and placement were not measured. This is not
the matched multi-speaker qualification protocol above.

| Observation | Alexa | Hey Bob |
| --- | --- | --- |
| Positive plays / detected / misses | 10 / 10 / 0 | 10 / 10 / 0 |
| Stub voice replies completed (`mp3_exit=eof`) and returned to wake listening | 10 / 10 | 10 / 10 |
| Confusable negative clip activations | 0 | 1 |
| Negative observation wall time | 25,213 ms | 25,137 ms |
| Active negative listening exposure / false activations per hour | Unmeasured / null | Unmeasured / null |
| Phrase-end detection latency | Unmeasured / null | Unmeasured / null |
| Maximum of ten positive-session inference maxima | 18,155 microseconds | 21,566 microseconds |
| Free heap during ten pre-play readbacks | 180,476–190,296 bytes | 182,260–182,296 bytes |
| Largest free block during ten pre-play readbacks | 159,732–180,212 bytes | 159,732 bytes |

The lowest cumulative heap watermark seen during the run was 121,976 bytes;
this is a run-wide watermark, not an isolated per-model minimum. Inference
numbers are maxima, not per-invocation percentiles. Bob's 21.566 ms invocation
exceeded its nominal 20 ms interval, requiring investigation under sustained
capture/load. The negative clip contained ordinary sentences and confusables
including “Hey Rob”, “Bob” and “Hey babe”; its Bob activation needs reproduction
and phrase attribution. No false-activation rate is inferred from wall time.

All twenty positive trials completed the local stub voice-turn path and returned
to listening. This does not validate real provider STT/agent/TTS quality. Indian-
English speakers, other human speakers, quiet speech, measured distances,
TV/music and long negative exposure remain untested. Cooldown arithmetic is
host-tested, but timed early/repeated acoustic cooldown probes remain untested.

Recommendation: **controlled private trials only**, with false-positive and
inference-deadline investigation before everyday use or any release. Licensing
remains unresolved for distribution, and the full repository validation gate
has not passed.

The seven-scenario Bob state run passed PTT turns, wake-mode entry, capture rate,
follow-up, follow-up cancellation by key, and heap floors. Its error-recovery
scenario's 1,342 ms loop stall failed the unchanged bound. An isolated repeat
passed for both Alexa and Bob. Initial triage points to synthetic tone injection
while wake inference is active rather than error rearming (error-to-listening was
283 ms), but that is a hypothesis requiring reproduction. Do not label the
intermittent failure fixed or claim release readiness from the passing repeats.

### Matched Hey Bob versus Hey Bob speaker screen, 2026-10-10

A fresh comparison played each trained phrase ten times through the same Windows
playback route to the same Cardputer microphone. Both files use Microsoft David
Desktop SAPI, en-US, rate 0, synthesis volume 100, PCM16 mono at 16 kHz. The
playback endpoint was the DELL S2725QC monitor. Acoustic gain, distance, room noise
and placement were not measured. Bob ran first, followed by Bob; model order was
not counterbalanced. Each phrase was one file replayed ten times, not ten speakers
or independently spoken utterances. No Indian-English or human speaker was tested.

| Measurement/configuration | Hey Bob | Hey Bob |
| --- | --- | --- |
| Actual detections / positive plays / misses | 10 / 10 / 0 | 10 / 10 / 0 |
| Complete local stub replies and return to listening | 10 / 10 | 10 / 10 |
| Confusable clip activations within playback window | 0 | 1 |
| Negative playback wall window | 32,695 ms | 32,681 ms |
| Observed arena usage (21 listening entries) | 21,948–21,960 bytes | 24,236–24,244 bytes |
| Arena capacity | 28,672 bytes | 28,672 bytes |
| Largest observed invocation | 19,349 microseconds | 21,336 microseconds |
| Nominal invocation interval | 30 ms | 20 ms |
| Positive-session inference maxima, range (10 sessions) | 17,583–19,349 microseconds | 17,956–21,336 microseconds |
| Pre-play free heap (10 readbacks) | 182,188–190,296 bytes | 182,264–190,332 bytes |
| Pre-play largest free block (10 readbacks) | 159,732–180,212 bytes | 172,020–180,212 bytes |
| Run-wide cumulative minimum heap | 122,400 bytes | 122,964 bytes |
| Manifest cutoff / actual uint8 cutoff | 0.988 / 251 | 0.97 / 247 |
| Sliding window | 5 | 5 |
| Input / output | INT8 [1,3,40] / UINT8 [1,1] | INT8 [1,2,40] / UINT8 [1,1] |
| Model file size | 62,304 bytes | 63,520 bytes |

Inference maxima were checked against all 21 `wake_stopped` entries in each
serial log, including the negative segment; their largest values matched the
positive-session maxima above. They are not invocation percentiles or detection
latency. Heap watermarks include the entire respective run, not inference alone.

Both models detected this synthetic voice reliably in the small sample. Bob
used about 2.3 KB less arena memory, stayed below its 30 ms invocation interval,
and had no activation in this negative playback window. Bob again exceeded its
20 ms interval and had one negative activation. This supports preferring Bob
for further trials under this setup; it does not establish superiority for human
speech, accents, distance or everyday noise. Bob's prior Alexa comparison remains
a separate historical run and is not substituted into this matched table.

The same `balanced_negative.wav` was used for both models. It contains ordinary
conversation and confusables including Hey Rob, Hey Ola, Hey Alex and Hey babe,
without either exact intended phrase. Negative counting ended when playback
returned, with no post-roll; late activations may be missed. Active listening
exposure was not measured and periods in a voice turn are not listening exposure,
so false activations/hour remain null. Phrase-end latency also remains null.
The two runs exercised local stub STT/agent/TTS, not provider quality. Controlled
private trials remain the recommendation; this adds no full validation pass.

Evidence and reproducibility:

- Bob: `data/wake-test/matched-bob-1791663442439/results.json` and `serial.log`;
  console log `data/hey-bob-trial.log`.
- Bob: `data/wake-test/matched-bob-1791663728971/results.json` and `serial.log`;
  console log `data/hey-bob-trial.log`.
- Extracted summaries: `data/wake-test/bob-comparison-summary.json` and
  `data/wake-test/bob-comparison-summary.json`.
- Synthetic fixture provenance/hashes:
  `data/wake-test/sapi-hey-bob-fb4ec6af27794b55a30dc56019108a9f/manifest.json`.
- Bob model SHA-256:
  `f69b650c268ba55c380d4abe3228809a969bbf1a52dab165bd6eeeef7bbeb2e9`.
  Bob model SHA-256 remains the pinned value above.

With the corresponding reviewed HIL firmware already flashed, local test database
available and COM3/7444 unclaimed, the private scratch runner commands are:

```powershell
$fixtures = 'data/wake-test/sapi-hey-bob-fb4ec6af27794b55a30dc56019108a9f'
$env:BOB_TRIAL_MODEL = 'bob'
node data/wake-test/matched-trial.mjs acoustic-single "$fixtures/hey_bob.wav" "$fixtures/balanced_negative.wav"
# Flash the reviewed Bob HIL build before running the next command.
$env:BOB_TRIAL_MODEL = 'bob'
node data/wake-test/matched-trial.mjs acoustic-single "$fixtures/hey_bob.wav" "$fixtures/balanced_negative.wav"
```

The runner itself does not flash. Each completed run restored Alexa/PTT and
cleaned up its local test processes. The scratch runner, recordings and raw logs
remain local/ignored; preserve the manifest with any later consented comparisons.

After this comparison, the original PROD/TLS profile and stored tokens were restored,
Alexa/PTT was saved, and the normal non-console Bob build was flashed successfully
(`data/hey-bob-final-flash.log`, exit 0, image hash verified). The local test API
was stopped. No firmware source was changed for this comparison.

## Design-partner accent coverage gate (2026-10-10)

**Required by the product owner:** wake detection must work for the actual design
partners across South Indian, North Indian, other South Asian, other Asian, and
American English backgrounds. Neither model is qualified for these users yet.
The earlier Bob preference describes one synthetic-voice hardware screen only;
it is not a product-selection decision for this audience.

Recruit by speakers' voluntary descriptions of their language background and
natural English pronunciation, not by inferred ethnicity, name or appearance.
These broad regional labels are recruitment coverage reminders, not single
accents. Ask which backgrounds the partners actually represent before finalizing
cohorts. Examples to check, not assumed participants, include Tamil-, Telugu-,
Kannada-, Malayalam-, Hindi-, Punjabi-, Bengali-, Marathi- and Urdu-influenced
English; other South Asian backgrounds; relevant East/Southeast Asian English
backgrounds; and the American English backgrounds in the partner group. Preserve
East/West Indian and mixed-language backgrounds rather than forcing a North/South
classification. Do not require anyone to imitate an American pronunciation.

### Pilot procedure

- Start with the actual consenting design partners. Aim initially for at least
  five independent speakers per represented language/accent cohort; fewer is
  explicitly a coverage gap, not a passing cohort. Do not claim coverage of all
  Asian or Indian-subcontinent speakers from this sample.
- Each speaker supplies ten independently spoken utterances of each exact phrase
  per tested condition. Replaying one recording ten times is one utterance, not
  ten independent examples. Use the same Cardputer, microphone orientation and
  measured setup; counterbalance model order across speakers.
- Begin with four practical cells: normal speech in quiet at 1 metre, quiet
  speech at 1 metre, normal speech in quiet at 3 metres, and normal speech with
  measured TV/conversation noise at 1 metre. This is 80 utterances per speaker
  across both phrases. Expand to the full 0.5/1/3-metre, voice-level and
  conversation/TV/music matrix before broader qualification. Record measured
  levels, distinguish live speech from replay, and keep untested cells visible.
- Use consented background speech in partners' usual languages as negatives,
  including code-switching and similar-sounding names/words. Exclude the exact
  target phrase from that model's negative exposure. Synthetic fixtures remain
  supplemental and separately reported.
- Keep recordings, consent and anonymous speaker mappings local and ignored.
  Evaluation consent does not automatically authorize training. If retraining
  becomes necessary, obtain training consent and hold out speakers entirely from
  training and threshold selection. Freeze each model/configuration before its
  evaluation round; rerun the whole matrix after tuning.

### Proposed acceptance targets (not measured or approved results)

For planning, target at least 95% detection in quiet normal speech and 90% in each
challenging condition, **within every represented cohort**, at declared supported
distances. Report each speaker's result too: a failing speaker must be investigated
rather than hidden by a strong cohort average. Small pilot sample percentages are
screening evidence; show counts and uncertainty before claiming qualification.

Target at most 0.1 false activation per active-listening hour and p95 detection
latency at most 500 ms from annotated phrase end, with a synchronized clock. Report
negative hours, counts and uncertainty: one hour with zero false activations does
not establish this false-activation target. Expand exposure before qualification;
do not extrapolate the existing 33-second screen into a reliability claim.

These numerical targets are provisional engineering proposals; the required
coverage is the owner's instruction. Review targets with partners before signing
off. Retain the firmware memory/timing and voice-return checks above: detection
accuracy alone cannot pass a model that overruns its processing interval.

**Current status:** zero consented human speakers tested in every requested cohort;
accent coverage, real-world miss rate, false-activation rate and latency are
unqualified. Next action is to identify the partners' language backgrounds and
collect consented, naturally spoken samples; no model promotion on synthetic
US-English results alone.

## Private firmware updates

Bob builds refuse public OTA offers and do not poll for them: the public binary
does not contain the private Bob weights. Boot health confirmation and rollback
settlement still run. Update these experimental devices over USB with a combined
Bob/Bob build until a compatible private release channel exists. Standard
firmware and standard HIL builds retain their normal OTA behavior.
