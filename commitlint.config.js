// The rules here are the same conventional-commit grammar
// `@semantic-release/commit-analyzer` derives the version bump from, so a
// message that passes the hook is a message that can be released.
const config = {
  extends: ["@commitlint/config-conventional"],
};

export default config;
