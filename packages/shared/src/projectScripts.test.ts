import { ProjectId, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { settleProjectScripts } from "./projectScripts.ts";

const cleanup: ProjectScript = {
  id: "cleanup",
  name: "Cleanup",
  command: "cleanup",
  icon: "configure",
  runOnWorktreeCreate: false,
  runOnThreadSettle: true,
};
const project = { id: ProjectId.make("project"), scripts: [cleanup] };
const settings = {
  defaultProjectScripts: [cleanup],
  projectScriptOverrides: {},
  projectSettingsOverrides: {},
  projectSettingsFolded: true,
};

describe("settlement script opt-in after settings migration", () => {
  it("uses the explicit project setting for an imported project", () => {
    expect(
      settleProjectScripts(
        {
          ...settings,
          projectSettingsOverrides: { [project.id]: { defaultProjectScripts: [cleanup] } },
        },
        { ...project, scripts: [] },
      ),
    ).toEqual([cleanup]);
  });

  it("honors an explicit empty project override over legacy scripts", () => {
    expect(
      settleProjectScripts(
        {
          ...settings,
          projectSettingsFolded: false,
          projectScriptOverrides: { [project.id]: [cleanup] },
          projectSettingsOverrides: { [project.id]: { defaultProjectScripts: [] } },
        },
        project,
      ),
    ).toEqual([]);
  });

  it("never restores legacy or machine cleanup after settings have been folded", () => {
    expect(settleProjectScripts(settings, project)).toEqual([]);
    expect(
      settleProjectScripts(
        { ...settings, projectScriptOverrides: { [project.id]: [cleanup] } },
        project,
      ),
    ).toEqual([]);
  });

  it("preserves legacy project opt-in and reset semantics before the fold", () => {
    expect(settleProjectScripts({ ...settings, projectSettingsFolded: false }, project)).toEqual([
      cleanup,
    ]);
    expect(
      settleProjectScripts(
        {
          ...settings,
          projectSettingsFolded: false,
          projectScriptOverrides: { [project.id]: null },
        },
        project,
      ),
    ).toEqual([]);
  });
});
