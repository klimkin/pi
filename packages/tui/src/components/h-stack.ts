import type { StackLayoutEntry, StackLayoutNode } from "../layout-node.ts";
import { compositeTuiLine } from "../tui.ts";
import { visibleWidth } from "../utils.ts";
import {
	allocateStackSizes,
	type RenderChild,
	Stack,
	type StackChild,
	type StackOptions,
	visibleStackEntries,
} from "./stack.ts";

/** Render horizontal stack entries side by side. Shared by HStack.render and layout measurement. */
export function renderHStack(
	stackEntries: readonly StackLayoutEntry[],
	gap: number,
	align: StackLayoutNode["align"],
	width: number,
	renderChild: RenderChild,
): string[] {
	const safeWidth = Math.max(1, width);
	const viewport = { width: safeWidth, height: Number.MAX_SAFE_INTEGER };
	const entries = visibleStackEntries(stackEntries, viewport);
	if (entries.length === 0) return [];

	const intrinsicWidths = entries.map((entry) => {
		const lines = renderChild(entry.component, safeWidth);
		return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	});
	const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, gap);
	const rendered = entries.map((entry, index) =>
		widths[index] === 0 ? [] : renderChild(entry.component, widths[index]!),
	);
	const height = rendered.reduce((max, lines) => Math.max(max, lines.length), 0);
	const result = Array.from({ length: height }, () => "");
	let x = 0;
	for (let index = 0; index < rendered.length; index++) {
		const lines = rendered[index]!;
		const childWidth = widths[index]!;
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

export class HStack extends Stack {
	protected readonly layoutType = "hstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		return renderHStack(this.entries, this.gap, this.align, width, (component, childWidth) =>
			component.render(childWidth),
		);
	}
}
