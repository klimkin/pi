const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Wraps rendered message lines in OSC 133 prompt-zone markers so terminals can jump between messages.
 * Render results are read-only, so the markers go on a copy; the copy is reused while the
 * source array is unchanged, keeping the result stable for parent render caches.
 */
export class Osc133Zone {
	private source: string[] | undefined;
	private wrapped: string[] | undefined;

	wrap(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		if (lines === this.source && this.wrapped) return this.wrapped;
		const wrapped = lines.slice();
		wrapped[0] = OSC133_ZONE_START + wrapped[0];
		wrapped[wrapped.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + wrapped[wrapped.length - 1];
		this.source = lines;
		this.wrapped = wrapped;
		return wrapped;
	}
}
