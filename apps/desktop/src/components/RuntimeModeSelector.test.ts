import { describe, expect, it } from "vitest";
import {
  dockerModePresentation,
  shouldShowCloudSandboxOption,
} from "./RuntimeModeSelector";

describe("shouldShowCloudSandboxOption", () => {
  it("hides cloud sandbox when the experiment is off and cloud is not active", () => {
    expect(
      shouldShowCloudSandboxOption({
        runtimeMode: "host",
        cloudSandboxExperimentEnabled: false,
      }),
    ).toBe(false);
  });

  it("shows cloud sandbox when the experiment is enabled", () => {
    expect(
      shouldShowCloudSandboxOption({
        runtimeMode: "host",
        cloudSandboxExperimentEnabled: true,
      }),
    ).toBe(true);
  });

  it("keeps cloud sandbox visible when cloud mode is already active", () => {
    expect(
      shouldShowCloudSandboxOption({
        runtimeMode: "cloud",
        cloudSandboxExperimentEnabled: false,
      }),
    ).toBe(true);
  });
});

describe("dockerModePresentation", () => {
  it("hides an unavailable inactive mode and exposes diagnostics", () => {
    expect(
      dockerModePresentation({ available: false, selected: false }),
    ).toEqual({
      showOption: false,
      showDiagnostics: true,
    });
  });

  it("keeps an already-selected mode visible for recovery", () => {
    expect(
      dockerModePresentation({ available: false, selected: true }),
    ).toEqual({
      showOption: true,
      showDiagnostics: true,
    });
  });
});
