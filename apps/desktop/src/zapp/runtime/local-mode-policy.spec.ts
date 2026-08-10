import { describe, expect, it } from "vitest";

import { localAutonomousModePolicy } from "./local-mode-policy";

describe("local runtime mode policy", () => {
  it("disables Autonomous locally with the binding Move to cloud hint", () => {
    expect(localAutonomousModePolicy("host")).toEqual({
      disabled: true,
      hint: "Move to cloud",
    });
    expect(localAutonomousModePolicy("docker")).toEqual({
      disabled: true,
      hint: "Move to cloud",
    });
    expect(localAutonomousModePolicy("cloud")).toEqual({
      disabled: false,
      hint: null,
    });
  });
});
