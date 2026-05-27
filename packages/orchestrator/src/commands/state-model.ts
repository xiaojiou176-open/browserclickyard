import { existsSync } from "node:fs";
import { loadYamlFile } from "../../../core/src/config/loadYaml.js";
import type { CaptureStateInput } from "./capture.js";

type RawStateConfig = {
  routes?: Array<{ id: string; path: string; source?: "routes" | "manual" }>;
  stories?: Array<{ id: string; path: string; source?: "stories" }>;
};

export type StateModel = {
  configuredRoutes: CaptureStateInput[];
  configuredStories: CaptureStateInput[];
  configuredTotal: number;
};

export function loadStateModel(configPath = "configs/states/routes.yaml"): StateModel {
  if (!existsSync(configPath)) {
    return {
      configuredRoutes: [{ id: "route_home", path: "/", source: "routes" }],
      configuredStories: [],
      configuredTotal: 1,
    };
  }

  const raw = loadYamlFile<RawStateConfig>(configPath);
  const configuredRoutes = (raw.routes ?? []).map((item) => ({
    id: item.id,
    path: item.path,
    source: item.source ?? "routes",
  }));
  const configuredStories = (raw.stories ?? []).map((item) => ({
    id: item.id,
    path: item.path,
    source: item.source ?? "stories",
  }));

  const routes =
    configuredRoutes.length > 0
      ? configuredRoutes
      : [{ id: "route_home", path: "/", source: "routes" as const }];
  const total = routes.length + configuredStories.length;

  return {
    configuredRoutes: routes,
    configuredStories,
    configuredTotal: total,
  };
}
