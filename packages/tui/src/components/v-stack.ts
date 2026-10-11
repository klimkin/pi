import type { StackLayoutEntry } from "../layout-node.ts";
import type { Component } from "../tui.ts";
import {
	allocateStackSizes,
	type RenderChild,
	Stack,
	type StackChild,
	type StackOptions,
	visibleStackEntries,
} from "./stack.ts";

/** Render vertical stack entries at their natural heights using layout's cached child renderer. */
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
	return collectVStackLines(rendered, sizes, gap);
}

function collectVStackLines(rendered: readonly string[][], sizes: readonly number[], gap: number): string[] {
	const lines: string[] = [];
	for (let index = 0; index < rendered.length; index++) {
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
	// Stable output lets ancestor Containers reuse their concatenated lines.
	private stackRenderCache?: {
		width: number;
		components: Component[];
		childLines: string[][];
		childLengths: number[];
		sizes: number[];
		lines: string[];
	};

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		// Render and reevaluate visibility on every call: child updates need no parent invalidation.
		const rendered = entries.map((entry) => entry.component.render(viewport.width));
		const sizes = allocateStackSizes(
			entries,
			rendered.map((lines) => lines.length),
			undefined,
			this.gap,
		);
		const cache = this.stackRenderCache;
		if (
			cache?.width === viewport.width &&
			cache.components.length === entries.length &&
			entries.every(
				(entry, index) =>
					cache.components[index] === entry.component &&
					cache.childLines[index] === rendered[index] &&
					cache.childLengths[index] === rendered[index]!.length &&
					cache.sizes[index] === sizes[index],
			)
		) {
			return cache.lines;
		}

		const lines = collectVStackLines(rendered, sizes, this.gap);
		this.stackRenderCache = {
			width: viewport.width,
			components: entries.map((entry) => entry.component),
			childLines: rendered,
			childLengths: rendered.map((childLines) => childLines.length),
			sizes,
			lines,
		};
		return lines;
	}

	override invalidate(): void {
		this.stackRenderCache = undefined;
		super.invalidate();
	}
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";
