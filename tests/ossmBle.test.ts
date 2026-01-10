import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import http from "http";
import puppeteer, { Browser, Page } from "puppeteer";
import path from "path";
import { readFile } from "fs/promises";
import { pageEvaluate } from "./helpers.js";
import type { OssmBle } from "../src/ossmBle.js";

declare global {
	interface Window {
		OssmBle: typeof OssmBle;
		ossmBleInstance: OssmBle | undefined;
	}
}

async function createOssmBleInstance(page: Page): Promise<void> {
	// Create a button that can trigger a user gesture for pairing.
	await pageEvaluate(page, async () => {
		const bleButton = document.createElement("button");
		bleButton.id = "bleButton";
		bleButton.innerText = "Connect to BLE Device";
		bleButton.addEventListener("click", async () => {
			// Define ossmBleInstance in the window for test access.
			window.ossmBleInstance = await window.OssmBle.pairDevice();
		});
		document.body.appendChild(bleButton);
	});

	// Click the button to trigger device selection.
	const [devicePrompt] = await Promise.all([
		page.waitForDevicePrompt(),
		page.locator("#bleButton").click(),
	]);

	// Select the OSSM device.
	const bluetoothDevice = await devicePrompt.waitForDevice(d => d.name == "OSSM");
	await devicePrompt.select(bluetoothDevice);

	// Ensure the OssmBle instance is created.
	(await page.waitForFunction(() => !!window.ossmBleInstance, { timeout: 1000 }))

	// Remove the button after use.
	await pageEvaluate(page, () => {
		const bleButton = document.getElementById("bleButton");
		bleButton?.remove();
	});
}

describe.sequential("OSSM BLE", () => {
	let httpServer: http.Server;
	let browser: Browser;
	let page: Page;

	beforeAll(async () => {
		httpServer = http.createServer(async (req, res) => {
			if (req.url === "/") {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(`<!DOCTYPE html>
					<html lang="en">
					<head>
						<meta charset="UTF-8">
						<meta name="viewport" content="width=device-width, initial-scale=1.0">
					</head>
					<body>
					</body>
					</html>
				`);
			}
			else {
				// Serve files from src directory
				const filePath = path.join(process.cwd(), "src", req.url!);
				try {
					const fileContent = await readFile(filePath);
					let contentType = req.url!.endsWith(".js") ? "application/javascript" : "text/plain";
					res.writeHead(200, { "Content-Type": contentType });
					res.end(fileContent);
				}
				catch (err) {
					res.writeHead(404);
					res.end("File not found");
				}
			}
		}).listen(3000);

		browser = await puppeteer.launch({
			headless: false,
			devtools: true,
			args: [
				"--window-size=800,600",
				"--enable-features=WebBluetooth",
				"--enable-experimental-web-platform-features",
				"--unsafely-treat-insecure-origin-as-secure=http://localhost:3000"
			]
		});

		page = await browser.newPage();
		await page.goto("http://localhost:3000/");

		// Ensure bluetooth is supported (not a test case but a prerequisite)
		const bleSupport = await pageEvaluate(page, () => {
			return !!navigator.bluetooth;
		});
		expect(bleSupport).toBe(true);

		// Load the OssmBle module
		await page.addScriptTag({
			type: "module",
			content: `
				import { OssmBle } from '/ossmBle.js';
				window.OssmBle = OssmBle;
			`
		});
		expect(await page.waitForFunction(() => typeof window.OssmBle !== "undefined", { timeout: 1000 })).toBeTruthy();

		// Enable page logging.
		page.on("console", msg => console.log("PAGE LOG:", msg.text()));
		page.on("pageerror", err => console.error("PAGE ERROR:", err));
	});

	afterAll(async () => {
		await browser.close();
	});

	beforeEach(async () => {
		// Fix for the browser sometimes setting about:blank as the active tab.
		// The operations in these tests require the tab to be active.
		await page.bringToFront();
	});

	afterEach(async () => {
		// Dispose of any existing OssmBle instance.
		await pageEvaluate(page, async () => {
			try { window.ossmBleInstance?.[Symbol.dispose](); }
			catch {}
			window.ossmBleInstance = undefined;
		});
	});

	test("connect to device", { timeout: 10_000 }, async () => {
		await createOssmBleInstance(page);
	});
});
