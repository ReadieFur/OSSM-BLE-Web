import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import http from "http";
import puppeteer, { Browser, Page } from "puppeteer";
import path from "path";
import { readFile } from "fs/promises";
import { pageEvaluate } from "./helpers.js";
import type { OssmEventType, OssmBle } from "../src/ossmBle.js";

//#region ossmBle helpers
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
//#endregion

describe.sequential("OSSM BLE", { timeout: 10_000 }, () => {
	//#region Test lifecycle
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
		page.on("console", msg => console.log("PAGE LOG:", msg.text()));
		page.on("pageerror", err => console.error("PAGE ERROR:", err));
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

		// Load the OssmBle module
		// const ossmBlePath = process.env.VITEST_VSCODE ? "/dist/ossmBle.dev.js" : "/dist/ossmBle.js";
		const ossmBlePath = "/dist/ossmBle.js";
		console.log("Loading OSSM BLE module from:", ossmBlePath);
		await page.addScriptTag({
			type: "module",
			content: `
				import { OssmBle } from '${ossmBlePath}';
				window.OssmBle = OssmBle;
			`
		});
		expect(await page.waitForFunction(() => typeof window.OssmBle !== "undefined", { timeout: 1000 })).toBeTruthy();
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
		// Dispose of any existing OssmBle instance.
		await pageEvaluate(page, async () => {
			try { window.ossmBleInstance?.[Symbol.dispose](); }
			catch {}
			window.ossmBleInstance = undefined;
		});
	});
	//#endregion

	//#endregion Test cases
	test("module loads", async () => {
		expect(await pageEvaluate(page, () => typeof window.OssmBle !== "undefined")).toBe(true);
	});

	test("connect to device", async () => {
		await createOssmBleInstance(page);
	});

	test("event listeners", async () => {
		await createOssmBleInstance(page);
		await pageEvaluate(page, async () => {
			// Setup event listeners
			let connectedFired = false;
			let disconnectedFired = false;
			let stateChangedFired = false;
			// Hacky workaround to referencing the enum inside the page context.
			// TODO: Fix reference issue between runtime contexts.
			window.ossmBleInstance!.addEventListener(0 as OssmEventType, () => connectedFired = true);
			window.ossmBleInstance!.addEventListener(1 as OssmEventType, () => disconnectedFired = true);
			window.ossmBleInstance!.addEventListener(2 as OssmEventType, () => stateChangedFired = true);

			// Begin the connection
			window.ossmBleInstance!.begin();

			await window.ossmBleInstance!.waitForReady();
			if (!connectedFired)
				throw new Error("Connected event did not fire");
			console.log("Connected event fired");

			// Await for a maximum of 2 seconds for a state change event, they should occur at least every second.
			await new Promise<void>(async (resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new Error("StateChanged event did not fire within timeout"));
				}, 2000);
				while (!stateChangedFired)
					await new Promise(r => setTimeout(r, 100));
				clearTimeout(timeout);
				console.log("StateChanged event fired");
				resolve();
			});

			// Disconnect the device
			await window.ossmBleInstance?.[Symbol.dispose]();
			if (!disconnectedFired)
				throw new Error("Disconnected event did not fire");
			console.log("Disconnected event fired");
		});
	});

	test("setSpeed", async () => {
		await createOssmBleInstance(page);
		await pageEvaluate(page, async () => {
			window.ossmBleInstance!.begin();
			await window.ossmBleInstance!.waitForReady();
			await window.ossmBleInstance!.setSpeed(0);
			await window.ossmBleInstance!.setSpeed(50);
			await window.ossmBleInstance!.setSpeed(100);
		});
		try {
			await pageEvaluate(page, async () => {
				await window.ossmBleInstance!.setSpeed(150);
			});
			throw new Error("setSpeed did not throw for invalid value");
		}
		catch (error) {
			// Pass
		}
	});

	test("setStroke", async () => {
		await createOssmBleInstance(page);
		await pageEvaluate(page, async () => {
			window.ossmBleInstance!.begin();
			await window.ossmBleInstance!.waitForReady();
			await window.ossmBleInstance!.setStroke(0);
			await window.ossmBleInstance!.setStroke(50);
			await window.ossmBleInstance!.setStroke(100);
		});
		try {
			await pageEvaluate(page, async () => {
				await window.ossmBleInstance!.setStroke(150);
			});
			throw new Error("setStroke did not throw for invalid value");
		}
		catch (error) {
			// Pass
		}
	});

	test("setDepth", async () => {
		await createOssmBleInstance(page);
		await pageEvaluate(page, async () => {
			window.ossmBleInstance!.begin();
			await window.ossmBleInstance!.waitForReady();
			await window.ossmBleInstance!.setDepth(0);
			await window.ossmBleInstance!.setDepth(50);
			await window.ossmBleInstance!.setDepth(100);
		});
		try {
			await pageEvaluate(page, async () => {
				await window.ossmBleInstance!.setDepth(150);
			});
			throw new Error("setDepth did not throw for invalid value");
		}
		catch (error) {
			// Pass
		}
	});

	test("setSensation", async () => {
		await createOssmBleInstance(page);
		await pageEvaluate(page, async () => {
			window.ossmBleInstance!.begin();
			await window.ossmBleInstance!.waitForReady();
			await window.ossmBleInstance!.setSensation(0);
			await window.ossmBleInstance!.setSensation(50);
			await window.ossmBleInstance!.setSensation(100);
		});
		try {
			await pageEvaluate(page, async () => {
				await window.ossmBleInstance!.setSensation(150);
			});
			throw new Error("setSensation did not throw for invalid value");
		}
		catch (error) {
			// Pass
		}
	});

	test("setPattern", async () => {
		await createOssmBleInstance(page);
		await pageEvaluate(page, async () => {
			window.ossmBleInstance!.begin();
			await window.ossmBleInstance!.waitForReady();
			await window.ossmBleInstance!.setPattern(0);
		});
		try {
			await pageEvaluate(page, async () => {
				await window.ossmBleInstance!.setPattern(-1);
			});
			throw new Error("setPattern did not throw for invalid value");
		}
		catch (error) {
			// Pass
		}
	});

	test.skip("navigateTo", async () => {
		// Depends on having the split runtime working, (not implemented yet).
		throw new Error("Not implemented");
	});

	test("setSpeedKnobConfig", async () => {
		await createOssmBleInstance(page);
		await pageEvaluate(page, async () => {
			window.ossmBleInstance!.begin();
			await window.ossmBleInstance!.waitForReady();
			await window.ossmBleInstance!.setSpeedKnobConfig(true);
			await window.ossmBleInstance!.setSpeedKnobConfig(false);
		});
	});
	//#endregion
});
