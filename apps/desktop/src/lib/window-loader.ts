import type { BrowserWindow } from "electron";
import { app } from "electron";
import { env } from "shared/env.shared";

/** Window IDs defined in the router configuration */
type WindowId = "main" | "about";

/**
 * Load an Electron window with the appropriate URL for TanStack Router.
 * Uses hash-based routing for compatibility with Electron's file:// protocol.
 *
 * - Development: loads from Vite dev server at http://localhost:PORT/#/
 * - Production: loads from built HTML file with hash routing (#/)
 */
export function registerRoute(props: {
	id: WindowId;
	browserWindow: BrowserWindow;
	htmlFile: string;
	query?: Record<string, string>;
}): void {
	const isPackaged = app.isPackaged;
	const rendererUrl = process.env.ELECTRON_RENDERER_URL;

	// Packaged builds must always use local bundled files.
	// This avoids accidental black screens when NODE_ENV is unset/mis-set.
	if (isPackaged) {
		console.log("[window-loader] Loading packaged file:", props.htmlFile);
		props.browserWindow.loadFile(props.htmlFile, { hash: "/" });
	} else if (rendererUrl) {
		// Dev: prefer electron-vite injected URL (actual bound port, e.g. 5191 fallback).
		const normalized = rendererUrl.endsWith("/")
			? rendererUrl.slice(0, -1)
			: rendererUrl;
		const url = `${normalized}/#/`;
		console.log("[window-loader] Loading dev server URL:", url);
		props.browserWindow.loadURL(url);
	} else {
		// Dev fallback when ELECTRON_RENDERER_URL is missing.
		const url = `http://localhost:${env.DESKTOP_VITE_PORT}/#/`;
		console.log("[window-loader] Loading fallback development URL:", url);
		props.browserWindow.loadURL(url);
	}

	// Log successful loads
	props.browserWindow.webContents.on("did-finish-load", () => {
		console.log(
			"[window-loader] Successfully loaded:",
			props.browserWindow.webContents.getURL(),
		);
	});

	// Log and handle load failures
	props.browserWindow.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL) => {
			console.error("[window-loader] Failed to load URL:", validatedURL);
			console.error("[window-loader] Error code:", errorCode);
			console.error("[window-loader] Error description:", errorDescription);
		},
	);
}
