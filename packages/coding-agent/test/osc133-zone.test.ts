import { describe, expect, it } from "vitest";
import { Osc133Zone } from "../src/modes/interactive/components/osc133-zone.ts";

const OSC133_ZONE_END = "\x1b]133;B\x07";

describe("Osc133Zone", () => {
	it("reuses the wrapped copy for an unchanged source and rewraps a source grown in place", () => {
		const zone = new Osc133Zone();
		const source = ["a"];
		const wrapped = zone.wrap(source);
		expect(zone.wrap(source)).toBe(wrapped);

		source.push("b");
		const grown = zone.wrap(source);
		expect(grown).toHaveLength(2);
		expect(grown[0]!.includes(OSC133_ZONE_END)).toBe(false);
		expect(grown[1]!.startsWith(OSC133_ZONE_END)).toBe(true);
	});
});
