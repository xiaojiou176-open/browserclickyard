import { describe, expect, it } from "vitest";
import { guessCategory, isAiCommand, isDangerous } from "./commands";

describe("commands utils", () => {
  it("classifies pipeline and backend command categories", () => {
    expect(
      guessCategory({ command_id: "script-pipeline-capture", title: "Run UI", description: "", tags: [] }),
    ).toBe("pipeline");
    expect(
      guessCategory({
        command_id: "backend-test",
        title: "Backend Test",
        description: "",
        tags: ["backend"],
      }),
    ).toBe("backend");
  });

  it("detects dangerous and ai commands", () => {
    expect(
      isDangerous({ command_id: "clean", title: "Clear cache", description: "delete temp", tags: [] }),
    ).toBe(true);
    expect(
      isAiCommand({
        command_id: "automation-record-midscene",
        title: "",
        description: "",
        tags: [],
      }),
    ).toBe(true);
  });
});
