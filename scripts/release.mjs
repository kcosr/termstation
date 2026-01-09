#!/usr/bin/env node
/**
 * Release script for termstation
 *
 * Usage: node scripts/release.mjs <major|minor|patch>
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Bump VERSION file
 * 3. Update CHANGELOG.md: [Unreleased] -> [version] - date
 * 4. Commit and tag
 * 5. Push to remote
 * 6. Create GitHub release with notes from CHANGELOG
 * 7. Add new [Unreleased] section
 * 8. Commit and push
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const BUMP_TYPE = process.argv[2];

if (!["major", "minor", "patch"].includes(BUMP_TYPE)) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, {
			encoding: "utf-8",
			stdio: options.silent ? "pipe" : "inherit",
			cwd: ROOT,
			...options,
		});
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	return readFileSync(join(ROOT, "VERSION"), "utf-8").trim();
}

function updateChangelogForRelease(version) {
	const changelogPath = join(ROOT, "CHANGELOG.md");
	const date = new Date().toISOString().split("T")[0];
	let content = readFileSync(changelogPath, "utf-8");

	if (!content.includes("## [Unreleased]")) {
		console.error("Error: No [Unreleased] section found in CHANGELOG.md");
		process.exit(1);
	}

	// Replace [Unreleased] with the version
	content = content.replace(
		/## \[Unreleased\]\n\n_No unreleased changes._/,
		`## [${version}] - ${date}`
	);
	content = content.replace(
		/## \[Unreleased\]/,
		`## [${version}] - ${date}`
	);

	writeFileSync(changelogPath, content);
	console.log(`  Updated CHANGELOG.md: [Unreleased] -> [${version}] - ${date}`);
}

function extractReleaseNotes(version) {
	const changelogPath = join(ROOT, "CHANGELOG.md");
	const content = readFileSync(changelogPath, "utf-8");

	// Extract content between this version header and the next version header
	const versionEscaped = version.replace(/\./g, "\\.");
	const regex = new RegExp(
		`## \\[${versionEscaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`
	);
	const match = content.match(regex);

	if (!match) {
		console.error(`Error: Could not extract release notes for v${version}`);
		process.exit(1);
	}

	return match[1].trim();
}

function addUnreleasedSection() {
	const changelogPath = join(ROOT, "CHANGELOG.md");
	let content = readFileSync(changelogPath, "utf-8");

	const unreleasedSection = "## [Unreleased]\n\n_No unreleased changes._\n\n";

	// Insert after "# Changelog\n\n"
	content = content.replace(/^(# Changelog\n\n)/, `$1${unreleasedSection}`);

	writeFileSync(changelogPath, content);
	console.log("  Added [Unreleased] section to CHANGELOG.md");
}

// Main flow
console.log("\n=== Release Script ===\n");

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Bump version
console.log(`Bumping version (${BUMP_TYPE})...`);
run(`node scripts/bump-version.js ${BUMP_TYPE}`);
const version = getVersion();
console.log(`  New version: ${version}\n`);

// 3. Update changelog
console.log("Updating CHANGELOG.md...");
updateChangelogForRelease(version);
console.log();

// 4. Commit and tag
console.log("Committing and tagging...");
run("git add .");
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 5. Push
console.log("Pushing to remote...");
run("git push");
run(`git push origin v${version}`);
console.log();

// 6. Create GitHub release
console.log("Creating GitHub release...");
const releaseNotes = extractReleaseNotes(version);
const notesFile = join(ROOT, ".release-notes-tmp.md");
writeFileSync(notesFile, releaseNotes);
run(`gh release create v${version} --prerelease --title "v${version}" --notes-file "${notesFile}"`);
run(`rm "${notesFile}"`);
console.log();

// 7. Add new [Unreleased] section
console.log("Adding [Unreleased] section for next cycle...");
addUnreleasedSection();
console.log();

// 8. Commit and push
console.log("Committing changelog update...");
run("git add CHANGELOG.md");
run('git commit -m "Prepare for next release"');
run("git push");
console.log();

console.log(`=== Released v${version} ===`);
console.log(`https://github.com/kcosr/termstation/releases/tag/v${version}`);
