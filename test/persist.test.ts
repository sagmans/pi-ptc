import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPresentation, parsePresentationArg, savePresentation } from "../src/config.ts";

function tempFile(name: string): string {
	return join(mkdtempSync(join(tmpdir(), "pi-ptc-")), name);
}

test("project presentation wins over user presentation", () => {
	const projectFile = tempFile("project.json");
	const userFile = tempFile("user.json");
	savePresentation(projectFile, "both");
	savePresentation(userFile, "native");
	assert.equal(loadPresentation({ projectFile, userFile, fallback: "code" }), "both");
});

test("user presentation wins when project file is absent", () => {
	const userFile = tempFile("user.json");
	savePresentation(userFile, "native");
	assert.equal(
		loadPresentation({
			projectFile: join(tmpdir(), "pi-ptc-missing", "ptc.json"),
			userFile,
			fallback: "code",
		}),
		"native",
	);
});

test("invalid presentation files fall back", () => {
	const projectFile = tempFile("bad.json");
	writeFileSync(projectFile, "{}\n");
	assert.equal(loadPresentation({ projectFile, fallback: "code" }), "code");
});

test("parsePresentationArg maps on both off and cycle", () => {
	assert.equal(parsePresentationArg("on"), "code");
	assert.equal(parsePresentationArg("both"), "both");
	assert.equal(parsePresentationArg("off"), "native");
	assert.equal(parsePresentationArg(""), "cycle");
	assert.equal(parsePresentationArg("nope"), undefined);
});
