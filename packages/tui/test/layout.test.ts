import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getLayoutBoxesAt, getScrollViewBox, renderLayoutFrame } from "../src/layout.ts";
import { encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
import { type Component, Container } from "../src/tui.ts";
import { stripTerminalSequences } from "../src/utils.ts";

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

function fixedLines(lines: string[]): Component {
	return { render: () => lines, invalidate: () => {} };
}

/** Renders like a plain Container but as one leaf, so layout cannot stack it. */
function asLeaf(container: Container): Component {
	return { render: (width) => container.render(width), invalidate: () => {} };
}

function transcriptDocument(imageLine: string): Container {
	const message = new Container();
	message.addChild(fixedLines(["message 1", "message 2"]));
	message.addChild(new VStack([fixedLines(["stacked a"]), fixedLines(["stacked b"])], { gap: 1 }));
	const document = new Container();
	document.addChild(fixedLines(["header"]));
	document.addChild(message);
	document.addChild(fixedLines([imageLine, "", ""]));
	document.addChild(fixedLines(["tail 1", "tail 2", "tail 3"]));
	return document;
}

describe("viewport layout", () => {
	it("measures stack and scroll subclasses through their overridden render", () => {
		let calls = 0;
		class ExtraRowVStack extends VStack {
			override render(width: number): string[] {
				calls++;
				return [...super.render(width), "extra"];
			}
		}
		class ExtraRowHStack extends HStack {
			override render(width: number): string[] {
				calls++;
				return [...super.render(width), "extra"];
			}
		}
		class ExtraRowScrollView extends ScrollView {
			override render(width: number): string[] {
				calls++;
				return [...super.render(width), "extra"];
			}
		}
		const cases: [string, () => Component][] = [
			["vstack", () => new ExtraRowVStack([fixedLines(["base"])])],
			["hstack", () => new ExtraRowHStack([fixedLines(["base"])])],
			["scroll", () => new ExtraRowScrollView(fixedLines(["base"]))],
			["vstack of stack", () => new ExtraRowVStack([new VStack([fixedLines(["base"])])])],
			["hstack of stack", () => new ExtraRowHStack([new VStack([fixedLines(["base"])])])],
			["scroll of stack", () => new ExtraRowScrollView(new VStack([fixedLines(["base"])]))],
		];
		for (const [name, make] of cases) {
			calls = 0;
			const frame = renderLayoutFrame(new VStack([make(), fixedLines(["following"])]), 10, 3, () => {});
			assert.strictEqual(calls, 1, name);
			assert.deepStrictEqual(visibleLines(frame.lines), ["base", "", "following"], name);
		}
	});

	it("allocates vertical grow space deterministically", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("top", 0, 0), basis: 1, shrink: 0 },
				{ component: new Text("body", 0, 0), basis: 0, grow: 1 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["top", "body", "", ""]);
	});

	it("does not render fixed-basis scroll content during stack measurement", () => {
		let renderCount = 0;
		const transcript = new ScrollView({
			render: () => {
				renderCount += 1;
				return ["one", "two", "three"];
			},
			invalidate: () => {},
		});
		const root = new VStack([
			{ component: transcript, basis: 0, grow: 1 },
			{ component: new Text("dock", 0, 0), basis: "auto" },
		]);
		renderLayoutFrame(root, 10, 3, () => {});
		assert.strictEqual(renderCount, 1);
	});

	it("renders children of measured nested stacks once per frame", () => {
		const counts = { vstackChild: 0, hstackChild: 0, scrollChild: 0 };
		const counted = (key: keyof typeof counts, line: string) => ({
			render: () => {
				counts[key] += 1;
				return [line];
			},
			invalidate: () => {},
		});
		const dock = new VStack([
			counted("vstackChild", "status"),
			new HStack([counted("hstackChild", "left"), { render: () => ["right"], invalidate: () => {} }], { gap: 1 }),
			new ScrollView(counted("scrollChild", "scrolled"), { scrollbar: "always" }),
		]);
		const root = new VStack([
			{ component: new Text("body", 0, 0), basis: 0, grow: 1 },
			{ component: dock, basis: "auto" },
		]);

		const frame = renderLayoutFrame(root, 20, 5, () => {});

		assert.deepStrictEqual(visibleLines(frame.lines), ["body", "", "status", "left right", "scrolled           ┃"]);
		// The HStack child renders at the full width to measure, then at its allocated width.
		assert.deepStrictEqual(counts, { vstackChild: 1, hstackChild: 2, scrollChild: 1 });
	});

	it("stacks plain Containers in scroll content with the same output as concatenating them", () => {
		const imageId = 125;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		const document = transcriptDocument(imageLine);
		const stacked = new ScrollView(document, { follow: "end" });
		const leaf = new ScrollView(asLeaf(document), { follow: "end" });

		// Follow-end puts the image's first two rows above the viewport, exercising the top crop.
		for (const scrollTop of [undefined, 0, 2, 7]) {
			if (scrollTop !== undefined) {
				stacked.scrollTo(scrollTop);
				leaf.scrollTo(scrollTop);
			}
			const stackedFrame = renderLayoutFrame(stacked, 20, 4, () => {});
			const leafFrame = renderLayoutFrame(leaf, 20, 4, () => {});
			assert.deepStrictEqual(stackedFrame.lines, leafFrame.lines, `scrollTop ${stacked.scrollTop}`);
			assert.deepStrictEqual(
				getScrollViewBox(stackedFrame, stacked)?.scrollContentLines,
				getScrollViewBox(leafFrame, leaf)?.scrollContentLines,
			);
			assert.strictEqual(stackedFrame.root.children[0]?.stacked, true);
		}
		stacked.scrollTo(8);
		assert.ok(renderLayoutFrame(stacked, 20, 4, () => {}).lines[0]?.includes("\x1b_G"));
	});

	it("hit-tests children of stacked scroll content as separate boxes", () => {
		const document = transcriptDocument("image");
		const frame = renderLayoutFrame(new ScrollView(document), 20, 12, () => {});
		const path = getLayoutBoxesAt(frame, 0, 2);
		// Only the scroll content is stacked; the message container below it stays one leaf box.
		assert.strictEqual(path[0]?.component, document.children[1]);
		assert.strictEqual(path[0]?.stacked, undefined);
		assert.deepStrictEqual(visibleLines([...(path[0]?.lines ?? [])]), [
			"message 1",
			"message 2",
			"stacked a",
			"",
			"stacked b",
		]);
		assert.strictEqual(path[1]?.component, document);
		assert.strictEqual(path[1]?.stacked, true);
	});

	it("keeps plain Containers with an allocated height as clipped leaves", () => {
		const container = new Container();
		container.addChild(fixedLines(["one", "two", "three"]));
		const frame = renderLayoutFrame(new VStack([{ component: container, basis: 2 }]), 10, 2, () => {});
		assert.strictEqual(frame.root.children[0]?.stacked, undefined);
		assert.deepStrictEqual(visibleLines(frame.lines), ["one", "two"]);
	});

	it("paints only clipped rows from very large scroll content", () => {
		const lineCount = 1_000_000_000;
		const lines: string[] = [];
		lines.length = lineCount;
		lines[lineCount - 4] = "before";
		lines[lineCount - 3] = "visible 1";
		lines[lineCount - 2] = "visible 2";
		lines[lineCount - 1] = "visible 3";
		const transcript = new ScrollView(
			{
				render: () => lines,
				invalidate: () => {},
			},
			{ follow: "end" },
		);

		const frame = renderLayoutFrame(transcript, 10, 3, () => {});
		assert.deepStrictEqual(visibleLines(frame.lines), ["visible 1", "visible 2", "visible 3"]);
	});

	it("shrinks entries to their minimum sizes", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("a1\na2\na3", 0, 0), shrink: 1, minSize: 1 },
				{ component: new Text("b1\nb2\nb3", 0, 0), shrink: 0 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["a1", "b1", "b2", "b3"]);
	});

	it("includes nested minimum sizes in intrinsic stack measurement", () => {
		const dock = new VStack([
			new Text("top1\ntop2\ntop3", 0, 0),
			{ component: new Text("selector", 0, 0), minSize: 3 },
			new Text("below", 0, 0),
			{ component: new Text("footer", 0, 0), minSize: 1 },
		]);
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("body", 0, 0), basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
			10,
			9,
			() => {},
		);

		assert.deepStrictEqual(visibleLines(frame.lines), [
			"body",
			"top1",
			"top2",
			"top3",
			"selector",
			"",
			"",
			"below",
			"footer",
		]);
	});

	it("omits gaps around invisible entries", () => {
		const stack = new VStack(
			[new Text("one", 0, 0), { component: new Text("hidden", 0, 0), visible: () => false }, new Text("two", 0, 0)],
			{ gap: 1 },
		);
		assert.deepStrictEqual(
			stack.render(10).map((line) => line.trimEnd()),
			["one", "", "two"],
		);
	});

	it("crops Kitty images at a scroll view's lower boundary", () => {
		const imageId = 124;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		const transcript = new ScrollView({
			render: () => ["one", "two", imageLine, "", ""],
			invalidate: () => {},
		});
		const frame = renderLayoutFrame(
			new VStack([{ component: transcript, basis: 0, grow: 1 }, new Text("dock", 0, 0)]),
			20,
			4,
			() => {},
		);

		assert.ok(frame.lines[2]?.includes("y=0,h=34,r=1"));
	});

	it("composes horizontal children at allocated widths", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("left", 0, 0), basis: 6, shrink: 0 },
				{ component: new Text("right", 0, 0), basis: 6, shrink: 0 },
			]),
			12,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["left  right"]);
	});

	it("does not paint zero-width horizontal children", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("hidden", 0, 0), basis: 0, shrink: 0 },
				{ component: new Text("shown", 0, 0), basis: 0, grow: 1 },
			]),
			5,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["shown"]);
	});

	it("tracks follow-end state and returns unused scroll delta", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0), {
			follow: "end",
			primary: true,
		});
		renderLayoutFrame(scrollView, 10, 3, () => {});
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);

		assert.strictEqual(scrollView.scrollBy(-2), 0);
		assert.strictEqual(scrollView.scrollTop, 1);
		assert.strictEqual(scrollView.isFollowingEnd, false);
		assert.strictEqual(scrollView.scrollBy(-3), -2);
		assert.strictEqual(scrollView.scrollTop, 0);
		assert.strictEqual(scrollView.scrollBy(10), 7);
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);
	});

	it("renders a proportional glyph scrollbar with an expanded active thumb", async () => {
		const sourceLines = ["abcd界", "abcde2", "abcde3", "abcde4", "abcde5", "abcde6", "abcde7", "abcde8"];
		const contentBackground = "\x1b[42m";
		const trackColor = "\x1b[38;5;2m";
		const thumbColor = "\x1b[38;5;1m";
		const scrollbarTrackStyle = (text: string) => `${trackColor}${text}\x1b[39m`;
		const scrollbarThumbStyle = (text: string) => `${thumbColor}${text}\x1b[39m`;
		const content = new Text(sourceLines.join("\n"), 0, 0, (text) => `${contentBackground}${text}\x1b[49m`);
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
			scrollbarHideDelayMs: 10,
		});
		const render = () => renderLayoutFrame(scrollView, 6, 4, () => {}).lines;
		const visible = (lines: string[]) => lines.map(stripTerminalSequences);

		let lines = render();
		assert.deepStrictEqual(visible(lines), sourceLines.slice(0, 4));

		scrollView.scrollBy(2);
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde┃", "abcde┃", "abcde│"]);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(trackColor)),
			[true, false, false, true],
		);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(thumbColor)),
			[false, true, true, false],
		);

		scrollView.setScrollbarActive(true);
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde█", "abcde█", "abcde│"]);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(thumbColor)),
			[false, true, true, false],
		);
		assert.ok(lines[1]!.lastIndexOf(contentBackground) < lines[1]!.lastIndexOf(thumbColor));

		scrollView.setScrollbarActive(false);
		await new Promise((resolve) => setTimeout(resolve, 30));
		lines = render();
		assert.deepStrictEqual(visible(lines), sourceLines.slice(2, 6));

		scrollView.scrollToEnd();
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde│", "abcde┃", "abcde┃"]);

		scrollView.scrollToStart();
		lines = render();
		assert.strictEqual(visible(lines)[0], "abcd ┃");

		const followedContent = new Text(sourceLines.join("\n"), 0, 0);
		const followed = new ScrollView(followedContent, {
			follow: "end",
			scrollbar: "auto",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
		});
		renderLayoutFrame(followed, 6, 4, () => {});
		assert.strictEqual(followed.scrollTop, 4);
		followedContent.setText(`${sourceLines.join("\n")}\nabcde9`);
		const growthFrame = renderLayoutFrame(followed, 6, 4, () => {});
		assert.strictEqual(followed.scrollTop, 5);
		assert.ok(growthFrame.lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line))));

		const fittingContent = new Text("1\n2", 0, 0);
		const automatic = new ScrollView(fittingContent, { scrollbar: "auto", scrollbarThumbStyle });
		renderLayoutFrame(automatic, 6, 4, () => {});
		automatic.scrollBy(1);
		assert.ok(
			renderLayoutFrame(automatic, 6, 4, () => {}).lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line))),
		);

		const alwaysFitting = new ScrollView(fittingContent, { scrollbar: "always", scrollbarThumbStyle });
		const alwaysFittingFrame = renderLayoutFrame(alwaysFitting, 6, 4, () => {});
		assert.strictEqual(alwaysFittingFrame.root.children[0]?.rect.width, 5);
		assert.ok(visible(alwaysFittingFrame.lines).every((line) => line.endsWith("┃")));

		const alwaysOverflowing = new ScrollView(content, {
			scrollbar: "always",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
		});
		const alwaysOverflowingFrame = renderLayoutFrame(alwaysOverflowing, 6, 4, () => {});
		assert.strictEqual(alwaysOverflowingFrame.root.children[0]?.rect.width, 5);
		assert.strictEqual(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("┃")).length, 2);
		assert.strictEqual(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("│")).length, 2);
		for (const line of alwaysOverflowingFrame.lines) {
			const scrollbarStyleIndex = Math.max(line.lastIndexOf(trackColor), line.lastIndexOf(thumbColor));
			const reservedColumnResetIndex = line.lastIndexOf("\x1b[0m\x1b]8;;\x07", scrollbarStyleIndex);
			assert.ok(reservedColumnResetIndex > line.lastIndexOf(contentBackground));
		}

		const thumbHeightFor = (contentHeight: number) => {
			const sized = new ScrollView(new Text(Array.from({ length: contentHeight }, () => "x").join("\n"), 0, 0), {
				scrollbar: "auto",
				scrollbarThumbStyle,
			});
			renderLayoutFrame(sized, 6, 20, () => {});
			sized.scrollBy(1);
			return renderLayoutFrame(sized, 6, 20, () => {}).lines.filter((line) =>
				stripTerminalSequences(line).endsWith("┃"),
			).length;
		};
		assert.strictEqual(thumbHeightFor(21), 19);
		assert.strictEqual(thumbHeightFor(40), 10);
		assert.strictEqual(thumbHeightFor(100), 4);
		assert.strictEqual(thumbHeightFor(400), 2);
	});

	it("preserves only the underlying background beneath overlay scrollbar glyphs", () => {
		const background = "\x1b[42m";
		const borderForeground = "\x1b[31m";
		const content = {
			render: (width: number) =>
				Array.from(
					{ length: 8 },
					() => `${background}${"x".repeat(width - 1)}${borderForeground}│\x1b[39m\x1b[49m`,
				),
			invalidate: () => {},
		};
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => text,
			scrollbarThumbStyle: (text) => text,
		});
		renderLayoutFrame(scrollView, 6, 4, () => {});
		scrollView.scrollBy(1);
		const frame = renderLayoutFrame(scrollView, 6, 4, () => {});

		assert.deepStrictEqual(frame.lines.map(stripTerminalSequences), ["xxxxx│", "xxxxx┃", "xxxxx┃", "xxxxx│"]);
		for (const line of frame.lines) {
			assert.ok(line.includes(background));
			assert.ok(!line.includes(borderForeground));
			assert.ok(line.includes(`\x1b[0m\x1b]8;;\x07${background}`));
		}
	});

	it("updates reserved scrollbar layout at runtime", () => {
		const scrollView = new ScrollView(new Text("123456", 0, 0), { scrollbar: "always" });
		const render = () => renderLayoutFrame(new HStack([scrollView], { align: "start" }), 6, 2, () => {});
		const always = render();
		assert.deepStrictEqual(visibleLines(always.lines), ["12345┃", "6    ┃"]);
		assert.strictEqual(always.root.children[0]?.rect.width, 6);
		assert.strictEqual(always.root.children[0]?.children[0]?.rect.width, 5);

		scrollView.setScrollbar("hidden");
		assert.strictEqual(render().root.children[0]?.children[0]?.rect.width, 6);
		assert.strictEqual(scrollView.isScrollbarVisible, false);
	});

	it("measures nested scroll content from constrained child geometry", () => {
		const inner = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0));
		const outer = new ScrollView(new VStack([{ component: inner, basis: 2 }, new Text("tail", 0, 0)]));
		renderLayoutFrame(outer, 10, 2, () => {});

		assert.strictEqual(inner.viewportHeight, 2);
		assert.strictEqual(outer.scrollBy(10), 9);
		assert.strictEqual(outer.scrollTop, 1);
	});

	it("rebuilds geometry after content changes", () => {
		const text = new Text("one", 0, 0);
		const root = new VStack([text]);
		const first = renderLayoutFrame(root, 10, 4, () => {});
		text.setText("one\ntwo\nthree");
		const second = renderLayoutFrame(root, 10, 4, () => {});

		assert.strictEqual(first.root.children[0]?.lines?.length, 1);
		assert.strictEqual(second.root.children[0]?.lines?.length, 3);
	});
});
