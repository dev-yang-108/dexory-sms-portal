/* Hash router + bootstrap. */

import { runViewCleanup, setMountHook } from "./js/render.js";
import { applyShell } from "./js/shell.js";
import { initKeyboardWedge } from "./js/barcode.js";
import { renderListView } from "./js/views/list.js";
import { renderDetailView } from "./js/views/detail.js";
import { renderFormView } from "./js/views/form.js";
import { renderScanView, handleScannedCode } from "./js/views/scan.js";
import { renderWorkOrdersListView } from "./js/views/work-orders-list.js";
import { renderWorkOrderFormView } from "./js/views/work-order-form.js";
import { renderWorkOrderDetailView } from "./js/views/work-order-detail.js";
import { renderWorkOrderEditView } from "./js/views/work-order-edit.js";
import { renderStockInView } from "./js/views/stock-in.js";
import { renderCocFormView } from "./js/views/coc-form.js";
import { renderIdnsListView } from "./js/views/idns-list.js";
import { renderIdnFormView } from "./js/views/idn-form.js";
import { renderIdnDetailView } from "./js/views/idn-detail.js";
import { renderDashboardView } from "./js/views/dashboard.js";
import { renderStockAvailabilityView } from "./js/views/stock-availability.js";
import { renderOrderCalculatorView } from "./js/views/order-calculator.js";
import { renderVerdaStockView } from "./js/views/verda-stock.js";
import { renderRejectReportView } from "./js/views/reject-report.js";
import { renderStockAddedView } from "./js/views/stock-added.js";
import { renderFloorHomeView, renderFloorAddView } from "./js/views/floor.js";
import { renderRouteCardsListView } from "./js/views/route-cards-list.js";
import { renderMachinesView } from "./js/views/machines.js";
import { renderRouteCardNewView } from "./js/views/route-card-new.js";
import { renderRouteCardDetailView } from "./js/views/route-card-detail.js";
import { USE_MOCK } from "./firebase-config.js";

export function navigate(hash) {
  if (location.hash === hash) {
    route();
  } else {
    location.hash = hash;
  }
}

function route() {
  runViewCleanup();

  const raw = location.hash || "#/";
  const [path, queryStr] = raw.split("?");
  const params = new URLSearchParams(queryStr || "");

  if (path === "#/" || path === "") {
    renderListView();
  } else if (path === "#/new") {
    renderFormView(null, {
      prefillPartNumber: params.get("code") || "",
      unrecognized: params.get("unrecognized") === "1"
    });
  } else if (path.startsWith("#/edit/")) {
    renderFormView(decodeURIComponent(path.slice("#/edit/".length)));
  } else if (path.startsWith("#/item/")) {
    renderDetailView(decodeURIComponent(path.slice("#/item/".length)));
  } else if (path === "#/scan") {
    renderScanView();
  } else if (path === "#/work-orders") {
    renderWorkOrdersListView();
  } else if (path === "#/work-orders/new") {
    renderWorkOrderFormView({
      partNo: params.get("partNo") || "",
      rev: params.get("rev") || "",
      qty: params.get("qty") || "",
      comment: params.get("comment") || "",
      reworkOf: params.get("reworkOf") || ""
    });
  } else if (path.startsWith("#/work-orders/edit/")) {
    renderWorkOrderEditView(decodeURIComponent(path.slice("#/work-orders/edit/".length)));
  } else if (path.startsWith("#/work-orders/")) {
    renderWorkOrderDetailView(decodeURIComponent(path.slice("#/work-orders/".length)));
  } else if (path === "#/stock-in") {
    renderStockInView();
  } else if (path === "#/coc/new") {
    renderCocFormView();
  } else if (path === "#/idns") {
    renderIdnsListView();
  } else if (path === "#/idns/new") {
    renderIdnFormView(params.get("woNo") || "");
  } else if (path.startsWith("#/idns/")) {
    renderIdnDetailView(decodeURIComponent(path.slice("#/idns/".length)));
  } else if (path === "#/dashboard") {
    renderDashboardView();
  } else if (path === "#/low-stock") {
    // The old Low Stock page lives in Stock availability now ("Low stock
    // only"); keep the address working for bookmarks.
    location.replace("#/stock-availability?low=1");
  } else if (path === "#/stock-availability") {
    renderStockAvailabilityView();
  } else if (path === "#/order-calculator") {
    renderOrderCalculatorView();
  } else if (path === "#/verda-stock") {
    renderVerdaStockView();
  } else if (path === "#/reject-report") {
    renderRejectReportView();
  } else if (path === "#/stock-added") {
    renderStockAddedView();
  } else if (path === "#/floor") {
    renderFloorHomeView();
  } else if (path === "#/floor/add/production") {
    renderFloorAddView("production");
  } else if (path === "#/floor/add/prototype") {
    renderFloorAddView("prototype");
  } else if (path === "#/machines") {
    renderMachinesView();
  } else if (path === "#/route-cards") {
    renderRouteCardsListView();
  } else if (path === "#/route-cards/new") {
    renderRouteCardNewView();
  } else if (path.startsWith("#/route-cards/")) {
    renderRouteCardDetailView(decodeURIComponent(path.slice("#/route-cards/".length)));
  } else {
    renderListView();
  }
}

setMountHook(applyShell);
window.addEventListener("hashchange", route);

/*
  Module scripts (this file included) only ever execute after the document
  has finished parsing, so the DOM is already ready by the time we get here
  - no need to wait for DOMContentLoaded. That event is in fact unsafe to
  wait for: firebase-config.js uses a top-level await (to dynamically import
  either the real CDN SDK or the ?mock=1 stand-in), which can push this
  module's own execution past the point where DOMContentLoaded already fired.
*/
route();
initKeyboardWedge(handleScannedCode);
if (USE_MOCK) {
  const banner = document.createElement("div");
  banner.className = "dev-mock-banner";
  banner.textContent = "DEV PREVIEW — mock backend, not real Firebase";
  document.body.prepend(banner);
}
