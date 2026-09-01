import { strict as assert } from "node:assert";
import test from "node:test";

import { Text } from "@earendil-works/pi-tui";
import { createPtcDefinitionRegistry } from "../src/renderer.ts";
import { createPtcTool } from "../src/transport.ts";
import {
	CAPTURED_CORE_RENDER_MARKER,
	createRenderContext,
	DEEP_PROTOTYPE_LEVELS,
	LIMITS,
	MAX_EXPECTED_PROTOTYPE_TRAPS,
	RENDER_WIDTH,
	render,
	rendererCatalogEntry,
	resultWith,
	THEME,
} from "./support/renderer-harness.ts";

test("definition provider uses a null-safe registry for unusual exact names", () => {
	const entries = [
		rendererCatalogEntry("__proto__", {
			renderShell: "self",
			renderCall: () => new Text("prototype custom call", 0, 0),
			renderResult: () => new Text("prototype custom result", 0, 0),
		}),
		rendererCatalogEntry("odd/name", {
			renderCall: () => new Text("odd custom call", 0, 0),
		}),
	];
	const tool = createPtcTool({
		...LIMITS,
		definitionProvider: () => entries,
		createBindings: () => ({}),
	});
	const output = render(
		tool.renderResult(
			resultWith([
				{
					id: 1,
					name: "__proto__",
					args: {},
					status: "ok",
					result: { content: [{ type: "text", text: "generic prototype" }], isError: false },
				},
				{ id: 2, name: "odd/name", args: {}, status: "start" },
			]),
			{ expanded: false, isPartial: true },
			THEME,
			createRenderContext(false),
		),
	);

	assert.match(output, /prototype custom call/);
	assert.match(output, /prototype custom result/);
	assert.match(output, /odd custom call/);
	assert.doesNotMatch(output, /generic prototype/);
});

test("definition providers execute class renderers and inherited data render shells", () => {
	const shellPrototype = Object.create(Object.prototype, {
		renderShell: { configurable: true, value: "self" },
	});
	class PrototypeRenderer {
		renderCall() {
			return new Text("class prototype call", 0, 0);
		}

		renderResult() {
			return new Text("class prototype result", 0, 0);
		}
	}
	Object.setPrototypeOf(PrototypeRenderer.prototype, shellPrototype);
	const entry = rendererCatalogEntry("class-renderer", new PrototypeRenderer());
	const registry = createPtcDefinitionRegistry([entry]);
	const tool = createPtcTool({
		...LIMITS,
		definitionProvider: () => [entry],
		createBindings: () => ({}),
	});
	const component = tool.renderResult(
		resultWith([
			{
				id: 1,
				name: entry.name,
				args: {},
				status: "ok",
				result: { content: [{ type: "text", text: "generic result" }], isError: false },
			},
		]),
		{ expanded: false, isPartial: false },
		THEME,
		createRenderContext(false),
	);
	const output = render(component);
	const callLine = component
		.render(RENDER_WIDTH)
		.find((line) => line.includes("class prototype call"));

	assert.match(output, /class prototype call/);
	assert.match(output, /class prototype result/);
	assert.doesNotMatch(output, /generic result/);
	assert.equal(registry.get(entry.name)?.renderShell, "self");
	assert.ok(callLine?.startsWith("class prototype call"));
});

test("definition projection never invokes own or inherited accessors", () => {
	let ownAccessorCalls = 0;
	let inheritedAccessorCalls = 0;
	const dataPrototype = {
		renderCall: () => new Text("shadowed prototype call", 0, 0),
		renderResult: () => new Text("shadowed prototype result", 0, 0),
		renderShell: "self",
	};
	const accessorPrototype = Object.create(dataPrototype, {
		renderResult: {
			get() {
				inheritedAccessorCalls += 1;
				return dataPrototype.renderResult;
			},
		},
		renderShell: {
			get() {
				inheritedAccessorCalls += 1;
				return dataPrototype.renderShell;
			},
		},
	});
	const definition = Object.create(accessorPrototype, {
		renderCall: {
			get() {
				ownAccessorCalls += 1;
				return dataPrototype.renderCall;
			},
		},
	});
	const entry = rendererCatalogEntry("accessor-chain", definition);
	const tool = createPtcTool({
		...LIMITS,
		definitionProvider: () => [entry],
		createBindings: () => ({}),
	});
	const output = render(
		tool.renderResult(
			resultWith([
				{
					id: 1,
					name: entry.name,
					args: { path: "safe.txt" },
					status: "ok",
					result: { content: [{ type: "text", text: "safe fallback" }], isError: false },
				},
			]),
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	assert.equal(ownAccessorCalls, 0);
	assert.equal(inheritedAccessorCalls, 0);
	assert.match(output, /accessor-chain safe\.txt/);
	assert.match(output, /safe fallback/);
	assert.doesNotMatch(output, /shadowed prototype/);
});

test("definition projection bounds hostile cyclic and deep prototype behavior", () => {
	let cyclicPrototypeTraps = 0;
	let cyclicProxy: object;
	cyclicProxy = new Proxy(
		{},
		{
			getOwnPropertyDescriptor: () => undefined,
			getPrototypeOf() {
				cyclicPrototypeTraps += 1;
				return cyclicProxy;
			},
		},
	);
	let deepPrototypeTraps = 0;
	const createDeepProxy = (): object =>
		new Proxy(
			{},
			{
				getOwnPropertyDescriptor: () => undefined,
				getPrototypeOf() {
					deepPrototypeTraps += 1;
					return createDeepProxy();
				},
			},
		);
	let deepPrototype = {};
	for (let depth = 0; depth < DEEP_PROTOTYPE_LEVELS; depth += 1) {
		deepPrototype = Object.create(deepPrototype);
	}
	const entries = [
		rendererCatalogEntry(
			"descriptor-hostile",
			new Proxy(
				{},
				{
					getOwnPropertyDescriptor() {
						throw new Error("hostile descriptor trap");
					},
				},
			),
		),
		rendererCatalogEntry(
			"prototype-hostile",
			new Proxy(
				{},
				{
					getOwnPropertyDescriptor: () => undefined,
					getPrototypeOf() {
						throw new Error("hostile prototype trap");
					},
				},
			),
		),
		rendererCatalogEntry("prototype-cyclic", cyclicProxy),
		rendererCatalogEntry("prototype-deep-proxy", createDeepProxy()),
		rendererCatalogEntry("prototype-deep-object", deepPrototype),
	];
	const tool = createPtcTool({
		...LIMITS,
		definitionProvider: () => entries,
		createBindings: () => ({}),
	});
	const output = render(
		tool.renderResult(
			resultWith(
				entries.map((entry, index) => ({
					id: index + 1,
					name: entry.name,
					args: { path: `${entry.name}.txt` },
					status: "ok" as const,
					result: {
						content: [{ type: "text" as const, text: `${entry.name} fallback` }],
						isError: false,
					},
				})),
			),
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	for (const entry of entries) {
		assert.match(output, new RegExp(`${entry.name} fallback`));
	}
	assert.ok(cyclicPrototypeTraps <= MAX_EXPECTED_PROTOTYPE_TRAPS);
	assert.ok(deepPrototypeTraps <= MAX_EXPECTED_PROTOTYPE_TRAPS);
});

test("definition providers preserve native factories for core rows", () => {
	const tool = createPtcTool({
		...LIMITS,
		definitionProvider: () => [
			rendererCatalogEntry("read", {
				renderCall: () => new Text(CAPTURED_CORE_RENDER_MARKER, 0, 0),
			}),
		],
		createBindings: () => ({}),
	});
	const output = render(
		tool.renderResult(
			resultWith([{ id: 1, name: "read", args: { path: "native.txt" }, status: "start" }]),
			{ expanded: false, isPartial: true },
			THEME,
			createRenderContext(false),
		),
	);

	assert.match(output, /read native\.txt/);
	assert.doesNotMatch(output, new RegExp(CAPTURED_CORE_RENDER_MARKER));
});

test("malformed captured definitions and renderers use bounded generic fallback", () => {
	let getterCalls = 0;
	const accessorDefinition = Object.defineProperty({}, "renderCall", {
		enumerable: true,
		get() {
			getterCalls += 1;
			return () => new Text("unsafe accessor", 0, 0);
		},
	});
	const hostileDefinition = new Proxy(
		{},
		{
			getOwnPropertyDescriptor() {
				throw new Error("hostile definition");
			},
		},
	);
	const entries = [
		rendererCatalogEntry("accessor", accessorDefinition),
		rendererCatalogEntry("hostile", hostileDefinition),
		rendererCatalogEntry("malformed", { renderCall: "not a function", renderShell: "other" }),
	];
	const tool = createPtcTool({
		...LIMITS,
		definitionProvider: () => entries,
		createBindings: () => ({}),
	});
	const output = render(
		tool.renderResult(
			resultWith(
				entries.map((entry, index) => ({
					id: index + 1,
					name: entry.name,
					args: { path: `${entry.name}.txt` },
					status: "ok" as const,
					result: {
						content: [{ type: "text", text: `${entry.name} fallback result` }],
						isError: false,
					},
				})),
			),
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	assert.equal(getterCalls, 0);
	assert.match(output, /accessor accessor\.txt/);
	assert.match(output, /accessor fallback result/);
	assert.match(output, /hostile hostile\.txt/);
	assert.match(output, /malformed malformed\.txt/);
	assert.doesNotMatch(output, /unsafe accessor/);
});
