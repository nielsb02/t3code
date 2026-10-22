import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3ProjectFile } from "./t3ProjectFile.ts";

const decode = Schema.decodeUnknownSync(T3ProjectFile);

describe("T3ProjectFile", () => {
  it("trims repository paths and rejects blank or overlong entries", () => {
    expect(decode({ repositories: { paths: ["  projects/app  "] } }).repositories?.paths).toEqual([
      "projects/app",
    ]);
    expect(() => decode({ repositories: { paths: ["   "] } })).toThrow();
    expect(() => decode({ repositories: { paths: ["x".repeat(513)] } })).toThrow();
  });
});
