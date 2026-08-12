import { describe, expect, it } from "vitest";
import { buildDesktopFaroConfig, installDesktopFaroBundleId } from "./faro";

describe("desktop Faro configuration", () => {
  it("stays disabled without consent or a collector URL", () => {
    expect(buildDesktopFaroConfig({}, true)).toBeNull();
    expect(
      buildDesktopFaroConfig(
        {
          VITE_FARO_URL: "https://faro.example.test/collect/app-key",
          VITE_ZAPP_ENV: "production",
          VITE_ZAPP_RELEASE: "release-42",
          VITE_FARO_BUNDLE_ID: "bundle-42",
        },
        false,
      ),
    ).toBeNull();
  });

  it("uses one release identity for runtime errors and uploaded source maps", () => {
    expect(
      buildDesktopFaroConfig(
        {
          VITE_FARO_URL: "https://faro.example.test/collect/app-key",
          VITE_ZAPP_ENV: "production",
          VITE_ZAPP_RELEASE: "release-42",
          VITE_FARO_BUNDLE_ID: "bundle-42",
        },
        true,
      ),
    ).toEqual({
      url: "https://faro.example.test/collect/app-key",
      app: {
        name: "zapp-desktop",
        namespace: "zapp",
        version: "release-42",
        environment: "production",
      },
      bundleId: "bundle-42",
    });
  });

  it("installs the source-map bundle identity before Faro initializes", () => {
    const target: Record<string, unknown> = {};
    const config = buildDesktopFaroConfig(
      {
        VITE_FARO_URL: "https://faro.example.test/collect/app-key",
        VITE_ZAPP_ENV: "production",
        VITE_ZAPP_RELEASE: "release-42",
        VITE_FARO_BUNDLE_ID: "bundle-42",
      },
      true,
    );
    expect(config).not.toBeNull();

    installDesktopFaroBundleId(config!, target);

    expect(target["__faroBundleId_zapp-desktop"]).toBe("bundle-42");
  });
});
