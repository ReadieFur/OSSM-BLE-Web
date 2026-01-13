import { Page } from "puppeteer";
import { readFile } from "fs/promises";
import path from "path";
import { SourceMapConsumer } from "source-map";
import { assert, expect } from "vitest";

async function mapBrowserStackToSource<T>(stack: string): Promise<string> {
	const lines = stack.split("\n");
	const processedLines: string[] = [];

	for (const line of lines) {
		// Find browser frame (assumed to be served from localhost)
		const regex = /http:\/\/localhost:\d+\/([^\s:]+):(\d+):(\d+)/;
		const match = line.match(regex);

		if (!match) {
			processedLines.push(line);
			continue;
		}

		const [fullMatch, jsPath, lineStr, colStr] = match;

		try {
			const mapFilePath = jsPath + ".map";
			const mapContents = await readFile(mapFilePath, "utf-8");
			const consumer = await new SourceMapConsumer(mapContents);

			const original = consumer.originalPositionFor({
				line: Number(lineStr),
				column: Number(colStr),
			});

			// Map URL in stack to original TS file
			if (original.source) {
				// If the source path is relative, prepend the web url to it (since the project is served from root but the web file may not be resulting in the source path being incorrect).
				let sourcePath = original.source;
				if (!path.isAbsolute(sourcePath))
					sourcePath = path.join(path.dirname(mapFilePath), sourcePath);

				let remappedLine = line.replace(fullMatch, `${sourcePath}:${original.line}:${original.column}`);
				if (!remappedLine.startsWith("    at "))
					remappedLine = "    at " + remappedLine;
				processedLines.push(remappedLine);
			} else {
				processedLines.push(line);
			}

			consumer.destroy();
		} catch {
			// Ignore errors (e.g, no source map)
			processedLines.push(line);
		}
	}

	return processedLines.join("\n");
}

export async function pageEvaluate<T>(page: Page, pageFunction: (...args: any[]) => Promise<T> | T, ...args: any[]): Promise<T> {
    // Required since puppeteer which places browser errors at the end of the stack trace.
    Error.stackTraceLimit = 1000;

	try {
		return await page.evaluate(pageFunction, ...args);
	} catch (err: any) {
		if (err.stack)
			err.stack = await mapBrowserStackToSource(err.stack);
		throw err;
	}
}

export function runWebTest(page: Page,...args: any[]): Promise<any> {
	let testName: string = expect.getState().currentTestName!;
	expect(testName).toBeDefined();
	testName = testName
		.trim()
		.split(/[\s_\-]+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1).toLowerCase())
		.join("");
	const lastPtrIndex = testName.lastIndexOf(">");
	if (lastPtrIndex !== -1)
		testName = testName.slice(lastPtrIndex + 1);
	testName = `test${testName}`;

	return pageEvaluate(page, async (testName: string, ...args: any[]) => {
		if ((window as any).WebTests === undefined)
			throw new Error("WebTests module not loaded.");
		if (typeof (window as any).WebTests[testName] !== "function")
			throw new Error(`Web test function "${testName}" not found.`);

		await (window as any).WebTests[testName](...args);
	}, testName, ...args);
}
