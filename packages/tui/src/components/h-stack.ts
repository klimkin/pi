import type { RenderChild, StackLayoutEntry, StackLayoutNode } from "../layout-node.ts";
import { compositeTuiLine } from "../tui.ts";
import { visibleWidth } from "../utils.ts";
import {
	allocateStackSizes,
	Stack,
	type StackChild,
	type StackOptions,
	type StackRow,
	visibleStackEntries,
} from "./stack.ts";

// Zero-width entries render nothing; one shared array keeps their rows comparable across renders.
const NO_LINES: readonly string[] = [];

/** Allocate visible entries their column widths from their intrinsic widths, then render each at its width. */
function measureHStack(
	stackEntries: readonly StackLayoutEntry[],
	gap: number,
	width: number,
	renderChild: RenderChild,
): StackRow[] {
	const safeWidth = Math.max(1, width);
	const entries = visibleStackEntries(stackEntries, { width: safeWidth, height: Number.MAX_SAFE_INTEGER });
	const intrinsicWidths = entries.map((entry) => {
		const lines = renderChild(entry.component, safeWidth);
		return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	});
	const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, gap);
	return entries.map((entry, index) => {
		const lines = widths[index] === 0 ? NO_LINES : renderChild(entry.component, widths[index]!);
		return { component: entry.component, lines, height: lines.length, size: widths[index]! };
	});
}

function collectHStackLines(
	rows: readonly StackRow[],
	gap: number,
	align: StackLayoutNode["align"],
	width: number,
): string[] {
	const safeWidth = Math.max(1, width);
	const height = rows.reduce((max, row) => Math.max(max, row.lines.length), 0);
	const result = Array.from({ length: height }, () => "");
	let x = 0;
	for (const { lines, size: childWidth } of rows) {
		let offset = 0;
		if (align === "center") offset = Math.floor((height - lines.length) / 2);
		else if (align === "end") offset = height - lines.length;
		for (let row = 0; row < lines.length; row++) {
			const target = row + offset;
			if (target < 0 || target >= result.length) continue;
			result[target] = compositeTuiLine(result[target]!, lines[row]!, x, childWidth, safeWidth);
		}
		x += childWidth + gap;
	}
	return result;
}

/** Render horizontal stack entries side by side. Shared by HStack.render and layout measurement. */
export function renderHStack(
	stackEntries: readonly StackLayoutEntry[],
	gap: number,
	align: StackLayoutNode["align"],
	width: number,
	renderChild: RenderChild,
): string[] {
	return collectHStackLines(measureHStack(stackEntries, gap, width, renderChild), gap, align, width);
}

export class HStack extends Stack {
	protected readonly layoutType = "hstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		const rows = measureHStack(this.entries, this.gap, width, (component, childWidth) =>
			component.render(childWidth),
		);
		return this.renderRows(width, rows, (measured) => collectHStackLines(measured, this.gap, this.align, width));
	}
}
