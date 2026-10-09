import type { StackLayoutEntry } from "../layout-node.ts";
import {
	allocateStackSizes,
	type RenderChild,
	Stack,
	type StackChild,
	type StackOptions,
	visibleStackEntries,
} from "./stack.ts";

/** Render vertical stack entries at their natural heights. Shared by VStack.render and layout measurement. */
export function renderVStack(
	stackEntries: readonly StackLayoutEntry[],
	gap: number,
	width: number,
	renderChild: RenderChild,
): string[] {
	const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
	const entries = visibleStackEntries(stackEntries, viewport);
	const rendered = entries.map((entry) => renderChild(entry.component, viewport.width));
	const sizes = allocateStackSizes(
		entries,
		rendered.map((lines) => lines.length),
		undefined,
		gap,
	);
	const lines: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		if (index > 0) {
			for (let gapRow = 0; gapRow < gap; gapRow++) lines.push("");
		}
		const childLines = rendered[index]!.slice(0, sizes[index]);
		lines.push(...childLines);
		for (let padding = childLines.length; padding < sizes[index]!; padding++) lines.push("");
	}
	return lines;
}

export class VStack extends Stack {
	protected readonly layoutType = "vstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		return renderVStack(this.entries, this.gap, width, (component, childWidth) => component.render(childWidth));
	}
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";
