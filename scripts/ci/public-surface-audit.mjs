#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const options = {
    repo: process.env.GITHUB_REPOSITORY || "",
    outDir: ".runtime-cache/artifacts/ci",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--repo" && next) {
      options.repo = next;
      index += 1;
      continue;
    }
    if (token === "--out-dir" && next) {
      options.outDir = next;
      index += 1;
    }
  }

  return options;
}

function runGhJson(args) {
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function hasGhAuthSession() {
  try {
    execFileSync("gh", ["auth", "status"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function parseRepoSlug(repo) {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) {
    return null;
  }
  return { owner, name };
}

function writeArtifacts(outDir, payload) {
  mkdirSync(resolve(outDir), { recursive: true });
  const jsonPath = resolve(outDir, "public-surface-audit.json");
  const mdPath = resolve(outDir, "public-surface-audit.md");

  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const lines = [
    "# Public Surface Audit",
    "",
    `- Status: \`${payload.status}\``,
    `- Repo: \`${payload.repo || "unknown"}\``,
    `- Reason: ${payload.reason || "_none_"}`,
    "",
    "## GitHub API / GraphQL-readable Signals",
    "",
    `- Visibility: \`${payload.repo_metadata.visibility}\``,
    `- Description: ${payload.repo_metadata.description || "_none_"}`,
    `- Homepage: ${payload.repo_metadata.homepage || "_none_"}`,
    `- Topics: ${payload.repo_metadata.topics.length > 0 ? payload.repo_metadata.topics.map((topic) => `\`${topic}\``).join(", ") : "_none_"}`,
    `- Discussions enabled: \`${payload.repo_metadata.has_discussions}\``,
    `- Release present: \`${payload.repo_metadata.release_present}\``,
    `- Social preview: \`${payload.repo_metadata.social_preview_status}\``,
    `- Uses custom social preview: \`${payload.repo_metadata.uses_custom_open_graph_image}\``,
    `- Open Graph image URL: \`${payload.repo_metadata.open_graph_image_url || "_none_"}\``,
    "",
    "## Notes",
    "",
    ...payload.notes.map((note) => `- ${note}`),
    "",
  ];

  writeFileSync(mdPath, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = {
    status: "blocked",
    reason: "",
    repo: options.repo,
    repo_metadata: {
      visibility: "unknown",
      description: "",
      homepage: "",
      topics: [],
      has_discussions: "unknown",
      release_present: "unknown",
      social_preview_status: "manual_verification_required",
      uses_custom_open_graph_image: "unknown",
      open_graph_image_url: "",
    },
    notes: [
      "GitHub social preview upload or replacement still requires GitHub Settings > General > Social preview.",
    ],
  };

  if (!options.repo) {
    payload.reason = "missing_repo";
    payload.notes.push("No repository slug was provided to the audit script.");
    writeArtifacts(options.outDir, payload);
    return;
  }

  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && !hasGhAuthSession()) {
    payload.reason = "missing_auth";
    payload.notes.push("No GH_TOKEN, GITHUB_TOKEN, or authenticated gh session was available for this audit run.");
    writeArtifacts(options.outDir, payload);
    return;
  }

  try {
    const repoParts = parseRepoSlug(options.repo);
    const repoInfo = runGhJson(["api", "-H", "Accept: application/vnd.github+json", `repos/${options.repo}`]);
    let releasePresent = "false";
    let openGraphImageUrl = "";
    let usesCustomOpenGraphImage = "unknown";

    try {
      const releases = runGhJson([
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${options.repo}/releases?per_page=1`,
      ]);
      releasePresent = Array.isArray(releases) && releases.length > 0 ? "true" : "false";
    } catch {
      releasePresent = "unknown";
      payload.notes.push("Release presence could not be confirmed through the releases API in this audit run.");
    }

    if (repoParts) {
      try {
        const graph = runGhJson([
          "api",
          "graphql",
          "-f",
          "query=query($owner:String!, $name:String!) { repository(owner:$owner, name:$name) { openGraphImageUrl usesCustomOpenGraphImage } }",
          "-F",
          `owner=${repoParts.owner}`,
          "-F",
          `name=${repoParts.name}`,
        ]);
        openGraphImageUrl = graph?.data?.repository?.openGraphImageUrl || "";
        usesCustomOpenGraphImage = String(
          graph?.data?.repository?.usesCustomOpenGraphImage ?? "unknown",
        );
      } catch {
        payload.notes.push(
          "GraphQL social preview query failed in this audit run, so custom-social-preview state remains unknown.",
        );
      }
    } else {
      payload.notes.push("Repository slug could not be split into owner/name for GraphQL social preview queries.");
    }

    payload.status = "completed";
    payload.repo_metadata = {
      visibility: repoInfo?.private === true ? "private" : "public",
      description: repoInfo?.description || "",
      homepage: repoInfo?.homepage || "",
      topics: Array.isArray(repoInfo?.topics) ? repoInfo.topics : [],
      has_discussions: String(repoInfo?.has_discussions ?? "unknown"),
      release_present: releasePresent,
      social_preview_status:
        usesCustomOpenGraphImage === "true"
          ? "custom_image_configured"
          : usesCustomOpenGraphImage === "false"
            ? "default_repo_card_only"
            : "unknown",
      uses_custom_open_graph_image: usesCustomOpenGraphImage,
      open_graph_image_url: openGraphImageUrl,
    };
    payload.notes.push(
      "Use this artifact to distinguish API-readable GitHub metadata from settings that still require GitHub Settings mutations.",
    );
    if (usesCustomOpenGraphImage === "false") {
      payload.notes.push(
        "The repo currently uses the default generated Open Graph card and does not have a custom social preview image configured.",
      );
    }
  } catch (error) {
    payload.reason = "github_api_failed";
    payload.notes.push(
      error instanceof Error ? `GitHub API query failed: ${error.message}` : "GitHub API query failed.",
    );
  }

  writeArtifacts(options.outDir, payload);
}

main();
