/* Work order detail: full fields, inline status edit, duplicate, and everything taken against it. */

import { esc, mount, setViewCleanup, formatDate, toast } from "../render.js";
import {
  subscribeWorkOrder,
  getWorkOrder,
  updateWorkOrderFields,
  listTransactionsForWorkOrder,
  recordWorkOrderReject,
  deleteReject,
  adjustWorkOrderCount,
  deleteAdjustment,
  cancelWorkOrder,
  deleteWorkOrder,
  listChildWorkOrders,
  remainingQty,
  completedQtyOf,
  rejectedQtyOf,
  WORK_ORDER_STATUSES,
  subscribeChildWorkOrders,
  setWorkOrderAssignee,
  listBatchesForPart,
  getStockItem,
  areaQty,
  DEDUCTION_AREA,
  dueDateOf,
  dueDateStatus
} from "../db.js";
import { populateUserSelect, wireUserSelect, resolveUser } from "../users.js";
import { navigate } from "../../app.js";

let woUnsub = null;
let childrenUnsub = null;

// weekOf is just a calendar date (midnight local time) - formatDate()'s
// date+time format would show a misleading "0:00" next to it.
function formatWeekDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function renderWorkOrderDetailView(woNo) {
  if (woUnsub) woUnsub();
  if (childrenUnsub) childrenUnsub();

  mount(`
    <header class="topbar">
      <button class="icon-btn" id="btn-back" aria-label="Back">&larr;</button>
      <div class="topbar-spacer"></div>
      <a class="pill-link" id="btn-edit" style="margin-right:8px;">Edit</a>
      <a class="pill-link" id="btn-duplicate">Duplicate</a>
    </header>
    <div id="wo-detail-body"><div class="empty-state">Loading…</div></div>
  `);

  document.getElementById("btn-back").onclick = () => navigate("#/work-orders");

  woUnsub = subscribeWorkOrder(woNo, (wo) => {
    if (!wo) {
      document.getElementById("wo-detail-body").innerHTML = `
        <div class="empty-state">Work order "${esc(woNo)}" was not found.</div>
      `;
      return;
    }

    // A Production Request (parent) has nothing to edit/duplicate as a
    // single order - it has no qty/batch/stock of its own, just the
    // schedule its children were generated from.
    const editBtn = document.getElementById("btn-edit");
    const duplicateBtn = document.getElementById("btn-duplicate");
    editBtn.style.display = wo.isParent ? "none" : "";
    duplicateBtn.style.display = wo.isParent ? "none" : "";

    if (wo.isParent) {
      renderParentBody(wo);
      return;
    }

    editBtn.onclick = () => navigate("#/work-orders/edit/" + encodeURIComponent(wo.woNo));
    duplicateBtn.onclick = () => {
      // Duplicating a finished order is almost always a rework case (that's
      // the only reason to want another round of a part that's already
      // shipped) - a small suggested prefix on the comment plus a linked
      // "-RW" number make that show up clearly in the new order's own list
      // row, both still fully editable/overridable before creating it.
      const isRework = wo.status === "Complete";
      const duplicateComment = isRework ? `(use for rework) ${wo.comment || ""}`.trim() : wo.comment || "";
      navigate(
        "#/work-orders/new?partNo=" +
          encodeURIComponent(wo.partNo) +
          "&rev=" +
          encodeURIComponent(wo.rev) +
          "&qty=" +
          encodeURIComponent(wo.qty) +
          "&comment=" +
          encodeURIComponent(duplicateComment) +
          (isRework ? "&reworkOf=" + encodeURIComponent(wo.woNo) : "")
      );
    };
    renderBody(wo);
  });

  setViewCleanup(() => {
    if (woUnsub) woUnsub();
    if (childrenUnsub) childrenUnsub();
    woUnsub = null;
    childrenUnsub = null;
  });
}

// Same green/orange/red as the Work Orders list's own small dot, used on
// each child row here too - plus a fuller banner (with the actual date,
// spelled out) for the order currently being viewed.
function dueDotHTML(wo) {
  const status = dueDateStatus(wo);
  if (!status) return "";
  const titles = { red: "Overdue", orange: "Due soon", green: "On track" };
  return `<span class="due-dot due-dot--${status}" title="${esc(titles[status])}"></span>`;
}

function dueBannerHTML(wo) {
  const status = dueDateStatus(wo);
  if (!status) return "";
  const due = dueDateOf(wo);
  const dueText = formatWeekDate(due);
  const label = status === "red" ? `Overdue — was due ${dueText}` : status === "orange" ? `Due soon — ${dueText}` : `On track — due ${dueText}`;
  return `<div class="due-banner due-banner--${status}"><span class="due-dot due-dot--${status}"></span>${esc(label)}</div>`;
}

function childStatusBadgeClass(status) {
  if (status === "Complete") return "type-badge--prototype";
  if (status === "Issued") return "type-badge--issued";
  if (status === "Cancelled") return "type-badge--cancelled";
  if (status === "Scheduled") return "type-badge--cancelled";
  return "type-badge--production";
}

function renderParentBody(wo) {
  document.getElementById("wo-detail-body").innerHTML = `
    <header class="item-header">
      <div class="item-header-number mono">${esc(wo.woNo)}</div>
      <div class="item-header-part">${esc(wo.partName)} · R${esc(wo.rev)} · Production request</div>
    </header>

    <section>
      <div class="kv">
        <div class="kv-row"><span class="k">Part no.</span><span class="v">${esc(wo.partNo)}</span></div>
        <div class="kv-row"><span class="k">Rev</span><span class="v">R${esc(wo.rev)}</span></div>
        <div class="kv-row"><span class="k">MRP Easy order no.</span><span class="v">${esc(wo.mrpOrderNo) || "—"}</span></div>
        <div class="kv-row"><span class="k">Creator</span><span class="v">${esc(wo.creator) || "—"}</span></div>
        <div class="kv-row"><span class="k">Created</span><span class="v">${formatDate(wo.createdAt)}</span></div>
        <div class="kv-row"><span class="k">Total scheduled</span><span class="v">${esc(wo.qty)} pcs across ${esc(wo.weekCount || 0)} week${wo.weekCount === 1 ? "" : "s"}</span></div>
      </div>
    </section>

    <section>
      <div class="section-title">Weekly work orders</div>
      <div id="wo-children-list"><div class="empty-state">Loading…</div></div>
    </section>

    <section>
      <button class="btn danger" id="btn-delete-wo">Delete production request</button>
    </section>
  `;

  document.getElementById("btn-delete-wo").onclick = () => openDeleteWoModal(wo);

  if (childrenUnsub) childrenUnsub();
  childrenUnsub = subscribeChildWorkOrders(wo.woNo, (children) => {
    const box = document.getElementById("wo-children-list");
    if (!box) return;
    if (children.length === 0) {
      box.innerHTML = `<div class="empty-state">No weekly work orders yet.</div>`;
      return;
    }
    box.innerHTML = children
      .map(
        (child) => `
        <div class="item-card" data-wo="${esc(child.woNo)}">
          <div class="item-card-main">
            <div class="item-stock-number mono">${dueDotHTML(child)}${esc(child.woNo)}</div>
            <div class="item-secondary">W/c ${formatWeekDate(child.weekOf)} · ${esc(child.qty)} pcs${child.assignee ? " · " + esc(child.assignee) : " · Unassigned"}</div>
          </div>
          <div class="item-card-qty">
            <span class="type-badge ${childStatusBadgeClass(child.status)}">${esc(child.status || "Scheduled")}</span>          </div>
        </div>
      `
      )
      .join("");
    box.querySelectorAll("[data-wo]").forEach((row) => {
      row.onclick = () => navigate("#/work-orders/" + encodeURIComponent(row.dataset.wo));
    });
  });
}

async function renderBody(wo) {
  const remaining = remainingQty(wo);
  const history = (wo.history || []).slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  document.getElementById("wo-detail-body").innerHTML = `
    <header class="item-header">
      <div class="item-header-number mono">${esc(wo.woNo)}</div>
      <div class="item-header-part">${esc(wo.partName)} · R${esc(wo.rev)}</div>
    </header>

    ${dueBannerHTML(wo)}

    <section>
      <div class="kv">
        <div class="kv-row"><span class="k">Part no.</span><span class="v">${esc(wo.partNo)}</span></div>
        <div class="kv-row"><span class="k">Rev</span><span class="v">R${esc(wo.rev)}</span></div>
        <div class="kv-row"><span class="k">Date</span><span class="v">${formatDate(wo.date)}</span></div>
        ${!wo.parentWoNo ? `<div class="kv-row"><span class="k">Due date</span><span class="v">${wo.dueDate ? formatWeekDate(wo.dueDate) : "—"}</span></div>` : ""}
        <div class="kv-row"><span class="k">Batch</span><span class="v">${esc(wo.batchNo) || "—"}</span></div>
        <div class="kv-row"><span class="k">Linked stock item</span><span class="v">${esc(wo.linkedStockNumber) || "—"}</span></div>
        ${
          wo.parentWoNo
            ? `<div class="kv-row"><span class="k">Production request</span><span class="v"><a href="#/work-orders/${encodeURIComponent(wo.parentWoNo)}" class="mono">${esc(wo.parentWoNo)}</a></span></div>
               <div class="kv-row"><span class="k">Week of</span><span class="v">${formatWeekDate(wo.weekOf)}</span></div>
               <div class="kv-row"><span class="k">MRP Easy order no.</span><span class="v">${esc(wo.mrpOrderNo) || "—"}</span></div>
               <div class="kv-row"><span class="k">Creator</span><span class="v">${esc(wo.creator) || "—"}</span></div>`
            : ""
        }
        ${
          wo.reworkOf
            ? `<div class="kv-row"><span class="k">Rework of</span><span class="v"><a href="#/work-orders/${encodeURIComponent(wo.reworkOf)}" class="mono">${esc(wo.reworkOf)}</a></span></div>`
            : ""
        }
      </div>
    </section>

    ${
      wo.status === "Scheduled"
        ? `<section>
             <div class="info-banner">Scheduled - no stock has been taken yet. <b>Machine shop:</b> set the assignee and batch to pick this up, which deducts ${esc(wo.qty)} pcs from Production at that point.</div>
             <div class="form-group">
               <label>Assignee (machine shop)</label>
               <select id="wo-assignee-user"></select>
             </div>
             <div class="form-group" id="wo-assignee-other-wrap" style="display:none;">
               <label>Name</label>
               <input id="wo-assignee-other-name" placeholder="Name" />
             </div>
             <div class="form-group">
               <label>Batch (machine shop)</label>
               <select id="wo-start-batch"><option value="" selected>Select a batch…</option></select>
               <div class="hint" id="wo-start-batch-hint"></div>
             </div>
             <div class="chip-row" style="padding:0 16px;">
               <button type="button" class="chip-toggle" id="btn-start-second-batch">+ Split across a second CoC/batch</button>
             </div>
             <div class="form-group" id="wo-start-batch2-wrap" style="display:none;">
               <label>Second batch</label>
               <select id="wo-start-batch2"><option value="" selected>Select a batch…</option></select>
               <div class="hint">Used when this order's material is drawn from two different CoC receipts (e.g. 10 pcs from one, 10 from the other) - both show on the order as "A" and "B".</div>
               <div class="form-grid2" style="margin-top:8px;">
                 <div class="form-group">
                   <label>Qty from A</label>
                   <input id="wo-start-qty-a" type="number" min="0" step="1" inputmode="numeric" />
                 </div>
                 <div class="form-group">
                   <label>Qty from B</label>
                   <input id="wo-start-qty-b" type="number" min="0" step="1" inputmode="numeric" />
                 </div>
               </div>
             </div>
             <div class="btn-row">
               <button class="btn primary-lime" id="btn-start-work">Assign &amp; start work</button>
             </div>
           </section>`
        : `<section>
      <div class="recon-row">
        <div class="recon-cell"><div class="num">${esc(wo.qty)}</div><div class="lbl">Ordered</div></div>
        <div class="recon-cell"><div class="num" style="color:var(--green);">${completedQtyOf(wo)}</div><div class="lbl">Completed</div></div>
        <div class="recon-cell"><div class="num rej">${rejectedQtyOf(wo)}</div><div class="lbl">Rejected</div></div>
        <div class="recon-cell"><div class="num rem">${remaining}</div><div class="lbl">Remaining</div></div>
      </div>
      <div class="action-row">
        <button class="action-btn action-bookin" id="btn-generate-idn">+ Generate IDN</button>
        <button class="action-btn action-take" id="btn-record-reject">− Record reject</button>
      </div>
      <button class="pill-link standalone-btn" id="btn-adjust-totals">Adjust Completed / Rejected</button>
      <div class="hint" style="padding:0 16px;">Ordered is edited on the Edit page (it can affect stock) - Remaining is always Ordered minus these two, never typed in directly.</div>
    </section>

    <section>
      <div class="section-title">Comment</div>
      <div class="kv"><div class="kv-row" style="display:block;"><span class="v" style="text-align:left;font-weight:400;">${wo.comment ? esc(wo.comment) : `<span style="color:var(--sub);">No comment.</span>`}</span></div></div>
    </section>

    <div class="form-group">
      <label>Status</label>
      <select id="wo-status-select">
        ${WORK_ORDER_STATUSES.map((s) => `<option ${s === wo.status ? "selected" : ""}>${esc(s)}</option>`).join("")}
      </select>
    </div>`
    }

    <section>
      <div class="section-title">Completion &amp; reject history</div>
      <div class="log-list" id="wo-history-log">${renderHistoryRows(history)}</div>
    </section>

    <section>
      <div class="section-title">Stock taken against this order</div>
      <div class="log-list" id="wo-log"><div class="empty-state">Loading…</div></div>
    </section>

    <section>
      <button class="btn danger" id="btn-cancel-wo">Cancel work order</button>
      <button class="btn danger" id="btn-delete-wo" style="margin-top:8px;">Delete work order</button>
    </section>
  `;

  if (wo.status === "Scheduled") {
    const assigneeSelect = document.getElementById("wo-assignee-user");
    const assigneeOtherWrap = document.getElementById("wo-assignee-other-wrap");
    populateUserSelect(assigneeSelect);
    wireUserSelect(assigneeSelect, assigneeOtherWrap);

    const batch1Select = document.getElementById("wo-start-batch");
    const batch2Select = document.getElementById("wo-start-batch2");
    const batch2Wrap = document.getElementById("wo-start-batch2-wrap");
    listBatchesForPart(wo.partNo).then((batches) => {
      if (!document.getElementById("wo-start-batch")) return;
      const options = batches
        .map((b) => `<option value="${esc(b.batchNo)}">${esc(b.batchNo)} (${esc(b.qtyAdded)} pcs, ${new Date(b.bookInDate).toLocaleDateString()})</option>`)
        .join("");
      batch1Select.insertAdjacentHTML("beforeend", options);
      batch2Select.insertAdjacentHTML("beforeend", options);
      if (batches.length === 0) document.getElementById("wo-start-batch-hint").textContent = "No batches booked in yet for this part.";
    });
    document.getElementById("btn-start-second-batch").onclick = (e) => {
      const nowOpen = batch2Wrap.style.display === "none";
      batch2Wrap.style.display = nowOpen ? "block" : "none";
      e.target.classList.toggle("is-active", nowOpen);
    };

    document.getElementById("btn-start-work").onclick = async () => {
      const assignee = await resolveUser(assigneeSelect, document.getElementById("wo-assignee-other-name"));
      if (!assignee) {
        toast("Enter a name.");
        return;
      }
      const stockKey = wo.linkedStockNumber || wo.partNo;
      if (stockKey) {
        const item = await getStockItem(stockKey);
        if (item) {
          const available = areaQty(item, DEDUCTION_AREA);
          if (wo.qty > available) {
            const proceed = window.confirm(
              `Production only has ${available} pcs of ${wo.linkedStockNumber}. Starting this will take it to ${available - wo.qty} (negative). Proceed anyway?`
            );
            if (!proceed) return;
          }
        }
      }
      // Same rule as before: the second batch only counts when its section is
      // open and both batches are picked; batchNo stays one combined display
      // string with the A/B split kept in cocDraws.
      const batch1No = batch1Select.value;
      const batch2No = batch2Wrap.style.display !== "none" ? batch2Select.value : "";
      let batchNo = batch1No;
      let cocDraws = [];
      if (batch1No && batch2No) {
        batchNo = `${batch1No} (A) + ${batch2No} (B)`;
        cocDraws = [
          { batchNo: batch1No, label: "A", qtyDrawn: Number(document.getElementById("wo-start-qty-a").value) || 0 },
          { batchNo: batch2No, label: "B", qtyDrawn: Number(document.getElementById("wo-start-qty-b").value) || 0 }
        ];
      }

      const btn = document.getElementById("btn-start-work");
      btn.disabled = true;
      btn.textContent = "Starting…";
      try {
        const { balanceAfter } = await setWorkOrderAssignee(wo, assignee, assignee, { batchNo, cocDraws });
        toast(
          balanceAfter === null
            ? `${wo.woNo} started — but no stock item matches ${wo.partNo}, so nothing was deducted.`
            : `${wo.woNo} started — stock deducted.`
        );
      } catch (err) {
        console.error(err);
        btn.disabled = false;
        btn.textContent = "Assign & start work";
        toast("Couldn't save — check your connection.");
      }
    };
  } else {
    document.getElementById("wo-status-select").onchange = async (e) => {
      const nextStatus = e.target.value;
      try {
        await updateWorkOrderFields(wo.woNo, { status: nextStatus });
        toast(`Status set to ${nextStatus}.`);
      } catch (err) {
        console.error(err);
        toast("Couldn't save — check your connection.");
      }
    };

    document.getElementById("btn-generate-idn").onclick = () => navigate("#/idns/new?woNo=" + encodeURIComponent(wo.woNo));
    document.getElementById("btn-record-reject").onclick = () => openRejectModal(wo, remaining);
    document.getElementById("btn-adjust-totals").onclick = () => openAdjustTotalsModal(wo);
  }

  document.getElementById("btn-cancel-wo").onclick = () => openCancelWoModal(wo);
  document.getElementById("btn-delete-wo").onclick = () => openDeleteWoModal(wo);

  document.querySelectorAll(".log-row-delete").forEach((btn) => {
    btn.onclick = () => {
      const entry = history.find((h) => String(h.timestamp) === btn.dataset.entryTimestamp);
      if (!entry) return;
      if (entry.type === "adjusted") {
        const proceed = window.confirm(`Undo this adjustment (${entry.field} ${entry.delta > 0 ? "+" : ""}${entry.delta})? This can't be undone.`);
        if (!proceed) return;
        deleteAdjustment(wo, entry).catch((err) => {
          console.error(err);
          toast("Couldn't delete — check your connection.");
        });
        return;
      }
      const proceed = window.confirm(
        `Delete this reject (${entry.qty} pcs${entry.returnedQty ? `, ${entry.returnedQty} of which had been returned to stock` : ""})? This can't be undone.`
      );
      if (!proceed) return;
      deleteReject(wo, entry).catch((err) => {
        console.error(err);
        toast("Couldn't delete — check your connection.");
      });
    };
  });

  const rows = await listTransactionsForWorkOrder(wo.woNo);
  const logEl = document.getElementById("wo-log");
  if (!logEl) return;

  if (rows.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Nothing taken against this order yet.</div>`;
    return;
  }

  logEl.innerHTML = rows
    .map(
      (t) => `
        <div class="log-row">
          <span class="delta neg mono">−${t.qty}</span>
          <span class="log-mid">${esc(t.stockNumber)} · ${esc(t.user)}${t.note ? " · " + esc(t.note) : ""}</span>
          <span class="log-date">${formatDate(t.timestamp)}</span>
        </div>
      `
    )
    .join("");
}

function renderHistoryRows(history) {
  if (history.length === 0) return `<div class="empty-state">Nothing completed or rejected yet.</div>`;
  return history
    .map((h) => {
      if (h.type === "completed") {
        return `
          <div class="log-row">
            <span class="delta pos mono">+${h.qty}</span>
            <span class="log-mid">${esc(h.idnNo)} · ${esc(h.user)}</span>
            <span class="log-date">${formatDate(h.timestamp)}</span>
          </div>
        `;
      }
      if (h.type === "adjusted") {
        const sign = h.delta > 0 ? "+" : "";
        const cls = h.delta > 0 ? "pos" : "neg";
        return `
          <div class="log-row">
            <span class="delta ${cls} mono">${sign}${h.delta}</span>
            <span class="log-mid">Adjusted ${esc(h.field)}${h.reason ? " · " + esc(h.reason) : ""} · ${esc(h.user)}</span>
            <span class="log-date">${formatDate(h.timestamp)}</span>
            <button class="icon-btn log-row-delete" data-entry-timestamp="${esc(h.timestamp)}" aria-label="Undo adjustment" title="Undo this adjustment">&times;</button>
          </div>
        `;
      }
      const returnedNote = h.returnedQty ? ` · ${h.returnedQty} pcs returned to stock` : "";
      return `
        <div class="log-row">
          <span class="delta neg mono">−${h.qty}</span>
          <span class="log-mid">${esc(h.reason || "Rejected")}${returnedNote} · ${esc(h.user)}</span>
          <span class="log-date">${formatDate(h.timestamp)}</span>
          <button class="icon-btn log-row-delete" data-entry-timestamp="${esc(h.timestamp)}" aria-label="Delete reject" title="Delete this reject">&times;</button>
        </div>
      `;
    })
    .join("");
}

function openRejectModal(wo, remaining) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Record reject</div>
      <div class="modal-sub">Never shows up on an IDN - just keeps this work order's own numbers honest. ${remaining} pcs remaining.</div>

      <div class="form-group">
        <label>Qty rejected</label>
        <input type="number" id="reject-qty" min="1" step="1" value="1" inputmode="numeric" />
      </div>

      <div class="form-group">
        <label>Reason</label>
        <input id="reject-reason" placeholder="e.g. Failed dimensional check" />
      </div>

      <div class="form-group">
        <label>Return to stock (optional)</label>
        <input type="number" id="reject-returned" min="0" step="1" value="0" inputmode="numeric" />
        <div class="hint">Only if the pulled material is salvageable - books this much back into the linked stock item. Leave at 0 if it's a straight loss.</div>
      </div>

      <div class="form-group">
        <label>User name</label>
        <select id="reject-user"></select>
      </div>
      <div class="form-group" id="reject-other-wrap" style="display:none;">
        <label>Name</label>
        <input id="reject-other-name" placeholder="Name" />
      </div>

      <div class="btn-row">
        <button class="btn" id="reject-cancel">Cancel</button>
        <button class="btn danger" id="reject-confirm">Record reject</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const userSelect = overlay.querySelector("#reject-user");
  const otherWrap = overlay.querySelector("#reject-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  overlay.querySelector("#reject-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#reject-confirm").onclick = async () => {
    const qty = Number(overlay.querySelector("#reject-qty").value);
    if (!qty || qty <= 0) {
      toast("Enter a quantity greater than 0.");
      return;
    }
    if (qty > remaining) {
      const proceed = window.confirm(`This work order only has ${remaining} pcs remaining, but this reject is for ${qty}. Record it anyway?`);
      if (!proceed) return;
    }
    const returnedQty = Number(overlay.querySelector("#reject-returned").value) || 0;
    if (returnedQty > qty) {
      toast("Can't return more than the qty rejected.");
      return;
    }
    const reason = overlay.querySelector("#reject-reason").value.trim();
    const user = await resolveUser(userSelect, overlay.querySelector("#reject-other-name"));
    if (!user) {
      toast("Enter a name.");
      return;
    }

    overlay.remove();
    toast("Reject recorded.");
    recordWorkOrderReject(wo, { qty, reason, returnedQty, user }).catch((err) => {
      console.error(err);
      toast("Couldn't save that change - check your connection.");
    });
  };
}

function openAdjustTotalsModal(wo) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Adjust Completed / Rejected</div>
      <div class="modal-sub">Type a new total for either - logged as a plain correction, not tied to an IDN or a reject. Leave either at its current value to not touch it.</div>

      <div class="form-grid2">
        <div class="form-group">
          <label>Completed</label>
          <input type="number" id="adjust-completed" min="0" step="1" value="${completedQtyOf(wo)}" inputmode="numeric" />
        </div>
        <div class="form-group">
          <label>Rejected</label>
          <input type="number" id="adjust-rejected" min="0" step="1" value="${rejectedQtyOf(wo)}" inputmode="numeric" />
        </div>
      </div>

      <div class="form-group">
        <label>Reason (optional)</label>
        <input id="adjust-reason" placeholder="e.g. Miscount, correcting a typo" />
      </div>

      <div class="form-group">
        <label>User name</label>
        <select id="adjust-user"></select>
      </div>
      <div class="form-group" id="adjust-other-wrap" style="display:none;">
        <label>Name</label>
        <input id="adjust-other-name" placeholder="Name" />
      </div>

      <div class="btn-row">
        <button class="btn" id="adjust-cancel">Cancel</button>
        <button class="btn primary-lime" id="adjust-confirm">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const userSelect = overlay.querySelector("#adjust-user");
  const otherWrap = overlay.querySelector("#adjust-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  overlay.querySelector("#adjust-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#adjust-confirm").onclick = async () => {
    const newCompleted = Number(overlay.querySelector("#adjust-completed").value);
    const newRejected = Number(overlay.querySelector("#adjust-rejected").value);
    if (newCompleted < 0 || newRejected < 0 || Number.isNaN(newCompleted) || Number.isNaN(newRejected)) {
      toast("Enter valid numbers.");
      return;
    }
    if (newCompleted === completedQtyOf(wo) && newRejected === rejectedQtyOf(wo)) {
      overlay.remove();
      return;
    }

    const reason = overlay.querySelector("#adjust-reason").value.trim();
    const user = await resolveUser(userSelect, overlay.querySelector("#adjust-other-name"));
    if (!user) {
      toast("Enter a name.");
      return;
    }

    overlay.remove();
    try {
      // Run one at a time (not in parallel) so the second adjustment's
      // auto-complete/reopen check sees the first one's effect, not a
      // stale snapshot from before either applied.
      let currentWo = wo;
      if (newCompleted !== completedQtyOf(currentWo)) {
        await adjustWorkOrderCount(currentWo, { field: "completed", newValue: newCompleted, reason, user });
        currentWo = (await getWorkOrder(wo.woNo)) || currentWo;
      }
      if (newRejected !== rejectedQtyOf(currentWo)) {
        await adjustWorkOrderCount(currentWo, { field: "rejected", newValue: newRejected, reason, user });
      }
      toast("Adjusted.");
    } catch (err) {
      console.error(err);
      toast("Couldn't save that change - check your connection.");
    }
  };
}

async function openDeleteWoModal(wo) {
  const children = wo.isParent ? await listChildWorkOrders(wo.woNo) : [];
  const held = (o) => !o.isParent && o.status !== "Scheduled" && o.status !== "Cancelled" && o.linkedStockNumber;
  const returning = [wo, ...children].filter(held);
  const hasProgress = [wo, ...children].some((o) => completedQtyOf(o) > 0);

  const what = wo.isParent
    ? `This permanently deletes ${esc(wo.woNo)} and its ${children.length} weekly work order${children.length === 1 ? "" : "s"}.`
    : `This permanently deletes ${esc(wo.woNo)}.`;
  const stock = returning.length
    ? ` Stock still held by ${returning.length === 1 ? "it" : returning.length + " of them"} goes back to Production.`
    : " No stock needs returning.";
  const warn = hasProgress
    ? ` Some pieces were already completed - their IDNs and history will point at an order that no longer exists.`
    : "";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Are you sure you want to delete ${esc(wo.woNo)}?</div>
      <div class="modal-sub">${what}${stock}${warn} This can't be undone. If you only want it out of the way, use Cancel instead.</div>

      <div class="form-group">
        <label>User name</label>
        <select id="delete-wo-user"></select>
      </div>
      <div class="form-group" id="delete-wo-other-wrap" style="display:none;">
        <label>Name</label>
        <input id="delete-wo-other-name" placeholder="Name" />
      </div>

      <div class="btn-row">
        <button class="btn" id="delete-wo-dismiss">Nevermind</button>
        <button class="btn danger" id="delete-wo-confirm">Yes, delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const userSelect = overlay.querySelector("#delete-wo-user");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, overlay.querySelector("#delete-wo-other-wrap"));

  overlay.querySelector("#delete-wo-dismiss").onclick = () => overlay.remove();
  overlay.querySelector("#delete-wo-confirm").onclick = async () => {
    const user = await resolveUser(userSelect, overlay.querySelector("#delete-wo-other-name"));
    if (!user) {
      toast("Enter a name.");
      return;
    }
    overlay.remove();
    try {
      await deleteWorkOrder(wo, user);
      toast(`${wo.woNo} deleted.`);
      navigate(wo.parentWoNo ? "#/work-orders/" + encodeURIComponent(wo.parentWoNo) : "#/work-orders");
    } catch (err) {
      console.error(err);
      toast("Couldn't delete — check your connection.");
    }
  };
}

function openCancelWoModal(wo) {
  const alreadyReturned = (wo.history || [])
    .filter((h) => h.type === "rejected")
    .reduce((sum, h) => sum + (h.returnedQty || 0), 0);
  const netToReturn = (wo.qty || 0) - alreadyReturned;
  const consequence =
    wo.status !== "Scheduled" && netToReturn > 0 && wo.linkedStockNumber
      ? `This returns ${netToReturn} pcs to ${wo.linkedStockNumber}'s Production stock. `
      : wo.status === "Scheduled"
        ? "No stock has been taken yet, so there's nothing to return. "
        : "";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Cancel work order</div>
      <div class="modal-sub">${consequence}${esc(wo.woNo)} stays on record as Cancelled - its IDNs, history and number aren't going anywhere, and you can change its status back from the dropdown any time (though that won't automatically re-deduct the stock this returns).</div>

      <div class="form-group">
        <label>User name</label>
        <select id="cancel-wo-user"></select>
      </div>
      <div class="form-group" id="cancel-wo-other-wrap" style="display:none;">
        <label>Name</label>
        <input id="cancel-wo-other-name" placeholder="Name" />
      </div>

      <div class="btn-row">
        <button class="btn" id="cancel-wo-dismiss">Nevermind</button>
        <button class="btn danger" id="cancel-wo-confirm">Cancel work order</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const userSelect = overlay.querySelector("#cancel-wo-user");
  const otherWrap = overlay.querySelector("#cancel-wo-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  overlay.querySelector("#cancel-wo-dismiss").onclick = () => overlay.remove();
  overlay.querySelector("#cancel-wo-confirm").onclick = async () => {
    const user = await resolveUser(userSelect, overlay.querySelector("#cancel-wo-other-name"));
    if (!user) {
      toast("Enter a name.");
      return;
    }

    overlay.remove();
    toast("Work order cancelled.");
    cancelWorkOrder(wo, user)
      .then(() => navigate("#/work-orders"))
      .catch((err) => {
        console.error(err);
        toast("Couldn't cancel — check your connection.");
      });
  };
}
