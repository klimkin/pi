import { HStack, renderHStack } from "./components/h-stack.ts";
import { renderScrollViewContent, ScrollView } from "./components/scroll-view.ts";
import { allocateStackSizes, visibleStackEntries } from "./components/stack.ts";
import { renderVStack, VStack } from "./components/v-stack.ts";
import { getLayoutNode, type LayoutNode } from "./layout-node.ts";
import { cropKittyImageLine, getKittyImageMetadata, getMaxKittyImageRows, isImageLine } from "./terminal-image.ts";
import { type Component, Container, CURSOR_MARKER, compositeTuiLine } from "./tui.ts";
import {
	extractAnsiCode,
	getActiveBackgroundAnsi,
	getGraphemeCellRange,
	sliceByColumn,
	visibleWidth,
} from "./utils.ts";

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

export interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutBox {
	component: Component;
	rect: LayoutRect;
	clip: LayoutRect;
	children: LayoutBox[];
	parent?: LayoutBox;
	lines?: readonly string[];
	lineOffset?: number;
	scrollView?: ScrollView;
	/** Full scroll content. Built on first access when the content is a stacked Container. */
	scrollContentLines?: readonly string[];
	/** Plain Container laid out as stacked child boxes instead of one concatenated leaf. */
	stacked?: boolean;
	/** Render a layout-node child of a stacked box on demand for scroll content lookups. */
	sourceLines?: () => readonly string[];
	layer: number;
}

export interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	lines: string[];
	primaryScrollView?: ScrollView;
}

export interface ScrollbarGeometry {
	column: number;
	trackTop: number;
	trackHeight: number;
	thumbTop: number;
	thumbHeight: number;
	maxScrollTop: number;
}

interface LayoutContext {
	viewport: { width: number; height: number };
	renderCache: Map<Component, Map<number, string[]>>;
	requestRender: () => void;
	primaryScrollView: ScrollView | undefined;
}

function intersect(a: LayoutRect, b: LayoutRect): LayoutRect {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

// renderLayoutNode reproduces only these methods; an overridden render must run itself.
const BUILT_IN_LAYOUT_RENDERS = new Set<Component["render"]>([
	VStack.prototype.render,
	HStack.prototype.render,
	ScrollView.prototype.render,
]);

function renderCached(context: LayoutContext, component: Component, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	let widths = context.renderCache.get(component);
	if (!widths) {
		widths = new Map<number, string[]>();
		context.renderCache.set(component, widths);
	}
	let lines = widths.get(safeWidth);
	if (!lines) {
		const node = getLayoutNode(component);
		lines =
			node && BUILT_IN_LAYOUT_RENDERS.has(component.render)
				? renderLayoutNode(context, node, safeWidth)
				: component.render(safeWidth);
		widths.set(safeWidth, lines);
	}
	return lines;
}

/**
 * Render a stack or scroll node through renderCached so measuring it does not
 * render its children a second time. Layout later lays out the same children
 * at the same widths and reuses these cached lines.
 */
function renderLayoutNode(context: LayoutContext, node: LayoutNode, width: number): string[] {
	const renderChild = (child: Component, childWidth: number) => renderCached(context, child, childWidth);
	if (node.type === "scroll") {
		return renderScrollViewContent(node.component, width, node.state.getContentWidth(width), renderChild);
	}
	if (node.type === "vstack") return renderVStack(node.entries, node.gap, width, renderChild);
	return renderHStack(node.entries, node.gap, node.align, width, renderChild);
}

function measureHeight(context: LayoutContext, component: Component, width: number): number {
	return renderCached(context, component, width).length;
}

function measureWidth(context: LayoutContext, component: Component, width: number): number {
	return renderCached(context, component, width).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

function withParent(box: LayoutBox, parent: LayoutBox): LayoutBox {
	box.parent = parent;
	return box;
}

function translateBox(box: LayoutBox, deltaY: number): void {
	box.rect.y += deltaY;
	for (const child of box.children) translateBox(child, deltaY);
}

function updateClips(box: LayoutBox, parentClip: LayoutRect): void {
	box.clip = intersect(parentClip, box.rect);
	for (const child of box.children) updateClips(child, box.clip);
}

/**
 * A Container with the default render and mouse handling only concatenates its children.
 * As direct scroll content (the fullscreen transcript document), layout places its children
 * as separate boxes instead, so a streaming update does not copy the whole history into the
 * document's array as well. Limit this to eight direct children: document sections such as
 * header, resources, and chat keep a bounded box cost even as the history grows. Containers
 * with more children use their cached concatenated lines; a box per message costs more than
 * copying its lines. Only one level is stacked; child Containers render as ordinary leaves.
 */
function isStackableContainer(component: Component): component is Container {
	return (
		component instanceof Container &&
		component.children.length <= 8 &&
		component.render === Container.prototype.render &&
		component.handleMouse === Container.prototype.handleMouse
	);
}

function layoutStackedContainer(
	context: LayoutContext,
	container: Container,
	x: number,
	y: number,
	width: number,
	clip: LayoutRect,
): LayoutBox {
	const rect = { x, y, width, height: 0 };
	const box: LayoutBox = { component: container, rect, clip, children: [], stacked: true, layer: 0 };
	let childY = y;
	for (const child of container.children) {
		const childBox = layoutComponent(context, child, x, childY, width, undefined, clip);
		// Stacks and scroll views have no lines of their own; render them only for lookups.
		if (!childBox.lines) childBox.sourceLines = () => renderCached(context, child, width);
		box.children.push(withParent(childBox, box));
		childY += childBox.rect.height;
	}
	rect.height = childY - y;
	box.clip = intersect(clip, rect);
	return box;
}

/** Concatenate a stacked box's child lines; equals what Container.render would return. */
function collectStackedLines(box: LayoutBox): string[] {
	const out: string[] = [];
	for (const child of box.children) {
		const lines = child.lines ?? child.sourceLines?.() ?? [];
		for (let row = 0; row < child.rect.height; row++) out.push(lines[row] ?? "");
	}
	return out;
}

/** Content line at a row of a scroll box without materializing a stacked content's full lines. */
function scrollContentLineAt(box: LayoutBox, row: number): string | undefined {
	const content = box.children[0];
	if (!content?.stacked) return box.scrollContentLines?.[row];
	const y = content.rect.y + row;
	const children = content.children;
	let low = 0;
	let high = children.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const child = children[mid]!;
		if (y < child.rect.y) high = mid - 1;
		else if (y >= child.rect.y + child.rect.height) low = mid + 1;
		else return (child.lines ?? child.sourceLines?.())?.[y - child.rect.y];
	}
	return undefined;
}

function layoutComponent(
	context: LayoutContext,
	component: Component,
	x: number,
	y: number,
	width: number,
	height: number | undefined,
	clip: LayoutRect,
): LayoutBox {
	const safeWidth = Math.max(1, Math.floor(width));
	const node = getLayoutNode(component);
	if (!node) {
		const lines = renderCached(context, component, safeWidth);
		const allocatedHeight = height === undefined ? lines.length : Math.max(0, Math.floor(height));
		let lineOffset = 0;
		if (lines.length > allocatedHeight && allocatedHeight > 0) {
			const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
			if (cursorLine >= allocatedHeight) lineOffset = cursorLine - allocatedHeight + 1;
		}
		return {
			component,
			rect: { x, y, width: safeWidth, height: allocatedHeight },
			clip: intersect(clip, { x, y, width: safeWidth, height: allocatedHeight }),
			children: [],
			lines,
			lineOffset,
			layer: 0,
		};
	}

	if (node.type === "scroll") {
		const previousScrollTop = node.state.scrollTop;
		const contentWidth = node.state.getContentWidth(safeWidth);
		const childBox = isStackableContainer(node.component)
			? layoutStackedContainer(context, node.component, x, y - previousScrollTop, contentWidth, clip)
			: layoutComponent(context, node.component, x, y - previousScrollTop, contentWidth, undefined, clip);
		const contentHeight = childBox.rect.height;
		const viewportHeight = height === undefined ? contentHeight : Math.max(0, Math.floor(height));
		node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
		translateBox(childBox, previousScrollTop - node.state.scrollTop);
		const scrollView = node.state as ScrollView;
		if (node.state.primary || !context.primaryScrollView) context.primaryScrollView = scrollView;
		const rect = { x, y, width: safeWidth, height: viewportHeight };
		const childClip = intersect(clip, rect);
		let contentLines: readonly string[] | undefined = childBox.stacked
			? undefined
			: renderCached(context, node.component, contentWidth);
		const box: LayoutBox = {
			component,
			rect,
			clip: childClip,
			children: [childBox],
			scrollView,
			// Search, selection, and copy read the full content on demand; painting a stacked
			// transcript does not need it, so it is not built every frame.
			get scrollContentLines() {
				contentLines ??= collectStackedLines(childBox);
				return contentLines;
			},
			layer: 0,
		};
		childBox.parent = box;
		updateClips(childBox, childClip);
		return box;
	}

	const entries = visibleStackEntries(node.entries, context.viewport);
	const gapTotal = Math.max(0, entries.length - 1) * node.gap;
	if (node.type === "vstack") {
		const intrinsicHeights = entries.map((entry) =>
			typeof entry.basis === "number" ? entry.basis : measureHeight(context, entry.component, safeWidth),
		);
		const sizes = allocateStackSizes(entries, intrinsicHeights, height, node.gap);
		const naturalHeight = sizes.reduce((sum, size) => sum + size, 0) + gapTotal;
		const allocatedHeight = height === undefined ? naturalHeight : Math.max(0, Math.floor(height));
		const rect = { x, y, width: safeWidth, height: allocatedHeight };
		const box: LayoutBox = {
			component,
			rect,
			clip: intersect(clip, rect),
			children: [],
			layer: 0,
		};
		let childY = y;
		for (let index = 0; index < entries.length; index++) {
			box.children.push(
				withParent(
					layoutComponent(context, entries[index]!.component, x, childY, safeWidth, sizes[index]!, box.clip),
					box,
				),
			);
			childY += sizes[index]! + node.gap;
		}
		return box;
	}

	const intrinsicWidths = entries.map((entry) =>
		typeof entry.basis === "number" ? entry.basis : measureWidth(context, entry.component, safeWidth),
	);
	const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, node.gap);
	const intrinsicHeights = entries.map((entry, index) =>
		measureHeight(context, entry.component, Math.max(1, widths[index]!)),
	);
	const allocatedHeight =
		height === undefined
			? intrinsicHeights.reduce((max, childHeight) => Math.max(max, childHeight), 0)
			: Math.max(0, height);
	const rect = { x, y, width: safeWidth, height: allocatedHeight };
	const box: LayoutBox = {
		component,
		rect,
		clip: intersect(clip, rect),
		children: [],
		layer: 0,
	};
	let childX = x;
	for (let index = 0; index < entries.length; index++) {
		const naturalChildHeight = intrinsicHeights[index]!;
		const childHeight = node.align === "stretch" ? allocatedHeight : Math.min(allocatedHeight, naturalChildHeight);
		let childY = y;
		if (node.align === "center") childY += Math.floor((allocatedHeight - childHeight) / 2);
		else if (node.align === "end") childY += allocatedHeight - childHeight;
		const childWidth = widths[index]!;
		if (childWidth === 0) {
			box.children.push({
				component: entries[index]!.component,
				rect: { x: childX, y: childY, width: 0, height: childHeight },
				clip: { x: childX, y: childY, width: 0, height: 0 },
				children: [],
				parent: box,
				layer: 0,
			});
		} else {
			box.children.push(
				withParent(
					layoutComponent(context, entries[index]!.component, childX, childY, childWidth, childHeight, box.clip),
					box,
				),
			);
		}
		childX += childWidth + node.gap;
	}
	return box;
}

function replaceScrollbarCell(
	line: string,
	column: number,
	totalWidth: number,
	replacement: string,
	preserveTargetBackground: boolean,
): string {
	if (isImageLine(line)) return line;

	const graphemeRange = getGraphemeCellRange(line, column);
	const start = graphemeRange?.start ?? column;
	const end = graphemeRange?.end ?? column + 1;
	const before = sliceByColumn(line, 0, start, true);
	const target = sliceByColumn(line, start, end - start, true);
	const after = sliceByColumn(line, end, Math.max(0, totalWidth - end), true);

	let targetPrefix = "";
	let targetIndex = 0;
	while (targetIndex < target.length) {
		const ansi = extractAnsiCode(target, targetIndex);
		if (!ansi) break;
		targetPrefix += ansi.code;
		targetIndex += ansi.length;
	}
	const beforePadding = " ".repeat(Math.max(0, start - visibleWidth(before)));
	const cellPaddingBefore = " ".repeat(Math.max(0, column - start));
	const cellPaddingAfter = " ".repeat(Math.max(0, end - column - 1));
	const targetStyle = `\x1b[0m\x1b]8;;\x07${preserveTargetBackground ? getActiveBackgroundAnsi(targetPrefix) : ""}`;
	return `${before}${beforePadding}${targetStyle}${cellPaddingBefore}${replacement}${cellPaddingAfter}${after}`;
}

export function getScrollbarGeometry(box: LayoutBox, includeHiddenAuto = false): ScrollbarGeometry | undefined {
	if (!box.scrollView || box.rect.width <= 0 || box.rect.height <= 0) return undefined;

	const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 0;
	const trackHeight = box.rect.height;
	const canRevealHiddenAuto = includeHiddenAuto && box.scrollView.scrollbar === "auto" && contentHeight > trackHeight;
	if (!box.scrollView.isScrollbarVisible && !canRevealHiddenAuto) return undefined;

	const minThumbHeight = Math.min(2, trackHeight);
	const thumbHeight = Math.max(
		minThumbHeight,
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
	);
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	const maxThumbTop = trackHeight - thumbHeight;
	const thumbOffset = maxScrollTop === 0 ? 0 : Math.round((box.scrollView.scrollTop / maxScrollTop) * maxThumbTop);
	const column = box.rect.x + box.rect.width - 1;
	if (column < box.clip.x || column >= box.clip.x + box.clip.width) return undefined;

	return {
		column,
		trackTop: box.rect.y,
		trackHeight,
		thumbTop: box.rect.y + thumbOffset,
		thumbHeight,
		maxScrollTop,
	};
}

function paintScrollbar(box: LayoutBox, screen: string[], totalWidth: number): void {
	const geometry = getScrollbarGeometry(box);
	if (!geometry || !box.scrollView) return;

	for (let offset = 0; offset < geometry.trackHeight; offset++) {
		const row = geometry.trackTop + offset;
		if (row < box.clip.y || row >= box.clip.y + box.clip.height || row < 0 || row >= screen.length) continue;
		const isThumb = row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight;
		const replacement = isThumb
			? box.scrollView.scrollbarThumbStyle(box.scrollView.isScrollbarActive ? "█" : "┃")
			: box.scrollView.scrollbarTrackStyle("│");
		screen[row] = replaceScrollbarCell(
			screen[row] ?? "",
			geometry.column,
			totalWidth,
			replacement,
			box.scrollView.scrollbar !== "always",
		);
	}
}

function paintBox(box: LayoutBox, screen: string[], totalWidth: number): void {
	if (box.lines) {
		const offset = box.lineOffset ?? 0;
		const firstRow = Math.max(box.rect.y, box.clip.y, 0);
		const lastRow = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, screen.length);
		for (let row = firstRow; row < lastRow; row++) {
			const sourceLine = box.lines[offset + row - box.rect.y];
			if (sourceLine === undefined) continue;
			let line = sourceLine.replace(OSC133_ZONE_PREFIX, "");
			const imageMetadata = getKittyImageMetadata(line);
			if (imageMetadata) {
				const clipBottom = Math.min(screen.length, box.clip.y + box.clip.height);
				const visibleRows = Math.min(imageMetadata.rows, clipBottom - row);
				if (visibleRows < imageMetadata.rows) line = cropKittyImageLine(line, 0, visibleRows);
			}
			// Fast path: a full-width box painting onto an untouched row can use the
			// source line reference directly. Compositing here would rebuild the row
			// string through ANSI/grapheme segmentation every frame; padding is
			// unnecessary because rows are written with erase-line and the final
			// width clamp still truncates over-wide lines.
			if (box.rect.x === 0 && box.rect.width >= totalWidth && (isImageLine(line) || !screen[row])) {
				screen[row] = line;
			} else {
				screen[row] = compositeTuiLine(screen[row] ?? "", line, box.rect.x, box.rect.width, totalWidth);
			}
		}
	}
	for (const child of box.children) paintBox(child, screen, totalWidth);

	if (box.scrollView && box.scrollView.scrollTop > 0 && box.rect.height > 0) {
		// Find the nearest image line above the viewport. Placeholder rows below an
		// image line may contain padding, borders, or side-by-side text, so the search
		// is bounded by the tallest registered image instead of by row content.
		const scrollTop = box.scrollView.scrollTop;
		const minRow = Math.max(0, scrollTop - getMaxKittyImageRows());
		for (let imageRow = scrollTop - 1; imageRow >= minRow; imageRow--) {
			const imageLine = scrollContentLineAt(box, imageRow) ?? "";
			if (!isImageLine(imageLine)) continue;
			const metadata = getKittyImageMetadata(imageLine);
			if (!metadata) continue;
			const hiddenRows = scrollTop - imageRow;
			if (hiddenRows < metadata.rows) {
				const visibleRows = Math.min(box.rect.height, metadata.rows - hiddenRows);
				const cropped = cropKittyImageLine(imageLine, hiddenRows, visibleRows);
				if (box.rect.x === 0 && box.rect.width >= totalWidth) screen[box.rect.y] = cropped;
			}
			break;
		}
	}

	paintScrollbar(box, screen, totalWidth);
}

export function renderLayoutFrame(
	root: Component,
	width: number,
	height: number,
	requestRender: () => void,
): LayoutFrame {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	const context: LayoutContext = {
		viewport: { width: safeWidth, height: safeHeight },
		renderCache: new Map(),
		requestRender,
		primaryScrollView: undefined,
	};
	const rootBox = layoutComponent(context, root, 0, 0, safeWidth, safeHeight, {
		x: 0,
		y: 0,
		width: safeWidth,
		height: safeHeight,
	});
	const lines = Array.from({ length: safeHeight }, () => "");
	paintBox(rootBox, lines, safeWidth);
	return {
		root: rootBox,
		width: safeWidth,
		height: safeHeight,
		lines,
		...(context.primaryScrollView === undefined ? {} : { primaryScrollView: context.primaryScrollView }),
	};
}

function containsPoint(rect: LayoutRect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Return the visual hit path from the deepest component to the layout root. */
export function getLayoutBoxesAt(frame: LayoutFrame, x: number, y: number): LayoutBox[] {
	const result: Array<{ box: LayoutBox; depth: number }> = [];
	const visit = (box: LayoutBox, depth: number): void => {
		if (!containsPoint(box.clip, x, y)) return;
		result.push({ box, depth });
		for (const child of box.children) visit(child, depth + 1);
	};
	visit(frame.root, 0);
	result.sort((a, b) => b.box.layer - a.box.layer || b.depth - a.depth);
	return result.map(({ box }) => box);
}

export function getScrollViewBox(frame: LayoutFrame, scrollView: ScrollView): LayoutBox | undefined {
	const visit = (box: LayoutBox): LayoutBox | undefined => {
		if (box.scrollView === scrollView) return box;
		for (const child of box.children) {
			const match = visit(child);
			if (match) return match;
		}
		return undefined;
	};
	return visit(frame.root);
}

export function getScrollViewsAt(frame: LayoutFrame, x: number, y: number): ScrollView[] {
	const result: Array<{ scrollView: ScrollView; depth: number }> = [];
	const visit = (box: LayoutBox, depth: number): void => {
		if (!containsPoint(box.clip, x, y)) return;
		if (box.scrollView && containsPoint(box.rect, x, y)) result.push({ scrollView: box.scrollView, depth });
		for (const child of box.children) visit(child, depth + 1);
	};
	visit(frame.root, 0);
	result.sort((a, b) => b.depth - a.depth);
	return result.map((entry) => entry.scrollView);
}
