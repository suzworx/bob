# Games epic (#460): game catalog

Voice-first games for the Cardputer (240x135 screen, speaker, mic, keyboard, GO push-to-talk, wake
word "Alexa") and the web app. Age bands used across the epic:

| band | ages | code |
| --- | --- | --- |
| Little | 4-7 | `little` |
| Kid | 8-12 | `kid` |
| Teen and adult | 13+ | `grown` |
| Family | mixed group; each player keeps their own band | per player |

Build difficulty: **S** means curated content plus engine only. **M** means the answer needs judging
or the state has several branches. **L** means the model generates content, or new audio assets.

## Candidates

| # | Game | How it plays by voice | Band | Players | Length | Screen shows | Why it is fun | Learning | Build |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Animal Riddles** | "I have a long trunk and big ears. Who am I?" Up to 2 hints, then the reveal with the animal's sound | little, family | solo or turns | 5-8 min, 6 riddles | the animal icon (after the reveal), hint dots, stars | guessing, a reveal that ends in a real sound | vocabulary, deduction | S |
| 2 | **Simon Says** | Olexa gives commands, some without "Simon says". Anyone who moved on a trick owns up, "I moved!" | little, family | group | 3-6 min | big command word, a green "SIMON" or red "no Simon" flash *after* the command | physical, tricking a grown-up voice | listening, self-control | S |
| 3 | **Family Quiz** | Multiple-choice rounds. Each player gets a question at their own band. Teams are optional | kid, grown, family | turns or 2 teams | 10-15 min, 3 rounds | question number, A/B/C, scoreboard | everyone plays at their own level, and the scoreboard | general knowledge | M |
| 4 | **20 Questions** | The player thinks of a thing. Olexa asks yes/no questions and guesses within 20 | kid, grown, family | solo or group | 5-10 min | question count as a bar, the current guess | "how did it know?!" (Akinator) | categories, reasoning | M |
| 5 | **Silly Stories** | Olexa asks for "a noun", "a silly word" and so on, then reads a curated story template with those words filled in | little (with a grown-up), kid, family | turns | 4-6 min | the blank being asked for, a word collection strip, then "story time" | the funny reveal | parts of speech | S |
| 6 | **Rhyme Time** | "What rhymes with cat?" Any real rhyme counts; Olexa offers one too | little | solo or turns | 4 min | the target word, big | quick wins | phonics | M |
| 7 | **Count and Add** | Spoken sums with objects ("3 apples and 2 more") that get harder | little, kid | solo | 5 min | the sum as dots and numerals | streaks | number sense | S |
| 8 | **Spelling Bee** | Olexa says a word and uses it in a sentence; the child spells it on the **keyboard** or out loud | kid | solo or turns | 8 min | letters typed so far, the word revealed | the keyboard makes it tactile | spelling | M |
| 9 | **Word Chain** | Each word starts with the last letter of the previous one. Say the category first | kid, grown | turns | 5-10 min | the last word and the required letter | tension builds | vocabulary | M |
| 10 | **Would You Rather** | Two silly options; everyone votes by saying their pick; Olexa reports the split | all, family | group | 5 min | A vs B, then the vote tally | talking, no wrong answers | reasoning, opinions | S |
| 11 | **Riddle Master** | Classic riddles with hints ("What has keys but can't open locks?") | kid, grown | solo or turns | 5 min | riddle number, hint dots | the "aha" moment | lateral thinking | S |
| 12 | **Categories** | "Name 5 fruits in 20 seconds!" Olexa counts the valid ones | kid, grown | turns | 5-8 min | category, countdown ring, count | time pressure | recall | M |
| 13 | **Story Builder** | Players and Olexa take turns adding one line to a shared story | kid, grown | turns | 10 min | the last line, whose turn | creativity | narrative | L (open generation needs moderation) |
| 14 | **Name That Sound** | Real recorded sounds: animals, vehicles, instruments | little, kid | turns | 5 min | sound number, then the icon | audio surprise | listening | L (licensed audio pack) |
| 15 | **Two Truths and a Lie** | Olexa tells 3 "facts" about a topic and players find the lie | grown, kid | group | 5 min | 1/2/3, vote | bluffing | fact checking | S |

## Ranking

Each game is scored out of 5 on four things. **Voice fit** means no screen needed and short answers.
**Safety** means curated content with no open generation. **Breadth** means how many bands it
serves. **Cost** means build and verification effort; higher is cheaper.

| rank | game | voice fit | safety | breadth | cost | total |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Family Quiz | 5 | 5 | 5 | 3 | 18 |
| 2 | Animal Riddles | 5 | 5 | 4 | 4 | 18 |
| 3 | Simon Says | 5 | 5 | 3 | 5 | 18 |
| 4 | Silly Stories | 4 | 4 | 4 | 4 | 16 |
| 5 | 20 Questions | 5 | 3 | 4 | 3 | 15 |
| 6 | Would You Rather | 5 | 4 | 5 | 5 | 19 before the novelty cap (-4: replay value is low) |
| 7 | Riddle Master | 4 | 5 | 3 | 4 | 16, but overlaps Animal Riddles |
| 8 | Count and Add | 4 | 5 | 2 | 5 | 16, but single band |
| 9 | Rhyme Time | 4 | 4 | 1 | 3 | 12 |
| 10 | Spelling Bee | 3 | 5 | 1 | 3 | 12 |
| 11 | Word Chain | 4 | 3 | 2 | 3 | 12 |
| 12 | Categories | 3 | 3 | 2 | 3 | 11 (speech recognition for fast lists) |
| 13 | Two Truths and a Lie | 4 | 3 | 2 | 4 | 13 |
| 14 | Story Builder | 4 | 1 | 2 | 1 | 8 |
| 15 | Name That Sound | 5 | 4 | 2 | 1 | 12 (needs licensed audio) |

## Launch set (5)

1. **Animal Riddles** (4-7). It has the richest payoff for the youngest players. Content is fully
   curated, and the answers come from a small, closed set, which is exactly what speech recognition
   does best with young voices. It also proves the hint and gentle wrong-answer loop that every
   other game reuses.
2. **Simon Says** (4-7, family). No answer is judged at all: the players are on their honour, so
   speech recognition errors cannot hurt. It gets the whole room moving, and it proves group play
   without turn order.
3. **Family Quiz** (8+, family). This is the flagship. Each player gets questions at their own band,
   so a 6-year-old and a grandparent play the same game fairly. It proves the engine's turn order,
   teams, scoring and multiple-choice judging.
4. **20 Questions** (8+, family). The "magic" moment that makes a $500 product feel smart. It uses
   the model's strength (guessing) and not its weakness (inventing facts), because Olexa asks the
   questions and the player owns the truth.
5. **Silly Stories** (5+, family). Creative play with no losing. The templates are curated and only
   single words come from players, and those words pass a word filter (safety.md), so the risk of
   open-ended generation is avoided while it still feels open-ended.

Two launch games serve ages 4-7 directly (Animal Riddles, Simon Says), and a third works there with
a grown-up (Silly Stories). Next wave: Would You Rather, Count and Add, Riddle Master. All three
reuse the launch engine unchanged.

## Prior art borrowed (cited)

- 20 Questions: the traditional parlour game, and Akinator's guess-by-questions model
  (https://en.akinator.com). We borrow "Olexa guesses, the player holds the secret".
- Mad Libs, Price and Stern, 1958 (https://en.wikipedia.org/wiki/Mad_Libs). We borrow word
  collection before the reveal.
- Simon Says: the classic playground game
  (https://en.wikipedia.org/wiki/Simon_Says). We borrow the rules as they are.
- Volley's *Song Quiz* and the *Jeopardy!* skill on Alexa. We borrow score call-outs between rounds
  and short multiple-choice answers.
- Alexa *Kids Court* and *Would You Rather for Family* (Amazon kid skills). We borrow the no-wrong-
  answer family format and the praise that rotates.
- Google conversation design, errors
  (https://developers.google.com/assistant/conversation-design/errors). We borrow no-input and
  no-match reprompts, then an exit after three.
- Alexa Follow-Up Mode and Home Assistant `continue_conversation`: already cited in
  `docs/cardputer/conversational-loop.md` D1/D6. We borrow the open mic after a question.

The links were written from prior knowledge and were not fetched in this session. Check them before
you quote them in public copy.
