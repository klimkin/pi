import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Spacer } from "../src/components/spacer.ts";
import { Text } from "../src/components/text.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Leaf that returns a stable array until replaced, like Text or Markdown. */
class StableLines implements Component {
	lines: string[];
	renders = 0;
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		this.renders += 1;
		return this.lines;
	}
	invalidate(): void {}
}

describe("Container render cache", () => {
	it("returns the same array while every child returns the same array", () => {
		const first = new StableLines(["a", "b"]);
		const second = new StableLines(["c"]);
		const container = new Container();
		container.addChild(first);
		container.addChild(second);

		const lines = container.render(10);
		assert.deepStrictEqual(lines, ["a", "b", "c"]);
		assert.strictEqual(container.render(10), lines);
		// Children still render every time, so their changes are detected.
		assert.strictEqual(first.renders, 2);
	});

	it("rebuilds when a child returns a new array, children change, or the width changes", () => {
		const child = new StableLines(["a"]);
		const container = new Container();
		container.addChild(child);
		const initial = container.render(10);

		child.lines = ["b"];
		const replaced = container.render(10);
		assert.notStrictEqual(replaced, initial);
		assert.deepStrictEqual(replaced, ["b"]);

		const added = new StableLines(["c"]);
		container.addChild(added);
		assert.deepStrictEqual(container.render(10), ["b", "c"]);

		container.removeChild(added);
		assert.deepStrictEqual(container.render(10), ["b"]);

		const widthChanged = container.render(11);
		assert.notStrictEqual(widthChanged, container.render(10));
	});

	it("rebuilds when a child grows the array it returned before", () => {
		const child = new StableLines(["a"]);
		const container = new Container();
		container.addChild(child);
		container.render(10);

		child.lines.push("b");
		assert.deepStrictEqual(container.render(10), ["a", "b"]);
	});

	it("rebuilds after invalidate", () => {
		const container = new Container();
		container.addChild(new StableLines(["a"]));
		const lines = container.render(10);
		container.invalidate();
		assert.notStrictEqual(container.render(10), lines);
	});

	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		it(`clears ${Renderer.name}'s inherited cache even when child arrays stay stable`, () => {
			const tui = new Renderer(new VirtualTerminal(20, 3));
			let invalidations = 0;
			const lines = ["stable"];
			tui.addChild({
				render: () => lines,
				invalidate: () => {
					invalidations++;
				},
			});
			const initial = tui.render(20);
			assert.strictEqual(tui.render(20), initial);
			tui.invalidate();
			assert.strictEqual(invalidations, 1);
			const refreshed = tui.render(20);
			assert.notStrictEqual(refreshed, initial);
			assert.deepStrictEqual(refreshed, initial);
			assert.strictEqual(tui.render(20), refreshed);
		});
	}

	it("keeps nested unchanged containers stable", () => {
		const message = new Container();
		message.addChild(new Spacer(1));
		message.addChild(new Text("hello", 0, 0));
		const document = new Container();
		document.addChild(message);

		const lines = document.render(20);
		assert.strictEqual(document.render(20), lines);
	});
});

describe("Spacer", () => {
	it("returns a stable array until the line count changes", () => {
		const spacer = new Spacer(2);
		const lines = spacer.render(10);
		assert.deepStrictEqual(lines, ["", ""]);
		assert.strictEqual(spacer.render(20), lines);
		spacer.setLines(1);
		assert.deepStrictEqual(spacer.render(10), [""]);
	});
});

describe("Box render cache", () => {
	it("returns the same array while children return the same arrays", () => {
		const child = new StableLines(["a"]);
		const box = new Box(1, 0);
		box.addChild(child);
		const lines = box.render(10);
		assert.strictEqual(box.render(10), lines);

		child.lines = ["b"];
		const changed = box.render(10);
		assert.notStrictEqual(changed, lines);
		assert.deepStrictEqual(changed, [" b        "]);
	});

	it("reuses padded lines when a child returns equal lines in a new array", () => {
		const child = new StableLines(["a"]);
		const box = new Box(1, 0);
		box.addChild(child);
		const lines = box.render(10);
		child.lines = ["a"];
		assert.strictEqual(box.render(10), lines);
	});
});
