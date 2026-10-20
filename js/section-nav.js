/* Shared "Stock Management / Work Orders / IDN" peer navigation, used at
   the top of all three top-level list screens - both the mobile header row
   and the desktop dx-nav rail render from this one place. */

import { esc } from "./render.js";
import { navigate } from "../app.js";

export const SECTIONS = [
  { key: "stock", label: "Stock Management", short: "Stock", hash: "#/" },
  { key: "orders", label: "Work Orders", short: "W. Orders", hash: "#/work-orders" },
  { key: "idn", label: "IDN", short: "IDN", hash: "#/idns" }
];

// The extra icon-style rail buttons below the main three sections - each a
// standalone report/tool rather than a peer section, so they get their own
// icon + short label instead of living in SECTIONS (which also drives the
// mobile tab bar - these stay desktop-rail-only for now).
const EXTRAS = [
  { key: "dashboard", hash: "#/dashboard", icon: "📊", label: "Dashboard", cls: "" },
  { key: "low-stock", hash: "#/low-stock", icon: "⚠️", label: "Low Stock", cls: "dx-nav-dash--warn" },
  { key: "reject-report", hash: "#/reject-report", icon: "🚫", label: "Rejects", cls: "dx-nav-dash--report" }
];

// Reuses the same visual language as the Production/Prototype tabs
// (.type-tabs/.type-tab) - a row of text tabs with a lime bottom-border
// indicator - so this reads as one consistent tab pattern, not a second one.
export function sectionTabsHTML(activeKey) {
  return `
    <div class="type-tabs" id="section-tabs">
      ${SECTIONS.map(
        (s) => `<button class="type-tab ${s.key === activeKey ? "is-active" : ""}" data-hash="${esc(s.hash)}">${esc(s.label)}</button>`
      ).join("")}
    </div>
  `;
}

export function dxNavHTML(activeKey) {
  return `
    <div class="dx-nav">
      <div class="dx-logo"></div>
      ${SECTIONS.map(
        (s) => `<button class="dx-nav-item ${s.key === activeKey ? "is-active" : ""}" data-hash="${esc(s.hash)}">${esc(s.short)}</button>`
      ).join("")}
      <div class="dx-nav-divider"></div>
      ${EXTRAS.map(
        (e) => `
        <button class="dx-nav-dash ${e.cls} ${e.key === activeKey ? "is-active" : ""}" data-hash="${esc(e.hash)}" title="${esc(e.label)}" aria-label="${esc(e.label)}">
          <span class="dx-nav-dash-icon">${e.icon}</span>
          <span class="dx-nav-dash-label">${esc(e.label)}</span>
        </button>
      `
      ).join("")}
    </div>
  `;
}

export function wireSectionNav(root) {
  (root || document).querySelectorAll("[data-hash]").forEach((el) => {
    el.onclick = () => navigate(el.dataset.hash);
  });
}
