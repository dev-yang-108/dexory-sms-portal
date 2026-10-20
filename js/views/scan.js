/* Camera scan view. Keyboard-wedge scanning works from any screen (see js/barcode.js). */

import { mount, setViewCleanup } from "../render.js";
import { startCameraScanner, stopCameraScanner, partNumberFromScannedText } from "../barcode.js";
import { getStockItem } from "../db.js";
import { navigate } from "../../app.js";

export function renderScanView() {
  mount(`
    <header class="topbar">
      <button class="icon-btn" id="btn-back" aria-label="Back">&larr;</button>
      <div class="topbar-title">Scan a stock item</div>
    </header>
    <div class="scan-wrap">
      <video id="scan-video" playsinline muted></video>
      <div class="scan-status" id="scan-status">Point the camera at the barcode label.</div>
    </div>
  `);

  const videoEl = document.getElementById("scan-video");

  const goBack = () => {
    stopCameraScanner(videoEl);
    navigate("#/");
  };
  document.getElementById("btn-back").onclick = goBack;

  let handled = false;
  startCameraScanner(
    videoEl,
    async (decodedText) => {
      if (handled) return;
      handled = true;
      stopCameraScanner(videoEl);
      await handleScannedCode(partNumberFromScannedText(decodedText));
    },
    (err) => {
      console.warn(err);
      const statusEl = document.getElementById("scan-status");
      if (statusEl) {
        statusEl.textContent =
          "Camera unavailable. Check camera permission for this site, or use a handheld scanner instead.";
      }
    }
  );

  setViewCleanup(() => {
    stopCameraScanner(videoEl);
  });
}

export async function handleScannedCode(partNumber) {
  if (!partNumber) return;
  const existing = await getStockItem(partNumber);
  if (existing) {
    navigate("#/item/" + encodeURIComponent(partNumber));
  } else {
    navigate("#/new?code=" + encodeURIComponent(partNumber) + "&unrecognized=1");
  }
}
