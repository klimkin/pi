import type { Component } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	// Stable result so parents can detect an unchanged spacer by array identity.
	private cachedLines: string[] = [];

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		this.lines = lines;
	}

	invalidate(): void {
		// Output does not depend on theme or width
	}

	render(_width: number): string[] {
		const count = this.lines > 0 ? Math.ceil(this.lines) : 0;
		if (this.cachedLines.length !== count) {
			this.cachedLines = Array.from({ length: count }, () => "");
		}
		return this.cachedLines;
	}
}
