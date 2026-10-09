import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	private cachedLines: string[] | undefined;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Return a stable array while the line is unchanged so parents can reuse their output.
		// Comparing the line (not just the width) keeps theme changes visible without invalidate().
		const line = this.color("─".repeat(Math.max(1, width)));
		if (this.cachedLines?.[0] !== line) this.cachedLines = [line];
		return this.cachedLines;
	}
}
