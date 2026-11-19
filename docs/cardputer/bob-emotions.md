# Bob's emotions (Waveshare 1.85C round screen)

47 emotions made from the SAME character art. An emotion is four independent parts:
a body pose (one of the four images in `apps/cardputer/lib/bob_art`), a procedural eye
expression drawn on the dark visor (`src/bob_face.cpp`), a motion gesture (`src/bob_motion.cpp`)
and an animated accent around Bob (`src/bob_emotions.cpp`). There is no new body art and no
generated image.

The table lives once, in `libs/bob-device/src/bob_emotion_table.h` (X-macro).
`apps/cardputer/scripts/bob_emotions_preview.py` parses it and draws the contact sheet
[bob-emotions.png](bob-emotions.png) with the same shapes; `--check` fails when the sheet is stale.
Bring-up gallery: `waveshare-s3-185c-bringup` cycles every emotion for 3 s (tap = next, BOOT =
previous) and prints `ws185 emotion=<name> frame_ms=<avg>/<max>`.

## Palette

| Name | Hex | Use |
| --- | --- | --- |
| ink | #173E57 | ground, dark glyphs |
| paper | #FFFDF6 | ivory text, highlights |
| yellow | #F0C75E | ?, !, bulb, bell, sparkles |
| sky | #BBDDF0 | tears, Zzz, notes, waves, sweat |
| grass | #72965B | success check, sick |
| coral | #F07A6A | love, blush, anger, failure (added for Bob's feelings) |
| amber | #F5B83A | eyes (sampled from the art) |

## Catalogue

| # | Emotion | Pose | Eyes | Gesture | Accent | Used when |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Idle | welcome | Dot | None | None | waiting, nothing to do |
| 2 | Listening | curious | Wide | Tilt | Waves | push-to-talk or wake word is capturing |
| 3 | Thinking | thoughtful | LookUp | None | Dots | agent is working |
| 4 | Speaking | welcome | Dot | Nod | Waves | reply audio is playing |
| 5 | Sleeping | thoughtful | Closed | None | Zzz | do-not-disturb |
| 6 | WakingUp | curious | HalfLid | Nod | None | leaving sleep |
| 7 | Hello | welcome | Wide | Nod | Sparkles | pairing, first greeting |
| 8 | Updating | thoughtful | LookLeft | None | Spinner | busy, OTA, long wait |
| 9 | Offline | thoughtful | Sad | Slump | NoSignal | no Wi-Fi or server |
| 10 | Error | thoughtful | Wide | Shake | Warn | confused by a failure |
| 11 | Success | playful | HappyArc | Bounce | Check | action done |
| 12 | Failed | thoughtful | X | Slump | Cross | action failed |
| 13 | Happy | playful | HappyArc | Nod | None | good news |
| 14 | Joyful | playful | HappyArc | Bounce | Sparkles | great news |
| 15 | Laughing | playful | Laugh | Wobble | Tears | jokes |
| 16 | Love | playful | Heart | Sway | Hearts | affection |
| 17 | Grateful | welcome | HappyArc | Bow | Blush | thanks |
| 18 | Proud | playful | Closed | Nod | Sparkles | achievement |
| 19 | Playful | playful | Wink | Tilt | None | teasing, games |
| 20 | Excited | playful | Wide | Bounce | Sparkles | anticipation |
| 21 | Celebrating | playful | HappyArc | Dance | Confetti | milestones |
| 22 | Relieved | welcome | Closed | Slump | None | problem solved |
| 23 | Calm | thoughtful | Closed | None | None | relaxing, meditation |
| 24 | Cool | welcome | Shades | Nod | Sparkles | confident |
| 25 | Curious | curious | BigSmall | Tilt | None | interested |
| 26 | Surprised | welcome | Wide | Bounce | Exclaim | unexpected |
| 27 | Amazed | playful | Star | Bounce | Sparkles | wow |
| 28 | Confused | curious | LookLeft | Tilt | Question | did not understand |
| 29 | Skeptical | thoughtful | Skeptic | Tilt | None | doubt |
| 30 | Focused | thoughtful | Narrow | None | None | concentrating |
| 31 | Idea | curious | Wide | Bounce | Bulb | suggestion |
| 32 | Sad | thoughtful | Sad | Slump | None | bad news |
| 33 | Crying | thoughtful | Sad | Shiver | Tears | very bad news |
| 34 | Worried | thoughtful | Sad | Tilt | Sweat | concern |
| 35 | Scared | welcome | Wide | Shiver | ShiverLines | fright |
| 36 | Grumpy | welcome | Angry | Shake | Anger | complaints |
| 37 | Annoyed | thoughtful | Roll | Tilt | None | irritation |
| 38 | Embarrassed | welcome | LookLeft | Wobble | Blush | awkward |
| 39 | Shy | curious | LookRight | Tilt | Blush | bashful |
| 40 | Bored | thoughtful | HalfLid | Slump | Dots | idle too long |
| 41 | Sleepy | curious | HalfLid | Nod | Zzz | late at night |
| 42 | Dizzy | curious | Spiral | Wobble | Stars | overwhelmed |
| 43 | Sick | thoughtful | Wavy | Wobble | Sick | unwell |
| 44 | Apologetic | welcome | Sad | Bow | None | sorry |
| 45 | Alarm | curious | Wide | Shake | Bell | alarm or timer rings |
| 46 | Music | playful | HappyArc | Dance | Notes | playing music |
| 47 | Reminder | welcome | Wide | Nod | Bubble | reminder due |
