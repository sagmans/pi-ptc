import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMaxDispatches, SHIPPED_PTC_CONFIG } from "../src/config.ts";

function tempFile(name: string): string {
	return join(mkdtempSync(join(tmpdir(), "pi-ptc-")), name);
}

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
	writeFileSync(projectFile, "{}\n");
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
