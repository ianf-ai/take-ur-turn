import { describe, expect, it } from "vitest";
import { exitConditions, sections, taskSpecWarning } from "../src/common/task-spec.js";

describe("finite task spec grammar", () => {
  it.each(["1. first\n2) second", "- first\n- second", "① first；② second"])("extracts %s", (items) => {
    expect(exitConditions(`## 验收场景\r\n${items}\r\n## unknown\r\n3. ignored`).items).toHaveLength(2);
  });
  it("splits the task's six same-line acceptance conditions", () => {
    const spec = "验收场景\n① 缺退出条件的 create → warning 且创建成功；② verdict 判定数 < 描述条件数 → warning 且记录落盘；③ 无超出规格的改动段的 verdict → warning；④ fail_design 后直接 code_changes → warning 应为 revision；⑤ 四标题同源测试：修改模板标题 → store 侧测试红；⑥ 全量回归绿。\n\n明确不做\n不改派生表";
    expect(exitConditions(spec).items).toHaveLength(6);
    expect(taskSpecWarning(spec)).toBeUndefined();
  });
  it("ignores fences, quotes and nested items, retains continuation", () => {
    const spec = "```md\n## 验收场景\n1. example\n```\n> ## 验收场景\n> 1. quote\n## 验收场景\n1. actual\n  - nested evidence\ncontinued\n2. other\n~~~\n3. example\n~~~";
    const parsed = exitConditions(spec);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.text).toContain("continued");
  });
  it.each(["no section", "## 验收场景\nplain prose", "## 验收场景\n1. ", "## 验收场景\n- TODO", "验收场景\n① 无", "## 验收场景\n1. actual\n## 验收场景\n2. more"])("diagnoses incomplete or ambiguous specs: %s", (spec) => {
    expect(taskSpecWarning(spec)).toBeTruthy();
  });
  it("ends sections at unknown peer or higher headings", () => {
    expect(sections("## 超出规格的改动\n## Else\nnot scope", "超出规格的改动")).toEqual([[]]);
  });
});
