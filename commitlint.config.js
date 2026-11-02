/**
 * Conventional Commits, ported from the powerdog repo.
 *
 * Differences from powerdog: scopes there must be ticket IDs (eng-1234).
 * This project has no tracker yet, so a scope is an optional kebab-case
 * area name instead (bible, map, agent, storage, ui, build, ...).
 * Tighten `scope-format` later if a tracker is introduced.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "scope-format": ({ scope }) => {
          if (!scope) return [true];
          const pattern =
            /^[a-z0-9]+(-[a-z0-9]+)*(,\s*[a-z0-9]+(-[a-z0-9]+)*)*$/;
          return pattern.test(scope)
            ? [true]
            : [
                false,
                `scope "${scope}" must be kebab-case area name(s), e.g. bible or bible, storage`,
              ];
        },
      },
    },
  ],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat", // New feature
        "fix", // Bug fix
        "docs", // Documentation only changes
        "style", // Changes that do not affect the meaning of the code
        "refactor", // Code change that neither fixes a bug nor adds a feature
        "perf", // Performance improvement
        "test", // Adding missing tests or correcting existing tests
        "build", // Changes that affect the build system or external dependencies
        "ci", // Changes to CI configuration files and scripts
        "chore", // Other changes that don't modify src or test files
        "revert", // Reverts a previous commit
      ],
    ],
    "scope-format": [2, "always"],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "type-case": [2, "always", "lower-case"],
    "type-empty": [2, "never"],
    "body-leading-blank": [2, "always"],
    "footer-leading-blank": [2, "always"],
  },
};
