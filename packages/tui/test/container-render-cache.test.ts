import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Spacer } from "../src/components/spacer.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { LAYOUT_NODE } from "../src/layout-node.ts";
import { type Component, Container, type TuiMouseEvent, type TuiMouseEventResult } from "../src/tui.ts";
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

/** StableLines that records the local row of each mouse event it receives. */
class ClickableLines extends StableLines {
	clickedRows: number[] = [];
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		this.clickedRows.push(event.y);
		return { handled: true };
	}
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

	it("renders each child once when a middle child changes and routes mouse events by the new heights", () => {
		const first = new StableLines(["a"]);
		const middle = new StableLines(["b"]);
		const last = new ClickableLines(["c"]);
		const container = new Container();
		container.addChild(first);
		container.addChild(middle);
		container.addChild(last);
		container.render(10);

		middle.lines = ["b1", "b2"];
		assert.deepStrictEqual(container.render(10), ["a", "b1", "b2", "c"]);
		assert.deepStrictEqual([first.renders, middle.renders, last.renders], [2, 2, 2]);

		container.handleMouse({
			type: "click",
			button: "left",
			x: 0,
			y: 3,
			screenX: 0,
			screenY: 3,
			width: 10,
			height: 4,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.deepStrictEqual(last.clickedRows, [0]);
	});

	it("routes each row to the child that renders it, skipping zero-height children", () => {
		const children = [
			new ClickableLines([]),
			new ClickableLines(["a1", "a2"]),
			new ClickableLines([]),
			new ClickableLines(["b1"]),
			new ClickableLines(["c1", "c2", "c3"]),
			new ClickableLines([]),
		];
		const container = new Container();
		for (const child of children) container.addChild(child);
		container.render(10);

		const results = [0, 1, 2, 3, 4, 5, 6].map((y) =>
			container.handleMouse({
				type: "click",
				button: "left",
				x: 0,
				y,
				screenX: 0,
				screenY: y,
				width: 10,
				height: 7,
				shift: false,
				alt: false,
				ctrl: false,
			}),
		);
		assert.deepStrictEqual(
			children.map((child) => child.clickedRows),
			[[], [0, 1], [], [0], [0, 1, 2], []],
		);
		assert.strictEqual(results[6], undefined);
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

describe("VStack render cache", () => {
	it("keeps a large scroll Container stable while rendering every nested child", () => {
		const document = new Container();
		const children = Array.from({ length: 9 }, (_, index) => new StableLines([`${index}`]));
		for (const child of children) document.addChild(new VStack([new VStack([child])]));
		const scroll = new ScrollView(document, { scrollbar: "hidden" });
		const first = renderLayoutFrame(scroll, 20, 3, () => {});
		const second = renderLayoutFrame(scroll, 20, 3, () => {});
		assert.strictEqual(second.root.scrollContentLines, first.root.scrollContentLines);
		assert.ok(children.every((child) => child.renders === 2));

		children[0]!.lines = ["changed", "extra"];
		const changed = renderLayoutFrame(scroll, 20, 3, () => {});
		assert.notStrictEqual(changed.root.scrollContentLines, first.root.scrollContentLines);
		assert.deepStrictEqual(changed.lines, ["changed", "extra", "1"]);
		assert.deepStrictEqual(
			first.root.scrollContentLines,
			children.map((_, index) => `${index}`),
		);
	});

	it("rebuilds for replaced arrays, in-place growth, width changes, and invalidation", () => {
		const child = new StableLines(["a"]);
		const stack = new VStack([child]);
		let invalidations = 0;
		child.invalidate = () => {
			invalidations++;
		};
		const initial = stack.render(10);
		assert.strictEqual(stack.render(10), initial);
		child.lines = ["b"];
		assert.deepStrictEqual(stack.render(10), ["b"]);
		child.lines.push("c");
		const grown = stack.render(10);
		assert.deepStrictEqual(grown, ["b", "c"]);
		assert.deepStrictEqual(initial, ["a"]);
		assert.notStrictEqual(stack.render(11), grown);
		const resized = stack.render(11);
		stack.invalidate();
		assert.strictEqual(invalidations, 1);
		assert.notStrictEqual(stack.render(11), resized);
	});

	it("tracks visibility, child order, removal, clearing, and entry sizing", () => {
		let visible = true;
		const first = new StableLines(["a", "b"]);
		const second = new StableLines(["c"]);
		const stack = new VStack(
			[
				{ component: first, basis: 1, visible: (viewport) => visible && viewport.width >= 10 },
				{ component: second, minSize: 2 },
			],
			{ gap: 1 },
		);
		const initial = stack.render(10);
		assert.deepStrictEqual(initial, ["a", "", "c", ""]);
		assert.strictEqual(stack.render(10), initial);
		visible = false;
		assert.deepStrictEqual(stack.render(10), ["c", ""]);
		visible = true;
		assert.deepStrictEqual(stack.render(10), initial);
		assert.deepStrictEqual(stack.render(9), ["c", ""]);
		assert.deepStrictEqual(stack.render(10), initial);
		const entries = stack[LAYOUT_NODE]().entries;
		entries[0]!.basis = 2;
		assert.deepStrictEqual(stack.render(10), ["a", "b", "", "c", ""]);
		stack.removeChild(first);
		stack.addChild(first);
		assert.deepStrictEqual(stack.render(10), ["c", "", "", "a", "b"]);
		stack.clear();
		const empty = stack.render(10);
		assert.deepStrictEqual(empty, []);
		assert.strictEqual(stack.render(10), empty);
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
