import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type LockfilePackage = {
  resolved?: string;
};

test("lockfile dependencies use the public npm registry", async () => {
  const contents = await readFile(new URL("../package-lock.json", import.meta.url), "utf8");
  const lockfile = JSON.parse(contents) as { packages?: Record<string, LockfilePackage> };

  for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
    if (metadata.resolved === undefined) continue;

    assert.equal(
      new URL(metadata.resolved).origin,
      "https://registry.npmjs.org",
      `${packagePath} must resolve from the public npm registry`,
    );
  }
});
