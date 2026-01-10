import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import http from "http";
import puppeteer, { Browser, Page } from "puppeteer";

describe.sequential("OSSM BLE", () => {
	let httpServer: http.Server;
	let browser: Browser;
	let page: Page;

	beforeAll(async () => {
		httpServer = http.createServer((req, res) => {
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
		page.on("console", msg => console.log("PAGE LOG:", msg.text()));
		await page.goto("http://localhost:3000");
	});

	afterAll(async () => {
		await browser.close();
	});

	test.skip("ble supported", async () => {
		const bleSupport = await page.evaluate(() => {
			return !!navigator.bluetooth;
		});
		expect(bleSupport).toBe(true);
	});

	test("connect to ble device", { timeout: 10_000 }, async () => {
		await page.evaluate(async () => {
			const bleButton = document.createElement("button");
			bleButton.id = "bleButton";
			bleButton.innerText = "Connect to BLE Device";
			bleButton.addEventListener("click", async () => {
				await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
			});
			document.body.appendChild(bleButton);
		});

		const [devicePrompt] = await Promise.all([
			page.waitForDevicePrompt(),
			page.locator("#bleButton").click(),
		]);

		const bluetoothDevice = await devicePrompt.waitForDevice(d => d.name == "OSSM");
		await devicePrompt.select(bluetoothDevice);
	});
});
