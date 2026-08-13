import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop integration test isolation", () => {
  it("runs resource-owning integration files serially in fresh isolated forks", () => {
    const config = fs.readFileSync(
      path.resolve(process.cwd(), "vitest.config.ts"),
      "utf8",
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const integrationProject = config.slice(
      config.indexOf('name: "integration"'),
    );

    expect(integrationProject).toContain('pool: "forks"');
    expect(integrationProject).toMatch(/forks:\s*\{\s*isolate:\s*true\s*\}/u);
    expect(integrationProject).toContain("testTimeout: 30_000");
    expect(integrationProject).not.toContain("singleFork");
    expect(packageJson.scripts?.["test:unit"]).toContain(
      "vitest run --project unit",
    );
    expect(packageJson.scripts?.["test:unit"]).toContain(
      "E2E_TEST_BUILD=true vitest run --project integration --no-file-parallelism",
    );
  });
});
