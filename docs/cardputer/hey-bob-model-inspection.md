# Hey Bob static model inspection

Inspected 2026-10-10. **Reuse permission remains unclear; private tests were subsequently authorized by the user.**
The upstream GitHub repository reports `license: null`; its complete recursive tree
at the revision below has no LICENSE, LICENCE or COPYING paths. This is absence of
permission evidence, not a legal conclusion. No author was contacted and no
commercial clearance is claimed. The original static inspection fetched candidate
bytes only into process memory. After the licence warning, the user explicitly
authorized private tests; the matching weights were then saved locally under
git-ignored `data/wake-test/hey_bob.tflite`, with the checksum below verified.
That authorization does not establish upstream reuse or redistribution rights.
Do not commit or redistribute the weights or a firmware image embedding them.
Existing Alexa/Jarvis fixtures have the repository's adjacent Apache-2.0 LICENSE.

## Pinned evidence

- Repository revision: `5400697e1fb3fc454ac18f6a9d3f714f663f2842`.
- [Manifest](https://github.com/TaterTotterson/Tater-Wake-Words/blob/5400697e1fb3fc454ac18f6a9d3f714f663f2842/microWakeWordsV1/hey_bob.json).
- [Artifact](https://github.com/TaterTotterson/Tater-Wake-Words/blob/5400697e1fb3fc454ac18f6a9d3f714f663f2842/microWakeWordsV1/hey_bob.tflite).
- Artifact size: **63,520 bytes**; SHA-256
  `b991a4f729028b916f3a5fc6e4a3e2c47b68e7240b64608e10f39067ba1121b1`.
- Manifest: microWakeWord **version 2**, English, cutoff **0.97**, window **5**,
  feature step **10 ms**, declared arena **30,000 bytes**, minimum ESPHome
  **2024.7.0**. The folder name `microWakeWordsV1` is not the format version.
- Phrase: **Hey Bob**. Bare Bob is not the trained phrase.

The checksum identifies inspected bytes; it does not grant reuse rights.

## Actual graph

TFLite schema version 3; no custom operators; two subgraphs. Main has 94 tensors
and 55 operators. Initialization has 12 tensors and 12 operators. All tensors
have `is_variable=false`, but that does **not** make this model stateless:
`CALL_ONCE` invokes initialization subgraph 1, whose six `VAR_HANDLE` /
`ASSIGN_VARIABLE` pairs initialize six resource-backed streaming states.
Main reads and assigns each state on successive invocations. Resource handle
container is empty and matching shared names identify the state across subgraphs.

| Interface | Shape | Type | Scale | Zero point |
| --- | --- | --- | --- | --- |
| Input | `[1,2,40]` | INT8 | 0.10196078568696976 | -128 |
| Output | `[1,1]` | UINT8 | 0.00390625 (1/256) | 0 |

Operators and versions: CALL_ONCE v1, VAR_HANDLE v1, RESHAPE v1,
READ_VARIABLE v1, CONCATENATION v2, STRIDED_SLICE v2, ASSIGN_VARIABLE v1,
CONV_2D v3, DEPTHWISE_CONV_2D v3, SPLIT_V v2, FULLY_CONNECTED v4,
LOGISTIC v2, QUANTIZE v1. Every operator name is already registered in
`apps/cardputer/src/wake_word.cpp`. Registration alone does not establish that
this firmware's kernels accept every parameter, allocate successfully or meet timing.

All six state values are INT8; names have prefix `streaming/`:

| Shared-name suffix | State shape | Payload bytes |
| --- | --- | --- |
| stream_6/states_1 | `[1,3,1,40]` | 120 |
| stream_7/states_1 | `[1,4,1,32]` | 128 |
| stream_8/states_1 | `[1,10,1,64]` | 640 |
| stream_9/states_1 | `[1,14,1,64]` | 896 |
| stream_10/states_1 | `[1,22,1,64]` | 1,408 |
| stream_11/states_1 | `[1,36,1,64]` | 2,304 |

State payload totals **5,496 bytes**. This is arithmetic on tensor shapes, **not**
arena measurement: activations, scratch, alignment and allocator metadata are extra.
Six unique handles fit the configured resource-variable capacity of 20.

## Frontend and fixture comparison

The model consumes features, not PCM. It does not contain an audio frontend or
enough metadata to prove every training preprocessing setting. The manifest's
10 ms step, 40 bins and input quantization match the firmware/fixture contract.
Full training preprocessing provenance remains unverified.

Firmware currently uses 16 kHz PCM16, 30 ms analysis windows, 10 ms hops, 40
filterbank channels (125–7,500 Hz), noise reduction (smoothing bits 10,
even 0.025, odd 0.06, minimum remaining 0.05), PCAN (strength 0.95, offset 80,
gain bits 21), log shift 6 and clamped int8 conversion
`((feature * 256 + 333) / 666) - 128`.

| Existing fixture | File bytes | Input | Output | Main graph |
| --- | --- | --- | --- | --- |
| Alexa | 55,856 | INT8 `[1,3,40]` | UINT8 `[1,1]` | 70 tensors / 45 operators |
| Hey Jarvis | 52,272 | INT8 `[1,3,40]` | UINT8 `[1,1]` | 70 tensors / 45 operators |

Both fixtures have identical input/output quantization to Bob, six resource states,
and the same opcode versions apart from Bob's additional SPLIT_V v2.
Alexa SHA-256: `9011a8155b04de858c48038529235cbc0e42e9fca05a55bf588cb80a653a723b`.
Jarvis SHA-256: `21a7976add39ee24ec96c63d96b7aaa18e24d1d9824b963e451da8feb4b78b77`.

Bob requires one invocation per **20 ms** of features versus fixtures' 30 ms.
The original fixed cooldown of 34 invocations would mean about **680 ms**
for Bob versus 1,020 ms for Alexa. Optional integration now uses a 1,020 ms gate:
51 invocations for Bob and 34 for Alexa. These durations follow from feature
cadence, not a measured cooldown boundary; see the private hardware results below.
Five probability samples cover 100 ms for Bob versus 150 ms for Alexa; preserve
the manifest window of five initially. Preserve the existing cutoff convention:
floor(0.97 × 255) = **247**, compare the window sum strictly greater than 247 × 5.
Do not silently reinterpret the cutoff using the tensor's 1/256 output scale.

## Static inspection reproduction (PowerShell, no weight file created by this command)

```powershell
py -3.11 -m pip install --target "$env:TEMP/bob-wake-inspect-deps" tflite==2.18.0 flatbuffers==25.2.10
$env:PYTHONPATH = "$env:TEMP/bob-wake-inspect-deps"
py -3.11 apps/cardputer/scripts/wake-model-inspect.py https://raw.githubusercontent.com/TaterTotterson/Tater-Wake-Words/5400697e1fb3fc454ac18f6a9d3f714f663f2842/microWakeWordsV1/hey_bob.tflite apps/cardputer/lib/wake_models/alexa.tflite apps/cardputer/lib/wake_models/hey_jarvis.tflite
```

The script prints all tensor shapes/dtypes/quantization, operator versions,
connections, initialization targets and resource names as JSON. It performs
static parsing only; it does not measure inference, allocation or acoustic quality.

Subsequent user-authorized private hardware tests are recorded in
[the trial report](hey-bob-trial.md). Bob's observed arena usage was
**24,236–24,248 bytes** within the unchanged **28,672-byte** capacity. The short
synthetic audio screen detected **10/10 positives** and produced **one confusable
false activation**; this is not a controlled human-speaker comparison or a
false-activations-per-hour result. The largest observed invocation was
**21.566 ms**, exceeding Bob's nominal **20 ms** interval. Kernel execution and
allocation now have device evidence, but timing safety is not established.
Reuse permission, full training-frontend provenance, controlled acoustic coverage
and sustained heap/stack endurance remain unresolved. See the trial report for
sample definitions, limitations and the final recommendation.
