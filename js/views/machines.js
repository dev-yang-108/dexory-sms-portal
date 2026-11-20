/* Machines: the saved list the route card's machine dropdown picks from. Kept
   here, off the route card, so the card stays simple. A machine needs a name
   or a number, whatever the shop calls it. Removing one doesn't change route
   cards that already used it. */

import { esc, mount, toast } from "../render.js";
import { listMachines, addMachine, removeMachine, machineLabel } from "../db.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";

export async function renderMachinesView() {
  mount(`
    <div class="dx-app">
      ${dxNavHTML("machines")}
      <div class="dx-main">
        <div class="dx-content" style="max-width:720px;">
          <div class="dash-title">Machines</div>
          <div class="dash-sub">The machines the route card lets you pick from. Add one here, then choose it on the card.</div>
          <div class="fo-grid" style="padding:12px 16px 0;">
            <div class="form-group"><label>Machine name</label><input id="mc-name" placeholder="Waterjet" /></div>
            <div class="form-group"><label>Number</label><input id="mc-number" placeholder="WJ-02" /></div>
          </div>
          <div class="btn-row"><button class="btn primary-lime" id="mc-add">Add machine</button></div>
          <div id="mc-list" style="padding:8px 16px 16px;"></div>
        </div>
      </div>
    </div>
  `);
  wireSectionNav();

  async function paint() {
    const machines = await listMachines();
    const box = document.getElementById("mc-list");
    if (!box) return;
    box.innerHTML = machines.length
      ? machines
          .map(
            (m, i) => `<div class="fo-match" style="margin:0 0 6px;">
              <b>${esc(machineLabel(m))}</b>
              <button class="pill-link" data-remove="${i}">Remove</button>
            </div>`
          )
          .join("")
      : `<div class="empty-state">No machines saved yet.</div>`;
    box.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.onclick = async () => {
        const m = machines[Number(btn.dataset.remove)];
        if (!window.confirm(`Remove ${machineLabel(m)}? Route cards that already used it keep its name.`)) return;
        try {
          await removeMachine(m);
          toast("Machine removed.");
          paint();
        } catch (err) {
          console.error(err);
          toast("Couldn't remove — check your connection.");
        }
      };
    });
  }

  document.getElementById("mc-add").onclick = async () => {
    const name = document.getElementById("mc-name").value.trim();
    const number = document.getElementById("mc-number").value.trim();
    if (!name && !number) return void toast("Enter a machine name or number.");
    try {
      await addMachine({ name, number });
      document.getElementById("mc-name").value = "";
      document.getElementById("mc-number").value = "";
      toast("Machine saved.");
      paint();
    } catch (err) {
      console.error(err);
      toast("Couldn't save — check your connection.");
    }
  };

  paint();
}
