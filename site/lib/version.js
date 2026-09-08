/**
 * Bumped by hand on every round of changes shipped to this site - shown in
 * the header next to the BETA badge so it's obvious at a glance whether the
 * droplet is actually running what was just deployed.
 *
 * Convention (owner's call): three numbers now, patch/minor/major by size -
 * patch (3.26.N) for a small, contained change (a copy fix, a label, a
 * one-file tweak); minor (3.N) for a normal round of fixes/features,
 * however many files, as long as it's not a step-change in what the site
 * does; major (N.0) only for something on the scale of the v3.0 redesign
 * this number started counting from, or the BotVault/VaultFactory redeploy
 * before that - PulseChain is on v2 of the contracts; Robinhood (a separate
 * deployment) is still on v1.
 */
export const APP_VERSION = "3.51.2";
