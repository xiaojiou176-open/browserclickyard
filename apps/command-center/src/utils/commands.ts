import type { Command, CommandCategory } from "../types";

export const categoryMeta: Record<CommandCategory, { label: string; className: string }> = {
  init: { label: "Init", className: "cat-init" },
  pipeline: { label: "Pipeline", className: "cat-pipeline" },
  frontend: { label: "Frontend", className: "cat-frontend" },
  automation: { label: "Automation", className: "cat-automation" },
  maintenance: { label: "Maintenance", className: "cat-maintenance" },
  backend: { label: "Backend", className: "cat-backend" },
};

export function guessCategory(command: Command): CommandCategory {
  const all = [command.command_id, command.title, ...command.tags].join(" ").toLowerCase();
  if (all.includes("setup") || all.includes("init")) {
    return "init";
  }
  if (
    all.includes("pipeline") ||
    all.includes("script-pipeline")
  ) {
    return "pipeline";
  }
  if (all.includes("frontend")) {
    return "frontend";
  }
  if (all.includes("backend")) {
    return "backend";
  }
  if (
    all.includes("clean") ||
    all.includes("map") ||
    all.includes("diagnose") ||
    all.includes("maintenance")
  ) {
    return "maintenance";
  }
  return "automation";
}

export function isDangerous(command: Command): boolean {
  const text = `${command.command_id} ${command.title} ${command.description}`.toLowerCase();
  return text.includes("clean") || text.includes("delete");
}

export function isAiCommand(command: Command): boolean {
  return (
    command.tags.some((tag) => tag.toLowerCase() === "ai") ||
    command.command_id.includes("midscene")
  );
}
