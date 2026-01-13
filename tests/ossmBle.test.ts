import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import http from "http";
import puppeteer, { Browser, Page } from "puppeteer";
import path from "path";
import { readFile } from "fs/promises";
import { pageEvaluate, runWebTest } from "./vitestHelpers";
import { execSync } from "child_process";

export interface ExposedWindowProperties {
	selectBleDevice: (buttonId: string, deviceName: string) => Promise<void>;
}

describe.sequential("OSSM BLE", { timeout: 10_000 }, () => {
	//#region Test lifecycle
	let httpServer: http.Server;
	let browser: Browser;
	let page: Page;

	beforeAll(async () => {
		// Build project files
		execSync("npm run build:test", { stdio: "inherit" });

		// HTTP server
		httpServer = http.createServer(async (req, res) => {
			if (req.url === "/") {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(`<!DOCTYPE html>
					<html lang="en">
					<head>
						<meta charset="UTF-8">
						<meta name="viewport" content="width=device-width, initial-scale=1.0">
						<title>OSSM BLE Test</title>
						<style>
							body {
								/* Dark mode (so I don't get flash-banged when the test page opens) */
								background-color: black;
								color: white;
							}

							/* Makes an element practically invisible but still functional */
							.invisible {
								opacity: 0;
								width: 1px;
								height: 1px;
								border: none;
								padding: 0;
								margin: 0;
							}
						</style>
						<script type="module">
							window.WebTests = await import("/tests/ossmBle.test.web.js");
						</script>
					</head>
					<body>
					</body>
					</html>
				`);
			}
			else {
				// Serve files from src directory
				const filePath = path.join(process.cwd(), req.url!);
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

		// Puppeteer browser
		browser = await puppeteer.launch({
			headless: false,
			devtools: true,
			debuggingPort: 9222,
			args: [
				"--window-size=800,600",
				"--enable-features=WebBluetooth",
				"--enable-experimental-web-platform-features",
				"--unsafely-treat-insecure-origin-as-secure=http://localhost:3000"
			]
		});

		page = await browser.newPage();
		// Enable page logging.
		page.on("console", msg => console.log(msg.text()));
		page.on("pageerror", err => console.error(err));
		await page.goto("http://localhost:3000/");
		await page.bringToFront();
		// Ensure this is the only page that is open.
		(await browser.pages()).forEach(p => {
			if (p !== page) {
				p.close();
			}
		});

		// Ensure bluetooth is supported (not a test case but a prerequisite)
		const bleSupport = await pageEvaluate(page, () => {
			return !!navigator.bluetooth;
		});
		expect(bleSupport).toBe(true);

		// Expose API to select BLE device
		const selectBleDevice: ExposedWindowProperties["selectBleDevice"] = async (buttonId: string, deviceName: string) => {
			// Wait for the Bluetooth device chooser to appear
			// Click the button to trigger device selection.
			const [devicePrompt] = await Promise.all([
				page.waitForDevicePrompt(),
				page.locator(`#${buttonId}`).click(),
			]);

			// Select the OSSM device.
			const bluetoothDevice = await devicePrompt.waitForDevice(d => d.name == deviceName);
			await devicePrompt.select(bluetoothDevice);
		};
		await page.exposeFunction("selectBleDevice", selectBleDevice);

		// Wait for page to be fully loaded
		await page.waitForFunction(() => document.readyState === "complete");
	});

	afterAll(async () => {
		await browser.close();
		httpServer.close();
	});

	beforeEach(async () => {
		// Fix for the browser sometimes setting about:blank as the active tab.
		// The operations in these tests require the tab to be active.
		await page.bringToFront();
	});

	afterEach(async () => {
		// Refresh the page to reset state between tests.
		await page.reload({ waitUntil: ["networkidle0", "domcontentloaded"] });
	});

	function runWebTestImpl(...args: any[]): Promise<any> {
		return runWebTest(page, ...args);
	}
	//#endregion

	//#endregion Test cases
	test("connect to device", runWebTestImpl);

	test("events", runWebTestImpl);

	test("set speed", runWebTestImpl);
	test("set stroke", runWebTestImpl);
	test("set depth", runWebTestImpl);
	test("set sensation", runWebTestImpl);
	//#endregion
});
