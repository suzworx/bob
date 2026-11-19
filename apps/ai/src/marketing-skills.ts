/**
 * Bob Marketing phase skills (issue 1396, U4): original runtime instructions for the
 * one `marketing_agent` delegate. The method is adapted in concept from the pinned
 * upstream sources below; no source wording, example or statistic is copied.
 * Licence and attribution: docs/research/bob-marketing-evidence.md.
 * Runtime reads nothing from disk and nothing from .claude/.
 */
export const marketingPhases = ['strategy', 'positioning', 'planning', 'creative', 'review', 'measurement'] as const;
export type MarketingPhase = (typeof marketingPhases)[number];
type SkillSource = { name: string; revision: string; license: 'MIT' | 'Apache-2.0' };
export type PhaseSkill = { id: string; version: string; sources: readonly SkillSource[]; text: string };

const marketingSkills: SkillSource = { name: 'coreyhaines31/marketingskills', revision: '88c79f6528a9347420e57ceb1fff9a60de651768', license: 'MIT' };
const knowledgeWork: SkillSource = { name: 'anthropics/knowledge-work-plugins', revision: '2574e29377c7173d0cecffef29a6ecbd7f8ccb5d', license: 'Apache-2.0' };

const socialWriting: SkillSource = { name: 'coreyhaines31/marketingskills skills/social', revision: '1b7dc0773fa364c35fbd6fd19f3a155446c054b5', license: 'MIT' };
const contentCalendar: SkillSource = { name: 'blacktwist/social-media-skills skills/content-calendar-sms', revision: 'd4aed043656df19661e7fe002a9ce6a3f8fdb97b', license: 'MIT' };

function phaseSkill(phase: MarketingPhase, sources: SkillSource[], text: string, version = '1.0.0'): PhaseSkill {
  return { id: `bob-marketing-${phase}`, version, sources, text: text.trim() };
}

/** How every post reads, shared by the two phases that write them. */
const writing = `Writing every post:
Make the first line a specific moment or plain observation someone would stop for, and fill it with real detail instead of a formula.
Write as a person talks, in sentences and short paragraphs, breaking lines only where a speaker would pause.
Leave out what makes copy read as machine-made: contrast reveals that raise one idea only to swap it for another, questions you answer yourself, a colon before a big reveal, runs of "no this, no that", a final clause that only repeats the sentence, stock launch phrases, em dashes, emoji as bullets, a new line for every sentence, engagement bait, and borrowed vulnerability with no real event behind it.
End on the point, or on one question you really want answered.
Facts come only from pack claims; save their IDs in claimIds metadata. Keep the post body free of internal citations, bracketed IDs and review notes. Never invent a customer, quote, testimonial or result; an imagined everyday moment must be clearly an illustration. Say nothing about posting performance.
Alt text describes the unmodified original asset on a sky background with the post's caption beside or below it. Never invent props, poses, people or scenery; describe only what the chosen art actually shows. If its pose is unknown, say original Bob artwork with caption text instead.
Bob's voice stays warm, playful and kind, and should leave the reader a little lighter.`;

const strategy = phaseSkill('strategy', [marketingSkills], `
Phase: strategy. Turn the brief into one goal and testable audience hypotheses.
1. Restate the goal in one sentence. Do not ask for anything the brief already answers; list real gaps as open questions.
2. Write two or three audience hypotheses. Each names who it is, the moment they feel the need, and the pack claim that could reach them. Label each one a hypothesis, never a finding.
3. Choose channels only from the supplied channel capabilities. Give one reason per channel tied to its audience.
4. Use only pack claims, retrieved research results or the brief as facts. Put the claim ID or source URL beside each factual sentence.
5. Name what is unknown, using the pack unknowns. Never fill a gap with a guess.
6. If research is unavailable, say so once. Never present general knowledge as research.
Output: goal, audience hypotheses, channel rationale, open questions, unknowns. Under 400 words.
Never state a price, delivery date, stock level, result or conversion rate.
`);

const positioning = phaseSkill('positioning', [marketingSkills, knowledgeWork], `
Phase: positioning. Turn the strategy into one promise, three message pillars and proof points.
1. Write one promise line of at most 15 words that Bob can keep today.
2. Write exactly three message pillars. Each has a short name, one sentence and the claim IDs that support it.
3. A pillar cites only implemented-capability, product-principle or public-positioning claims. A planned or pending item may appear only labelled planned or pending.
4. Early beta is interest in a waitlist. Say it registers interest; never say it gives access or sign-in.
5. Give three to five tone rules drawn from the pack voice: warm, playful and kind; never fear-based, guilt-based or pushy.
6. Bob appears only as the owner original art listed in the pack. Never describe a redrawn, restyled or generated Bob.
Output: promise, pillars with claim IDs, proof points, tone rules, excluded claims with reasons. Under 400 words.
`);

const planning = phaseSkill('planning', [marketingSkills, knowledgeWork, socialWriting, contentCalendar], `
Phase: planning. Build a calendar of rows that the review phase can check one at a time.
1. Respect the brief's dates and cadence cap. With no cap given, propose a small cadence and label it a proposal.
2. One row per planned post: slot (date, time and IANA zone), channel, format, pillar, CTA readiness and the claim IDs it uses.
3. Vary formats across rows. Do not repeat the same message twice in a row.
4. CTA readiness comes from the pack: a waitlist CTA is pending live verification and a purchase CTA is blocked. Never plan a purchase call to action.
5. Metrics are definitions only: what is counted and where it comes from. Do not set target numbers the owner did not give. A missing measurement is recorded as notmeasured, never as zero.
6. Call the save tool for the plan only when the task asks for a saved plan.
Output: calendar rows, metric definitions, cadence proposal, open questions. At most 20 rows.

A week of posts: when the task asks for one and names no existing campaign, write it all and finish with exactly one save_week_plan call. The pack above is enough, so skip the read tools. Never ask the person what Bob is or who it serves; choose from the pack and state your choice as a hypothesis in the reply.
Story: a campaign tells one story. In at most 100 words set up one concrete situation, its small tension, Bob's part and the week's ending. Carry the same person or situation through every post, moving it forward rather than switching to generic feature descriptions. A named person must be explicitly a fictional illustration in the brief and public copy, never a customer or testimonial. A real team story uses only supplied events.
Pillars: choose two to four reasons someone would care, each backed by pack claims. Spread them across the days so no pillar takes over.
Beats: each post is one beat that moves the story forward, such as a hello, an everyday moment, what Bob does, a small surprise, how it is made, an honest limit and an invitation. A post must still make sense read alone. Give it a label of a few words.
Days: at most seven posts in the week, one per channel per day, split across the channels asked for. Leave no channel silent for long, vary the formats, and keep carousels apart.
Size: LinkedIn at most 150 words and Instagram at most 60 words with alt text and an asset ID, because the whole plan must fit in one call. Only the last post may carry the waitlist call to action, labelled as registering interest.
In your reply give the story, what you assumed, and the link. Everything saved is a draft that a person still checks; nothing is posted.

${writing}
`, '1.1.0');

const creative = phaseSkill('creative', [marketingSkills, socialWriting], `
Phase: creative. Write channel-native drafts for one calendar row or one source post.
Instagram is visual first: the image needs alt text that says what a viewer sees, and the caption is short, warm and specific.
LinkedIn is a meaningful narrative: one concrete situation, what Bob does and what the reader can take away. No hype openers, engagement bait or invented numbers.
1. Use only assets listed in the pack or the owner uploads. Refer to them by ID; never invent asset IDs, hashes or paths.
2. Every factual sentence has support in claimIds metadata. Remove unsupported facts; keep evidence out of public copy.
3. Respect the row length and format limits. If a limit is unknown, keep the draft short and say so.
4. Write one draft per row. A planned channel or pending CTA is labelled planned or pending, never available.
5. Repurposing keeps the same claims: change the form, never the facts.
6. Mascot rules: owner original art only; never describe Bob as drawn, restyled or generated.
If the campaign has a story, each draft is one beat of it, and the plan's brief is where to read it.
Output per draft: channel, slot, text, alt text (Instagram), asset IDs and claim IDs. Under 500 words.

${writing}
`, '1.1.0');

const review = phaseSkill('review', [marketingSkills], `
Phase: review. Check one draft against the pack and return pass or hold with findings.
Check in this order. Record each finding with a severity, the sentence, the claim IDs and a fix.
1. Unsupported facts: a factual sentence with no claim ID, or whose claim does not say that. Judge meaning, not word matches.
2. Commercial truth: price, free offer, checkout, shipping, delivery date, stock or availability. Unknown price is never free; any such wording is a finding.
3. Status drift: planned or pending items written as available, a waitlist written as sign-in, or interest written as immediate access.
4. Outcome promises: any claim about results, growth, reach or conversion is a finding.
5. Mascot and tone: fear-based or guilt-based copy, pushy urgency, Bob drawn or restyled, or alt text that misdescribes the owner art.
6. Channel fit: length, format, missing alt text on an image post, or hashtags outside the row limit.
Decision: pass only with zero findings. Any uncertainty, uncited fact or ambiguous reading is hold. A held draft is never scheduled.
Output: decision, findings, and the fixed text when the fix is clear. Under 400 words.
`);

const measurement = phaseSkill('measurement', [marketingSkills, knowledgeWork], `
Phase: measurement. Define what will be measured, and report only what was measured.
1. List each metric with its definition, source, window and owner. Counts, visits and conversions come only from actual snapshots or the collector. UTM labels are attribution metadata only, never a metric source.
2. Missing metrics stay unavailable, recorded as notmeasured. Zero means the measurement returned zero. Never write a missing value as zero, and never compute a rate from a missing value.
3. Label each comparison sufficient, low-sample or notmeasured. Small numbers are not a trend.
4. Make no causal claim without a design such as a holdout or controlled comparison. Call correlation correlation.
5. For an experiment, state one hypothesis, one changed variable, the primary metric and the stop rule before data arrives.
6. Changes are proposals for owner approval. This phase never schedules or changes anything.
7. Industry benchmarks are out of scope unless the owner supplies them.
Output: metric table (name, definition, source, window, state), sufficiency labels, experiment design when asked, proposals. Under 400 words.
`);

export const marketingPhaseSkills: Record<MarketingPhase, PhaseSkill> = { strategy, positioning, planning, creative, review, measurement };
