// Keep command topics derived from the same flag reference as full help.
export function commandHelp(topic, full) {
  const name = ({ agent: "review", findings: "finding" })[topic] ?? topic;
  const section = (start, end) => {
    const at = full.indexOf(`\n${start}`);
    const until = end ? full.indexOf(`\n${end}`, at + 1) : -1;
    return at < 0 ? "" : full.slice(at + 1, until < 0 ? undefined : until).trim();
  };
  const dir = full.split("\n").find(l => l.startsWith("  --dir <path>"));
  const reviewers = full.split("\n").filter(l => /^  --(?:agents|reviewer|jury)\b/.test(l));
  const topics = {
    review: `jury review <pr-url> [flags]\njury review <pr-url-1> <pr-url-2> [flags]\nReview related PRs together in one task, using each PR base branch (omit --trunk).\njury <pr-url> [flags]\n\n${section("review ", "finding commands")}\n\nWith a PR URL, the default working/state root is ~/.jury.\nUse --push=false to disable pushing.`,
    finding: section("finding commands", "With a PR URL"),
    reply: `jury reply [--dir <path>] [--run <slug>]\n\nReply to each reviewer about its answered findings.\n${dir}\n${[...new Set(reviewers)].join("\n")}`,
    runs: `jury runs [--dir <path>]\n\nList recorded review runs and their slugs.\n${dir}`,
    agents: "jury agents\n\nCheck which configured agents are installed and show their roles.\n\njury agents judge                  show the global default\njury agents judge <agent>          set the global default\njury agents judge --reset          remove the global override\n\nSaved in ~/.jury/config.json. Precedence: --judge, repository main role, global judge, built-in default.",
    version: "jury version\n\nPrint the installed package version.",
    help: "jury help [command]\njury help --all\n\nShow command help or the complete command reference.",
  };
  if (!Object.hasOwn(topics, name)) return null;
  return `${full.split("\n")[0]}\n\n${topics[name]}\n`;
}
