import assert from "node:assert";
import { describe, it } from "node:test";
import { getGraphemeCellRange, getGraphemeSegmenter, sliceWithWidth, visibleWidth } from "../src/utils.ts";

const ESC = "\x1b";

function isAnsiAt(line: string, index: number): number {
	const match = /^\x1b(?:\[[0-9;]*[mGKHJ]|\]8;[^\x07]*\x07)/.exec(line.slice(index));
	return match ? match[0].length : 0;
}

/** The segmenter-based algorithm sliceWithWidth used for every text run. */
function referenceSlice(line: string, startCol: number, length: number, strict: boolean) {
	if (length <= 0) return { text: "", width: 0 };
	const endCol = startCol + length;
	let result = "";
	let resultWidth = 0;
	let currentCol = 0;
	let pendingAnsi = "";
	let i = 0;
	while (i < line.length) {
		const ansiLength = isAnsiAt(line, i);
		if (ansiLength) {
			const code = line.slice(i, i + ansiLength);
			if (currentCol >= startCol && currentCol < endCol) {
				result += pendingAnsi + code;
				pendingAnsi = "";
			} else if (currentCol < startCol) pendingAnsi += code;
			i += ansiLength;
			continue;
		}
		let textEnd = i;
		while (textEnd < line.length && !isAnsiAt(line, textEnd)) textEnd++;
		for (const { segment } of getGraphemeSegmenter().segment(line.slice(i, textEnd))) {
			const w = visibleWidth(segment);
			if (currentCol >= startCol && currentCol < endCol && (!strict || currentCol + w <= endCol)) {
				if (pendingAnsi) {
					result += pendingAnsi;
					pendingAnsi = "";
				}
				result += segment;
				resultWidth += w;
			}
			currentCol += w;
			if (currentCol >= endCol) break;
		}
		i = textEnd;
		if (currentCol >= endCol) break;
	}
	return { text: result, width: resultWidth };
}

function referenceCellRange(line: string, column: number) {
	let currentCol = 0;
	let i = 0;
	while (i < line.length) {
		const ansiLength = isAnsiAt(line, i);
		if (ansiLength) {
			i += ansiLength;
			continue;
		}
		let textEnd = i;
		while (textEnd < line.length && !isAnsiAt(line, textEnd)) textEnd++;
		for (const { segment } of getGraphemeSegmenter().segment(line.slice(i, textEnd))) {
			const width = visibleWidth(segment);
			if (width > 0 && column >= currentCol && column < currentCol + width) {
				return { start: currentCol, end: currentCol + width };
			}
			currentCol += width;
		}
		i = textEnd;
	}
	return undefined;
}

function randomLine(random: () => number, pieces: string[]): string {
	let line = "";
	const count = Math.floor(random() * 12);
	for (let index = 0; index < count; index++) line += pieces[Math.floor(random() * pieces.length)]!;
	return line;
}

function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

const asciiPieces = [
	"plain text",
	" ",
	"x",
	"~!@#$%^&*()_+{}|:<>?",
	`${ESC}[31m`,
	`${ESC}[0m`,
	`${ESC}[1;48;5;236m`,
	`${ESC}]8;;https://example.com\x07`,
	`${ESC}]8;;\x07`,
];
const mixedPieces = [...asciiPieces, "中文", "e\u0301", "a\u200d", "👍🏽", "\t", "│", "─"];

describe("sliceWithWidth and getGraphemeCellRange printable ASCII fast path", () => {
	it("slices and hit-tests styled printable ASCII without grapheme segmentation", () => {
		const line = `${ESC}[48;5;236m ${ESC}[1muser${ESC}[22m: inspect this ${ESC}]8;;https://x.dev\x07link${ESC}]8;;\x07 ${ESC}[0m`;
		const expectedHead = referenceSlice(line, 0, 7, true);
		const expectedTail = referenceSlice(line, 3, 100, true);
		const segmenter = getGraphemeSegmenter();
		const segment = segmenter.segment;
		let calls = 0;
		segmenter.segment = (input: string) => {
			calls++;
			return segment.call(segmenter, input);
		};
		try {
			assert.deepStrictEqual(sliceWithWidth(line, 0, 7, true), expectedHead);
			assert.deepStrictEqual(sliceWithWidth(line, 3, 100, true), expectedTail);
			assert.deepStrictEqual(getGraphemeCellRange(line, 5), { start: 5, end: 6 });
			assert.strictEqual(getGraphemeCellRange(line, 200), undefined);
			assert.strictEqual(calls, 0);
		} finally {
			segmenter.segment = segment;
		}
	});

	it("matches the segmenter result for random ASCII and mixed lines", () => {
		const random = seededRandom(7);
		for (const pieces of [asciiPieces, mixedPieces]) {
			for (let iteration = 0; iteration < 2000; iteration++) {
				const line = randomLine(random, pieces);
				const width = visibleWidth(line);
				const start = Math.floor(random() * (width + 2));
				const length = Math.floor(random() * (width + 2));
				const strict = random() < 0.5;
				const message = JSON.stringify({ line, start, length, strict });
				assert.deepStrictEqual(
					sliceWithWidth(line, start, length, strict),
					referenceSlice(line, start, length, strict),
					message,
				);
				assert.deepStrictEqual(getGraphemeCellRange(line, start), referenceCellRange(line, start), message);
			}
		}
	});
});
