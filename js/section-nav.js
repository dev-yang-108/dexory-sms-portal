/* Shared "Stock Management / Work Orders / IDN" peer navigation, used at
   the top of all three top-level list screens - both the mobile header row
   and the desktop dx-nav rail render from this one place. */

import { esc } from "./render.js";
import { navigate } from "../app.js";

export const SECTIONS = [
  { key: "stock", label: "Stock Management", short: "Production Stock", hash: "#/" },
  { key: "orders", label: "Work Orders", short: "W. Orders", hash: "#/work-orders" },
  { key: "idn", label: "IDN", short: "IDN", hash: "#/idns" }
];

// The desktop portal sidebar (hidden below 860px, where the tab bar below
// takes over). The mobile SECTIONS above stay as they were.
export const NAV_GROUPS = [
  // The first group has no heading: Dashboard (everyone's home) and Floor view
  // (stock in, CoCs, scanning) sit at the top by themselves.
  {
    label: "",
    items: [
      { key: "dashboard", label: "Dashboard", hash: "#/dashboard" },
      { key: "floor", label: "Floor view", hash: "#/floor" }
    ]
  },
  {
    label: "Operations",
    items: [
      { key: "orders", label: "Work orders", hash: "#/work-orders" },
      { key: "route-cards", label: "Route cards", hash: "#/route-cards" },
      { key: "idn", label: "IDNs", hash: "#/idns" }
    ]
  },
  {
    label: "Stock",
    items: [
      { key: "stock", label: "Production stock", hash: "#/" },
      { key: "verda-stock", label: "Prototype stock", hash: "#/verda-stock" },
      { key: "stock-availability", label: "Stock availability", hash: "#/stock-availability" },
      { key: "stock-added", label: "Stock added", hash: "#/stock-added" }
    ]
  },
  {
    label: "Planning",
    items: [
      { key: "order-calculator", label: "Order calculator", hash: "#/order-calculator" }
    ]
  },
  { label: "Reports", items: [{ key: "reject-report", label: "Rejects", hash: "#/reject-report" }] },
  { label: "Settings", items: [{ key: "machines", label: "Machines", hash: "#/machines" }] }
];

export function navEntry(key) {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.key === key);
    if (item) return { group: group.label, label: item.label };
  }
  return { group: "Stock", label: "Production stock" };
}

// Pages without a sidebar entry of their own (an item, a form, scan...) sit
// under the section they belong to.
export function navKeyForHash(hash) {
  const path = (hash || "#/").split("?")[0];
  if (path.startsWith("#/work-orders")) return "orders";
  if (path.startsWith("#/route-cards")) return "route-cards";
  if (path.startsWith("#/idns")) return "idn";
  if (path === "#/dashboard") return "dashboard";
  if (path === "#/stock-availability") return "stock-availability";
  if (path === "#/order-calculator") return "order-calculator";
  if (path === "#/verda-stock") return "verda-stock";
  if (path === "#/reject-report") return "reject-report";
  if (path === "#/stock-added") return "stock-added";
  if (path === "#/machines") return "machines";
  // Add CoC is reached from Floor view now, so it sits under it.
  if (path.startsWith("#/coc")) return "floor";
  return "stock";
}

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
    <nav class="dx-nav" aria-label="Main">
      <div class="dx-brand">
        <div class="dx-brand-word">Dexory</div>
        <div class="dx-brand-name">SMS portal</div>
        <div class="dx-brand-sub">Stock management system</div>
      </div>
      ${NAV_GROUPS.map(
        (g) => `
          ${g.label ? `<div class="dx-grp">${esc(g.label)}</div>` : ""}
          ${g.items
            .map(
              (i) =>
                `<button class="dx-link ${i.key === activeKey ? "is-active" : ""}" data-hash="${esc(i.hash)}">${esc(i.label)}${
                  // Cards waiting for quality; filled in by quality-notify.js.
                  i.key === "route-cards" ? ` <span class="dx-badge" data-rc-badge hidden>0</span>` : ""
                }</button>`
            )
            .join("")}
        `
      ).join("")}
    </nav>
  `;
}

export function wireSectionNav(root) {
  (root || document).querySelectorAll("[data-hash]").forEach((el) => {
    el.onclick = () => navigate(el.dataset.hash);
  });
}
