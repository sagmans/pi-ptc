import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	loadMaxDispatches,
	loadPresentation,
	parsePresentationArg,
	SHIPPED_PTC_CONFIG,
	savePresentation,
} from "../src/config.ts";

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

test("project maxDispatches wins over user maxDispatches", () => {
	const projectFile = tempFile("project.json");
	const userFile = tempFile("user.json");
	writeFileSync(projectFile, `${JSON.stringify({ maxDispatches: 7 }, null, "\t")}\n`);
	writeFileSync(userFile, `${JSON.stringify({ maxDispatches: 3 }, null, "\t")}\n`);
	assert.equal(
		loadMaxDispatches({
			projectFile,
			userFile,
			fallback: SHIPPED_PTC_CONFIG.maxDispatches,
		}),
		7,
	);
});

test("user maxDispatches wins when project omits it", () => {
	const projectFile = tempFile("project.json");
	const userFile = tempFile("user.json");
	savePresentation(projectFile, "both");
	writeFileSync(userFile, `${JSON.stringify({ maxDispatches: 3 }, null, "\t")}\n`);
	assert.equal(
		loadMaxDispatches({
			projectFile,
			userFile,
			fallback: SHIPPED_PTC_CONFIG.maxDispatches,
		}),
		3,
	);
});

test("invalid maxDispatches values fall back", () => {
	const projectFile = tempFile("bad.json");
	writeFileSync(projectFile, `${JSON.stringify({ maxDispatches: 0 }, null, "\t")}\n`);
	assert.equal(
		loadMaxDispatches({ projectFile, fallback: SHIPPED_PTC_CONFIG.maxDispatches }),
		SHIPPED_PTC_CONFIG.maxDispatches,
	);
});

test("savePresentation keeps maxDispatches", () => {
	const file = tempFile("ptc.json");
	writeFileSync(
		file,
		`${JSON.stringify({ presentation: "native", maxDispatches: 7 }, null, "\t")}\n`,
	);
	savePresentation(file, "both");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
		presentation: "both",
		maxDispatches: 7,
	});
});
