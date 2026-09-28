import type { Report } from "../contracts";

export function renderJson(report: Report): string {
  return JSON.stringify(report);
}

export function renderText(report: Report, _topK: number): string {
  const lines: string[] = [
    "# drexgrep",
    `question: ${report.question}`,
    `route: ${report.route}`,
    `outcome: ${report.outcome}`,
    `shown: ${report.hits.length}  also: ${report.also.length}`,
  ];

  for (const hit of report.hits) {
    lines.push("");
    lines.push(`## ${hit.rel}  rank=${hit.rank}  via=${hit.via}`);
    for (const quote of hit.quotes) {
      lines.push(`quote ${quote.from}-${quote.to}`);
      lines.push(quote.body);
    }
  }

  lines.push("");
  lines.push("## also");
  for (const item of report.also) {
    lines.push(`- ${item.rel}  rank=${item.rank}`);
  }

  lines.push("");
  lines.push("## problems");
  for (const [code, seen] of Object.entries(report.problems)) {
    lines.push(`- ${code} x${seen.times}`);
  }

  lines.push("");
  return lines.join("\n");
}
