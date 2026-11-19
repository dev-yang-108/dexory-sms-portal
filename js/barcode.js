/*
  Barcode generation (JsBarcode, Code128) + two scan paths:
   (a) phone/tablet camera - native BarcodeDetector where available, else
       the @zxing/library UMD build loaded from CDN.
   (b) a handheld HID scanner acting as a keyboard wedge - it just "types"
       into whatever has focus, so a persistent hidden input stays focused
       whenever nothing else is, and Enter marks the end of a scan.
  JsBarcode and ZXing are loaded as plain <script> tags in index.html and
  attach themselves to window - this module is the only place that touches
  those globals.
*/

export function renderBarcodeInto(svgEl, partNumber) {
  if (!window.JsBarcode) return;
  window.JsBarcode(svgEl, partNumber, {
    format: "CODE128",
    displayValue: false,
    margin: 0,
    height: 60,
    width: 2
  });
}

// Saves the label (barcode + part number + locations) as a PNG straight from
// a canvas, so it works on tablets/phones where window.print() has no "save
// as" option or does nothing at all.
export function downloadBarcodePng(partNumber, locations) {
  if (!window.JsBarcode) return false;

  const bars = document.createElement("canvas");
  window.JsBarcode(bars, partNumber, { format: "CODE128", displayValue: false, margin: 0, height: 120, width: 4 });

  const pad = 40;
  const lines = [{ text: partNumber, font: "bold 44px monospace" }];
  if (locations) lines.push({ text: locations, font: "28px sans-serif" });

  const out = document.createElement("canvas");
  out.width = bars.width + pad * 2;
  out.height = pad + bars.height + 20 + lines.length * 52 + pad / 2;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(bars, pad, pad);
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  lines.forEach((l, i) => {
    ctx.font = l.font;
    ctx.fillText(l.text, out.width / 2, pad + bars.height + 20 + 44 + i * 52, out.width - pad);
  });

  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${String(partNumber).replace(/[^\w.-]+/g, "_")}-barcode.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
  return true;
}

// ---- Camera scanning ----

let activeStream = null;
let activeZxingReader = null;
let rafHandle = null;
let invertRafHandle = null;

function nativeDetectorSupported() {
  return "BarcodeDetector" in window;
}

/*
  An engraved/etched label can come out with reversed polarity - light bars
  on a dark background - rather than a normal printed barcode's dark bars on
  light. Neither BarcodeDetector nor ZXing's default decode reliably handles
  that on their own, so every scan attempt below tries the frame as-is first,
  then (only if that finds nothing) an inverted copy of the same frame.
*/
function grabFrameToCanvas(videoEl, canvas) {
  if (!videoEl.videoWidth) return null;
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return ctx;
}

function invertCanvas(ctx, canvas) {
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  ctx.putImageData(imgData, 0, 0);
}

export async function startCameraScanner(videoEl, onDecoded, onError) {
  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
  } catch (err) {
    onError && onError(err);
    return;
  }
  videoEl.srcObject = activeStream;
  await videoEl.play();

  if (nativeDetectorSupported()) {
    scanWithNativeDetector(videoEl, onDecoded, onError);
  } else if (window.ZXingBrowser || window.ZXing) {
    scanWithZxing(videoEl, onDecoded, onError);
  } else {
    onError && onError(new Error("No barcode scanning support available in this browser."));
  }
}

function scanWithNativeDetector(videoEl, onDecoded, onError) {
  let detector;
  try {
    detector = new window.BarcodeDetector({ formats: ["code_128"] });
  } catch (err) {
    onError && onError(err);
    return;
  }

  const invertCanvasEl = document.createElement("canvas");
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      let codes = await detector.detect(videoEl);
      if ((!codes || codes.length === 0)) {
        const ctx = grabFrameToCanvas(videoEl, invertCanvasEl);
        if (ctx) {
          invertCanvas(ctx, invertCanvasEl);
          codes = await detector.detect(invertCanvasEl);
        }
      }
      if (codes && codes.length > 0) {
        onDecoded(codes[0].rawValue);
        return; // caller stops the scanner once it has a hit
      }
    } catch (err) {
      // Transient decode errors are normal (blur, out of frame) - keep going.
    }
    rafHandle = requestAnimationFrame(tick);
  }
  rafHandle = requestAnimationFrame(tick);

  // stopCameraScanner() cancels rafHandle; nothing else to tear down here.
  return () => {
    stopped = true;
  };
}

function scanWithZxing(videoEl, onDecoded, onError) {
  try {
    const ZXing = window.ZXingBrowser || window.ZXing;
    const reader = new ZXing.BrowserMultiFormatReader();
    activeZxingReader = reader;
    /*
      decodeContinuously() is the library's own low-level polling loop: each
      tick it just draws whatever frame is currently on the video element
      onto an internal canvas and tries to decode that. Deliberately used
      instead of the higher-level decodeFromVideoElementContinuously(),
      which first awaits the video's "playing" event before it will start -
      an event that (at least on iOS Safari) doesn't reliably fire again for
      a video that's already playing by the time ZXing sees it, silently
      hanging forever with no error and no scan, even though the camera
      preview looks completely normal. decodeContinuously() has no such
      dependency - it just reads frames.
    */
    reader.decodeContinuously(videoEl, (result, err) => {
      if (result) {
        onDecoded(result.getText());
      }
    });

    // decodeContinuously() only tries the frame as captured, so a
    // reversed-polarity (light-on-dark) engraved/etched label - which reads
    // fine to a person but not like a normal printed barcode - won't decode
    // through it (confirmed: a synthetically-inverted barcode fails
    // ZXing's normal decode with "No MultiFormat Readers were able to
    // detect the code", but succeeds wrapped in InvertedLuminanceSource
    // below). This runs alongside as a separate, independent attempt on
    // each frame; wrapped defensively so if this @zxing/library version's
    // internals ever differ, this loop just never finds anything and the
    // normal decodeContinuously() path above is completely unaffected.
    const invertCanvasEl = document.createElement("canvas");
    function invertTick() {
      try {
        if (grabFrameToCanvas(videoEl, invertCanvasEl) && ZXing.HTMLCanvasElementLuminanceSource) {
          const source = new ZXing.InvertedLuminanceSource(new ZXing.HTMLCanvasElementLuminanceSource(invertCanvasEl));
          const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
          const result = reader.decodeBitmap(bitmap);
          if (result) {
            onDecoded(result.getText());
            return;
          }
        }
      } catch (err) {
        // NotFoundException (nothing in this frame) or an unsupported/
        // missing API - either way, just try again next frame.
      }
      invertRafHandle = requestAnimationFrame(invertTick);
    }
    invertRafHandle = requestAnimationFrame(invertTick);
  } catch (err) {
    onError && onError(err);
  }
}

export function stopCameraScanner(videoEl) {
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (invertRafHandle) {
    cancelAnimationFrame(invertRafHandle);
    invertRafHandle = null;
  }
  if (activeZxingReader) {
    try {
      activeZxingReader.reset();
    } catch (err) {
      /* no-op */
    }
    activeZxingReader = null;
  }
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }
  if (videoEl) videoEl.srcObject = null;
}

// ---- Keyboard-wedge (HID) scanner ----

let wedgeInput = null;

/*
  Handheld scanners just emit fast keystrokes ending in Enter into whatever
  element currently has focus - they need no camera and no button press.
  This keeps a hidden text input focused by default (off-screen, but a real
  focusable input so the OS routes the "typed" scan into it) and hands the
  scanned value to onScan() on Enter. It steps aside the moment the user
  focuses a real field (search box, a form input, a modal) and reclaims
  focus once nothing else needs it, so it never steals keystrokes meant for
  visible UI.
*/
export function initKeyboardWedge(onScan) {
  if (wedgeInput) return; // already initialized

  wedgeInput = document.createElement("input");
  wedgeInput.type = "text";
  wedgeInput.autocomplete = "off";
  wedgeInput.setAttribute("aria-hidden", "true");
  wedgeInput.tabIndex = -1;
  wedgeInput.className = "scanner-wedge-input";
  document.body.appendChild(wedgeInput);

  wedgeInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const value = wedgeInput.value.trim();
    wedgeInput.value = "";
    if (value) onScan(value);
  });

  function reclaimFocusIfIdle() {
    const active = document.activeElement;
    const nothingElseFocused = !active || active === document.body || active === wedgeInput;
    if (nothingElseFocused) wedgeInput.focus({ preventScroll: true });
  }

  document.addEventListener("focusout", () => {
    setTimeout(reclaimFocusIfIdle, 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) reclaimFocusIfIdle();
  });

  reclaimFocusIfIdle();
}

export function partNumberFromScannedText(text) {
  const trimmed = text.trim();
  const hashMatch = /#\/item\/([^/?#]+)/.exec(trimmed);
  if (hashMatch) return decodeURIComponent(hashMatch[1]);
  return trimmed;
}
