/* Shared "Who" picker: a select of known names + "+ Add new name", used by
   the qty modal, the new work order form, and the book-in-stock form. */

import { esc } from "./render.js";
import { listKnownUsers, ensureKnownUser, ADD_NAME_VALUE } from "./db.js";

export async function populateUserSelect(selectEl, selectedValue) {
  const names = await listKnownUsers();
  selectEl.innerHTML =
    names.map((n) => `<option ${n === selectedValue ? "selected" : ""}>${esc(n)}</option>`).join("") +
    `<option value="${ADD_NAME_VALUE}">+ Add new name…</option>`;
}

export function wireUserSelect(selectEl, otherWrapEl) {
  selectEl.onchange = () => {
    otherWrapEl.style.display = selectEl.value === ADD_NAME_VALUE ? "block" : "none";
  };
}

// Returns the chosen name, saving it to the known-users list if it's new.
// Returns null (and the caller should toast) if "+ Add new name" was picked
// but left blank.
export async function resolveUser(selectEl, otherInputEl) {
  if (selectEl.value !== ADD_NAME_VALUE) return selectEl.value;
  const name = otherInputEl.value.trim();
  if (!name) return null;
  await ensureKnownUser(name);
  return name;
}
