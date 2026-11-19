/**
 * Stored digests and pinned public-copy excerpts for Bob's marketing pack
 * (issue 1396, U1). Local digests are SHA-256 of each file's raw bytes. Excerpts
 * are exact substrings of the landing repository at `landingRevision`, with the
 * SHA-256 of the excerpt text. Nothing here is recomputed at run time; the
 * structural drift checker detects a changed file, and only a human review may
 * update these values.
 */
const landingRevision = '3ff0d883acbb591691dca451af31bf5e8c235220';

type Excerpt = {
  sourceURL: string;
  revision: string;
  sourcePath: string;
  line: number;
  excerpt: string;
  excerptSha256: string;
  verification: 'repository_snapshot';
};

function excerptOf(sourcePath: string, line: number, excerpt: string, excerptSha256: string): Excerpt {
  return {
    sourceURL: `https://github.com/suzworx/heybob-landing-page/blob/${landingRevision}/${sourcePath}`,
    revision: landingRevision,
    sourcePath,
    line,
    excerpt,
    excerptSha256,
    verification: 'repository_snapshot',
  };
}

/** Local code and documentation evidence: repository path to SHA-256 of its raw bytes. */
export const localFileSha256 = {
  'AGENTS.md': 'cff0c6e33a0f53f234831c2823f76cc99b93154cad18e1edd52960b7c502ccba',
  '.claude/skills/bob-character/SKILL.md': 'b768cfe6bfcf73e76fa77005eb41908d780f29ce89e0a85747f3ed2daab3d817',
  'apps/ai/src/productivity-tools.ts': 'a04260c85a54d11fe8d00278f1649c8090b8ae6f2cde74cf9c5d22c9c185317f',
  'apps/api/src/tasks/agent-callbacks.ts': '0db9bc20d4101c3f97c0659b07c3803073adcf6444e56cf0fb3f4599a46b0fba',
  'apps/ai/src/voice-tools.ts': 'ca66ca56c48b60b74f0fe7cddec384c52f935bdf10055883b370863f23465c7b',
  'apps/api/src/voice/tool-providers.ts': '1344d1c614eb63f28272baf0e0542886b25978204cda9ce2624379fd7676106b',
  'apps/ai/src/games/registry.ts': '914a9efdc0cc57a7459cfdcae160d6ebe40ed6c891f5847ea9f8890b1db1f293',
  'apps/ai/src/memory-tools.ts': '6275e3398b83cce7dd2f6086f8181889bc11a5db65ebaa142fcbb1949fd4c58f',
  'apps/api/src/voice/voice-tools.ts': 'c185e1d6c39a4fe99dfb2854c9d0313525a7ae6c725a598495803efd7dcd3bd6',
  'apps/api/src/memory/extract.ts': 'df47883bfe12ee0a6d05df4acd6ae273dcd66949fcb9a3d023809b269519232a',
  'apps/api/src/workflows/workflow-web-chat-turn.ts': '36327f41c89946af16a209e5c937a037a18dec7892596d76a0e75719173194c1',
  'apps/api/src/voice/turn/context.ts': 'c3e4a9ddf7747c6d31ba54bd916950d2aee4d616eaf550f695cb72b79454c59c',
  'apps/api/src/voice/turn/generate.ts': 'b353df716e4545975eb4a6dc8e5034dcf97206c19711abbcdf0d856591d58ce6',
  'apps/api/src/conversations/scope.ts': '26f12d857657f2a7e9e8b8330a1b88f92cedbe6984a83373e22f2f952a222feb',
} as const;

/** Approved Bob art: owner originals under apps/ui-v2/public/brand/bob, never redrawn. */
export const artSha256 = {
  'bob-playful': '862e3a2f9e3bc1c213b9de4ec2df389143c24ad114dd74c4133f6e00e4ca2f57',
  'bob-helper': 'b6f524dd57891cc4d187620a631c6fc0f64ce83bcf2bbb9b47bfe127b3e5b100',
} as const;

/** Public-copy excerpts used as evidence, verified offline against the repository snapshot only. */
export const landingExcerpts = {
  'seo.title': excerptOf('src/lib/seo.ts', 8, 'Bob. Your playful AI companion on phone and device.', '7d9d2dc86e79728d95394fac4c9d482ed309d6fef9545142fe66b02e76e944ea'),
  'seo.description-play': excerptOf('src/lib/seo.ts', 9, 'Play, chat and make plans with your people.', 'f17dc7d98be26cffcd6dd394f5a887c3b56d4e788591f4a7e204ce5415d3ba8a'),
  'seo.description-device': excerptOf('src/lib/seo.ts', 9, 'an AI companion on your phone and Bob device', 'fa2b5fcb1b130dda3e380d77e89cdf1795c28c75540ca8dfcef97c8496dcdc5e'),
  'seo.description-beta': excerptOf('src/lib/seo.ts', 9, 'Sign up for early beta.', '35cf788ad4da486a59fda5c14449e8c468ac18a219c6bae54ab1fc1f36b8073b'),
  'audience.for-you': excerptOf('src/lib/audience-content.ts', 138, 'For you', '143134f9392545a25774f24d42306752bcbbb7ea18ee8cffd69fb5b7388eec06'),
  'audience.families': excerptOf('src/lib/audience-content.ts', 215, 'For families', '2d8aeaf630d5a80710444d29e78d43d3a80eb818ff394a73ea65288124a17119'),
  'audience.older-adults': excerptOf('src/lib/audience-content.ts', 55, 'For older adults', '4989ac587269f2893f7618139329bb81168e4f6a9a5dc3143f22af84e2f51fd6'),
  'audience.businesses': excerptOf('src/lib/audience-content.ts', 293, 'For businesses', '51afbce6c259352abbed182f1ba3ee5487ee4f623f75e482153a63374b9a7148'),
  'faq.channels-planned': excerptOf('src/lib/audience-content.ts', 203, 'Telephone calling and connections to other messaging apps are planned.', 'b088c707036436b35b0c6bc4fb5117f86845651c912a7739dfe8ad6d57b56863'),
  'faq.beta-access': excerptOf('src/lib/audience-content.ts', 208, 'Sign up to join the list and hear about access.', 'f2a95e814a4716788ca9e6d47c04a91f4e1842973356423e4f6305f2b690e3e5'),
  'faq.device-concept': excerptOf('src/lib/audience-content.ts', 208, 'The pictured device is a concept; retail pricing and shipping details', 'b85eb60668cafdff15bb6d89ff0939cdc36277e8f7f1400537249fbd18a236f0'),
  'faq.business-not-announced': excerptOf('src/lib/audience-content.ts', 353, 'A dedicated business offering, pricing and deployment model have not been announced.', 'e2c4f2149c7e2bd443bf0189644b8784e02dda43ecee60850dbbe48294a8a49a'),
  'faq.business-boundary': excerptOf('src/lib/audience-content.ts', 347, 'Business integrations and deployment terms are not yet announced.', '63ec4be7fc6beeff6d4e8a72ecdf8aef8e61fe79c24bd879c14796a364864967'),
  'faq.business-crm-question': excerptOf('src/lib/audience-content.ts', 356, 'Does Bob connect to our CRM, Slack or inventory system?', 'fd6fef529dd9ffc25ce949241e13a8708acbbc185da3b05b65003e456f88c583'),
} as const;
