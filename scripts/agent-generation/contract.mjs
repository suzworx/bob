export const CONTRACT = `## Bob native agent contract
Use the active runtime's native subagent system when delegation is authorized. Honor its configured models and permissions.
Read AGENTS.md, docs/architecture.md, and .claude/skills/bob-dev/SKILL.md. Follow the shared engineering contract in .claude/skills/bob-dev/references/agent-contract.md: use the checkout and base commit you are given, and follow user authorization and the bounded work order for Git actions.
You are not alone in the codebase. Preserve other agents' work. Domain ownership is the outer boundary, and the work order narrows it. Report required shared seam changes to the lead.
Load the relevant skills before implementation. Skills listed below are discoverable guidance, not proof of installation. Locate missing skills and report missing prerequisites honestly.
For UI work read apps/ui-v2/CLAUDE.md and use the Astryx CLI templates and component contracts before changing UI. For firmware read the shared hardware contract before touching hardware.
Return changed files, actual gate commands and exit codes, evidence, skipped checks and risks. Full npm run validate (or -- --skip-firmware for non-firmware work) is mandatory before delivery. Never claim a skipped check passed.
`;
