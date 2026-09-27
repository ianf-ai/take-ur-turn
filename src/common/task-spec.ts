/** The frozen host template vocabulary. Repair deliberately checks literal H2 lines. */
export const TASK_SPEC_HEADINGS = ["要改变的行为", "验收场景", "明确不做", "必要依赖及理由"] as const;
export const EXIT_REVIEW_HEADING = "退出条件逐条核验";
export const SCOPE_REVIEW_HEADING = "超出规格的改动";

/** Ignore fenced examples and block quotes; keep indentation for top-level lists. */
function proseLines(text: string): string[] {
  let fence: { char: string; length: number } | undefined;
  return text.split(/\r?\n/u).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence.char && marker.length >= fence.length &&
          new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`, "u").test(line)) fence = undefined;
      return "";
    }
    if (marker) { fence = { char: marker[0]!, length: marker.length }; return ""; }
    return /^\s*>/u.test(line) || /^(?: {4}|\t)/u.test(line) ? "" : line;
  });
}

/** Exact named H2 or (for task specs only) standalone legacy heading. */
export function sections(text: string, title: string, bare = false): string[][] {
  const result: string[][] = [];
  let active: string[] | undefined;
  for (const line of proseLines(text)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    const bareHeading = bare && (TASK_SPEC_HEADINGS as readonly string[]).includes(line.trim());
    if ((heading && heading[1]!.length <= 2) || bareHeading) active = undefined;
    if ((heading?.[1] === "##" && heading[2] === title) || (bare && line.trim() === title)) {
      active = [];
      result.push(active);
    } else if (active) active.push(line);
  }
  return result;
}

export function isPlaceholder(text: string, allowNone = false): boolean {
  const value = text.trim().replace(/[；;。.!！]+$/u, "").trim();
  return !value || /^(?:TODO|TBD|待补充|待填写|待定|\.\.\.|…+)$/iu.test(value) || (!allowNone && value === "无");
}

export interface ListItem { number?: number; text: string }
/** A deliberately limited list grammar, not a general Markdown parser. */
export function listItems(lines: readonly string[]): ListItem[] {
  const items: ListItem[] = [];
  let indent: number | undefined;
  for (const line of lines) {
    const match = /^( *)(?:(\d+)[.)](?:\s+|$)|[-+*](?:\s+|$)|([①-⑳]))(.*)$/u.exec(line);
    if (match && (indent === undefined || match[1]!.length <= indent)) {
      indent = match[1]!.length;
      if (match[3]) {
        for (const part of line.trim().matchAll(/([①-⑳])([^①-⑳]*)/gu)) {
          items.push({ number: part[1]!.charCodeAt(0) - "①".charCodeAt(0) + 1, text: part[2]!.trim() });
        }
      } else items.push({ ...(match[2] ? { number: Number(match[2]) } : {}), text: match[4]!.trim() });
    } else if (items.length && line.trim()) items[items.length - 1]!.text += `\n${line.trim()}`;
  }
  return items;
}

export function exitConditions(description: string) {
  const found = sections(description, TASK_SPEC_HEADINGS[1], true);
  const diagnostics: string[] = [];
  if (!found.length) diagnostics.push("缺少验收场景节");
  if (found.length > 1) diagnostics.push("验收场景节重复，请整理为唯一小节");
  const items = found.length === 1 ? listItems(found[0]!) : [];
  if (found.length === 1 && !items.length) diagnostics.push("验收场景没有逐条退出条件（每条以「数字. 」开头：编号后需空格）");
  items.forEach((item, index) => {
    if (isPlaceholder(item.text)) diagnostics.push(`验收场景第 ${index + 1} 条为空或占位，尚未填写`);
  });
  return { items: items.filter((item) => !isPlaceholder(item.text)), diagnostics };
}

export function taskSpecWarning(description: string): string | undefined {
  const { diagnostics } = exitConditions(description);
  return diagnostics.length ? `warning: ${diagnostics.join("；")}` : undefined;
}
