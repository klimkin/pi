import type { RenderChild, StackLayoutEntry } from "../layout-node.ts";
import {
	allocateStackSizes,
	Stack,
	type StackChild,
	type StackOptions,
	type StackRow,
	visibleStackEntries,
} from "./stack.ts";

/** Render visible entries at their natural heights and allocate each its row count. */
function measureVStack(
	stackEntries: readonly StackLayoutEntry[],
	gap: number,
	width: number,
	renderChild: RenderChild,
): StackRow[] {
	const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
	const entries = visibleStackEntries(stackEntries, viewport);
	const rendered = entries.map((entry) => renderChild(entry.component, viewport.width));
	const sizes = allocateStackSizes(
		entries,
		rendered.map((lines) => lines.length),
		undefined,
		gap,
	);
	return entries.map((entry, index) => ({
		component: entry.component,
		lines: rendered[index]!,
		height: rendered[index]!.length,
		size: sizes[index]!,
	}));
}

function collectVStackLines(rows: readonly StackRow[], gap: number): string[] {
	const lines: string[] = [];
	for (let index = 0; index < rows.length; index++) {
		if (index > 0) {
			for (let gapRow = 0; gapRow < gap; gapRow++) lines.push("");
		}
		const { lines: childLines, size } = rows[index]!;
		const shown = Math.min(childLines.length, size);
		for (let row = 0; row < shown; row++) lines.push(childLines[row]!);
		for (let padding = shown; padding < size; padding++) lines.push("");
	}
	return lines;
}

/** Render vertical stack entries. Shared by VStack.render and layout measurement. */
export function renderVStack(
	stackEntries: readonly StackLayoutEntry[],
	gap: number,
	width: number,
	renderChild: RenderChild,
): string[] {
	return collectVStackLines(measureVStack(stackEntries, gap, width, renderChild), gap);
}

export class VStack extends Stack {
	protected readonly layoutType = "vstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		// Render and reevaluate visibility on every call: child updates need no parent invalidation.
		const rows = measureVStack(this.entries, this.gap, width, (component, childWidth) =>
			component.render(childWidth),
		);
		return this.renderRows(width, rows, (measured) => collectVStackLines(measured, this.gap));
	}
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";
