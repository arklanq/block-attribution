export type AttributionRule = {
  id: string;
  description: string;
  pattern: RegExp;
};

const AI_NAMES =
  "claude|anthropic|codex|openai|chatgpt|copilot|cursor|gemini|aider|devin|windsurf|codeium|jules";

export const RULES: readonly AttributionRule[] = [
  {
    id: "co-authored-by",
    description: "Co-authored-by trailer naming an AI agent",
    pattern: new RegExp(`co-authored-by:[^\\n]*\\b(?:${AI_NAMES})\\b`, "i"),
  },
  {
    id: "session-trailer",
    description: "Claude-Session trailer",
    pattern: /claude-session:/i,
  },
  {
    id: "generated-with",
    description: '"Generated with/by <agent>" line',
    pattern: new RegExp(`generated (?:with|by) \\[?(?:${AI_NAMES})\\b`, "i"),
  },
  {
    id: "session-link",
    description: "Claude session link",
    pattern: /claude\.ai\/code\/session_/i,
  },
  {
    id: "projects-attribution",
    description: "Claude Projects attribution marker or project thread link",
    pattern: /claude-projects-attribution|claude\.ai\/code\/project\//i,
  },
];

export type Finding = {
  rule: AttributionRule;
  line: string;
};

export function findAttribution(
  text: string,
  extraPatterns: readonly RegExp[] = [],
): Finding[] {
  const rules = [
    ...RULES,
    ...extraPatterns.map((pattern, index) => ({
      id: `custom-${index + 1}`,
      description: `custom pattern ${pattern.source}`,
      pattern,
    })),
  ];
  const findings: Finding[] = [];

  for (const line of text.split(/\r?\n/)) {
    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        findings.push({ rule, line: line.trim() });
        break;
      }
    }
  }

  return findings;
}

export function describeFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `  - ${finding.rule.description}: ${truncate(finding.line, 160)}`)
    .join("\n");
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
