(function(){
  const $ = (id)=>document.getElementById(id);
  // Inline SVG icons (logout / trash) — used instead of an icon-font CDN so
  // they always render, even if a webfont fails to load or gets blocked.
  const ICON_LOGOUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/><path d="M9 12h12l-3-3"/><path d="M18 15l3-3"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>';
  let patients = {};
  let patientUpdatedAt = {}; // patient id -> server's updated_at at the time we last loaded/saved it; used to detect if someone else has saved changes since we opened a record
  let loaded = false;
  let currentCampus = 'all'; // scope for Dashboard / Eagle
  let roomCampus = (function(){ try{ return localStorage.getItem('aps-room-campus') || 'Main Campus'; }catch(e){ return 'Main Campus'; } })(); // Room (Rounds+Updates) always shows exactly one campus
  let roomSubTab = (function(){ try{ return localStorage.getItem('aps-room-subtab') || 'rounds'; }catch(e){ return 'rounds'; } })(); // 'rounds' | 'updates' | 'bolus'

  // Hospital No is the real primary key now — this normalizes it so
  // "H023 4871", "h0234871" and "H0234871" all resolve to the same record.
  function patientKey(hospitalNo){
    return (hospitalNo||'').toString().trim().toUpperCase().replace(/\s+/g,'');
  }

  // One-time migration from the old shared-index model (aps-index +
  // aps-patient:<randomId>) to the new model (patient:<HOSPITALNO>).
  // Safe to run more than once — re-migrating the same legacy record just
  // overwrites the same destination key with the same data.
  async function migrateLegacyData(){
    try{
      const flag = await window.storage.get('aps-migrated-v2', true);
      if(flag && flag.value==='true') return;
    }catch(e){ /* flag not set yet — proceed with migration check */ }
    try{
      const idxRes = await window.storage.get('aps-index', true);
      const oldIds = idxRes && idxRes.value ? JSON.parse(idxRes.value) : [];
      for(const oldId of oldIds){
        try{
          const r = await window.storage.get('aps-patient:'+oldId, true);
          if(r && r.value){
            const p = JSON.parse(r.value);
            const hno = (p.hospitalNo && p.hospitalNo.trim()) ? p.hospitalNo.trim() : ('LEGACY-'+oldId);
            const key = patientKey(hno);
            p.id = key;
            p.hospitalNo = hno;
            p.campus = p.campus || 'Main Campus';
            await window.storage.set('patient:'+key, JSON.stringify(p), true);
            await window.storage.delete('aps-patient:'+oldId, true).catch(()=>{});
          }
        }catch(e){ /* skip this one, move on */ }
      }
      await window.storage.delete('aps-index', true).catch(()=>{});
    }catch(e){ /* no legacy aps-index found — nothing to migrate */ }
    try{
      const oldFeed = await window.storage.get('aps-team-updates', true);
      if(oldFeed && oldFeed.value){
        // Old app had one global feed — fold it into Main Campus's feed
        // rather than lose it, since that's where the team was originally.
        let existing = [];
        try{
          const mainFeed = await window.storage.get('aps-team-updates:Main Campus', true);
          existing = mainFeed && mainFeed.value ? JSON.parse(mainFeed.value) : [];
        }catch(e){}
        const legacy = JSON.parse(oldFeed.value);
        const merged = existing.concat(legacy).sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0,50);
        await window.storage.set('aps-team-updates:Main Campus', JSON.stringify(merged), true);
        await window.storage.delete('aps-team-updates', true).catch(()=>{});
      }
    }catch(e){ /* no legacy team-updates feed found */ }
    try{ await window.storage.set('aps-migrated-v2', 'true', true); }catch(e){}
  }

  async function loadAll(){
    await migrateLegacyData();
    // Purge any local storage keys created by previous demo testing
    try {
      const lKeys = Object.keys(localStorage);
      for(const k of lKeys){
        if(k.includes('DEMO') || k.includes('demo')){
          localStorage.removeItem(k);
        }
      }
    } catch(e){}

    patients = {};
    try{
      // Single bulk request for every patient record, instead of a
      // list() + one get() per patient — keeps this fast as the census
      // (active + discharged history) grows into the hundreds.
      const res = await window.storage.getAllByPrefix('patient:', true);
      const items = (res && res.items) || [];
      for(const item of items){
        try{
          if(item && item.value){
            const p = JSON.parse(item.value);
            // Drop and purge any lingering fake demo patient
            if(p && ((p.hospitalNo && p.hospitalNo.toUpperCase().startsWith('DEMO')) || (p.id && p.id.toUpperCase().startsWith('DEMO')))){
              try { await window.storage.delete('patient:'+p.id, true); } catch(e){}
              continue;
            }
            patients[p.id] = p;
            if(item.updated_at) patientUpdatedAt[p.id] = item.updated_at;
          }
        }catch(e){}
      }
    }catch(e){
      console.error('Load failed:', errMsg(e));
      toast('Could not load shared data: '+errMsg(e), 5000);
    }
    loaded = true;
  }
  async function savePatient(p){
    const res = await window.storage.set('patient:'+p.id, JSON.stringify(p), true);
    if(res && res.updated_at) patientUpdatedAt[p.id] = res.updated_at;
  }

  // Checks whether the server's copy of this patient has moved on since
  // `openedAt` (the timestamp we had when the sheet was opened). Returns:
  //   false      — no conflict, safe to save
  //   'edited'   — someone else saved a change to this patient since we opened it
  //   'deleted'  — the patient no longer exists server-side
  // A generic lookup problem (network hiccup, DB error) still fails "open"
  // (returns false, allows the save) — an occasional missed conflict there is
  // better than blocking every save whenever the network hiccups. BUT a
  // genuine "not found" is never treated as fail-open: that's exactly the
  // case where allowing the save would silently recreate ("resurrect") a
  // patient someone else deleted, via savePatient's blind upsert.
  async function hasConflict(id, openedAt){
    if(!openedAt) return false;
    try{
      const r = await window.storage.get('patient:'+id, true);
      if(!r || !r.updated_at) return false;
      // Compare as actual instants, not raw strings — Supabase/PostgREST can
      // return updated_at in a different (but equivalent) ISO format than the
      // client sent on write (e.g. "...123Z" vs "...123000+00:00"), which
      // would otherwise make every save look like a conflict with itself.
      const a = new Date(r.updated_at).getTime();
      const b = new Date(openedAt).getTime();
      if(isNaN(a) || isNaN(b)) return r.updated_at !== openedAt ? 'edited' : false; // fallback if either fails to parse
      return a !== b ? 'edited' : false;
    }catch(e){
      if(e && e.doloraNotFound) return 'deleted';
      return false;
    }
  }

  // Field-level-safe save for quick, self-contained edits (attendance,
  // discharge, reactivate, bolus logging). Unlike savePatient(p) — which
  // blindly upserts whatever's in memory and can clobber a colleague's
  // concurrent edit to an unrelated field — this re-fetches the server's
  // current copy right before writing and applies `mutator` on top of THAT,
  // not on top of our possibly-stale local copy. So if someone else changed
  // the drug or ward while we had the sheet open, our attendance toggle (say)
  // still lands on top of their change instead of erasing it.
  // The Day Review "Save" flow deliberately keeps its own separate
  // hasConflict()-based warn-and-reload behavior instead of using this —
  // that flow can carry several unsaved field edits at once, so a silent
  // merge there could mix half of one person's edits with half of another's.
  // This helper is only for single-field, idempotent-style actions where a
  // silent merge onto the latest state is unambiguously correct.
  async function savePatientField(id, mutator){
    let base;
    try{
      const r = await window.storage.get('patient:'+id, true);
      base = JSON.parse(r.value);
    }catch(e){
      if(e && e.doloraNotFound){
        // The patient existed locally but the server has no record of it —
        // someone else deleted it. Falling back to our stale local copy here
        // would upsert it right back in, silently undoing that delete.
        // Block the save instead; the caller must refresh to continue.
        const err = new Error('This patient was deleted elsewhere and no longer exists.');
        err.doloraDeleted = true;
        throw err;
      }
      // Generic network/DB error (not a "not found") — fall back to the
      // local cache, same as before, so a transient hiccup doesn't block
      // an otherwise-legitimate save.
      base = patients[id];
    }
    if(!base) throw new Error('patient not found');
    mutator(base);
    const res = await window.storage.set('patient:'+base.id, JSON.stringify(base), true);
    if(res && res.updated_at) patientUpdatedAt[base.id] = res.updated_at;
    // Update the in-memory cache to match what was actually saved, in place —
    // so any open UI (e.g. the Details sheet's `p`, which is the same object
    // reference as patients[id]) picks up the merged result automatically.
    const cached = patients[base.id];
    if(cached && cached !== base){
      Object.keys(cached).forEach(k=>delete cached[k]);
      Object.assign(cached, base);
    } else {
      patients[base.id] = base;
    }
    return patients[base.id];
  }

  // Shared cleanup for "we just found out this patient was deleted by
  // someone else" — drops the stale local copy so we stop trying to save
  // on top of it, closes the Details sheet if it happened to be open for
  // this patient, and lets the user know what happened.
  function handleDeletedElsewhere(id){
    delete patients[id];
    delete patientUpdatedAt[id];
    closeDetail();
    renderAll();
    toast('This patient was deleted elsewhere and no longer exists.', 5000);
  }

  // Quiet background attribution — no UI surfaces this yet (no Admin
  // screen exists to browse it), but every edit/discharge/reactivate is
  // stamped now so the history exists once a review screen is built.
  function logActivity(p, action){
    p.activityLog = p.activityLog || [];
    p.activityLog.push({
      ts: Date.now(),
      action, // 'edited' | 'discharged' | 'reactivated'
      by: (window.doloraUser && window.doloraUser.name) || 'Unknown',
      byId: (window.doloraUser && window.doloraUser.id) || null
    });
    if(p.activityLog.length > 200) p.activityLog = p.activityLog.slice(-200); // keep each record bounded
  }

  // Delete removes the whole patient record, so attribution can't live on
  // it — this writes a separate, durable entry that survives the deletion.
  async function recordDeletion(p){
    try{
      await window.storage.set('deletion-log:'+p.id+':'+Date.now(), JSON.stringify({
        patientId: p.id,
        hospitalNo: p.hospitalNo,
        name: p.name,
        ward: p.ward,
        campus: p.campus,
        deletedAt: Date.now(),
        deletedBy: (window.doloraUser && window.doloraUser.name) || 'Unknown',
        deletedById: (window.doloraUser && window.doloraUser.id) || null
      }), true);
    }catch(e){ /* best-effort — never block the deletion itself on this */ }
  }

  // ---------- Team updates (private chat feed, one per campus room) ----------
  let teamUpdates = []; // holds whatever's currently displayed — always exactly one campus's feed
  async function loadTeamUpdatesFor(campus){
    try{
      const r = await window.storage.get('aps-team-updates:'+campus, true);
      return r && r.value ? JSON.parse(r.value) : [];
    }catch(e){ return []; }
  }
  async function loadTeamUpdates(){
    teamUpdates = await loadTeamUpdatesFor(roomCampus);
  }
  async function saveTeamUpdates(campus, updates){
    const trimmed = updates.slice(0,50); // keep each campus's feed bounded
    await window.storage.set('aps-team-updates:'+campus, JSON.stringify(trimmed), true);
  }
  function timeAgo(ts){
    const diff = Math.max(0, Date.now()-ts);
    const min = Math.floor(diff/60000);
    if(min<1) return 'just now';
    if(min<60) return min+'m ago';
    const hr = Math.floor(min/60);
    if(hr<24) return hr+'h ago';
    return Math.floor(hr/24)+'d ago';
  }
  function renderTeamUpdates(){
    const feed = $('updateFeed');
    if(!feed) return;
    // teamUpdates is stored/sorted newest-first; render oldest-to-newest so the
    // latest message lands at the bottom, right next to the input box —
    // like a normal chat thread.
    const chronological = teamUpdates.slice().reverse();
    feed.innerHTML = chronological.length ? chronological.map(u=>`
      <div class="update-item">
        <div class="update-avatar">${escapeHtml(initials(u.by))}</div>
        <div>
          <div class="update-text">${escapeHtml(u.text)}</div>
          <div class="update-meta">${u.by ? escapeHtml(u.by)+' · ' : ''}${timeAgo(u.ts)}</div>
        </div>
      </div>`).join('') : '<div class="empty" style="padding:10px;"><p>No updates yet — be the first to post one.</p></div>';
    feed.scrollTop = feed.scrollHeight;
  }
  async function postTeamUpdate(){
    const textEl = $('updateText');
    const text = textEl.value.trim();
    if(!text) return;
    teamUpdates.unshift({
      id: uid(),
      text,
      ts: Date.now(),
      by: (window.doloraUser && window.doloraUser.name) || 'Unknown',
      byId: (window.doloraUser && window.doloraUser.id) || null
    });
    textEl.value = '';
    await saveTeamUpdates(roomCampus, teamUpdates);
    renderTeamUpdates();
    toast('Posted to '+roomCampus);
  }

  function initials(name){
    const s = (name||'').trim();
    if(!s) return '·';
    const parts = s.split(/\s+/);
    return (parts[0][0]+(parts[1]?parts[1][0]:'')).toUpperCase();
  }
  function toast(msg, duration){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), duration||1800); }
  // Pulls a clean, safe-to-log string out of any error shape (network errors,
  // Supabase errors, plain Errors) so console.error/toast never choke trying
  // to serialize a raw error object with non-cloneable internals.
  function errMsg(e){
    if(!e) return 'Unknown error';
    return e.message || e.error_description || e.details || e.hint || String(e);
  }
  function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
  function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  // ---------- Hospital calendar day (Asia/Kolkata) ----------
  // Every "today"/day-boundary concept in the app (attendance, rounds
  // glimpse, dashboard counts, day-stamps on save) must agree on what
  // calendar date it currently is at the hospital — not whatever UTC
  // date or browser-local date the device happens to be on. IST has no
  // DST, so this is a fixed +5:30 offset, but we let Intl resolve it
  // rather than hardcoding the offset by hand.
  const HOSPITAL_TZ = 'Asia/Kolkata';
  // en-CA locale formats as YYYY-MM-DD, which lines up with the date-input
  // value format already used everywhere else in the app (p.apsDate, day
  // stamps, etc.) — no downstream parsing changes needed.
  function todayStr(){ return new Date().toLocaleDateString('en-CA', {timeZone: HOSPITAL_TZ}); }
  // Exposed so the separate auth-gate/demo-mode script (below, outside this
  // closure) shares the exact same "what day is it at the hospital" logic
  // instead of re-deriving its own — one helper, one source of truth.
  window.doloraTodayStr = todayStr;
  // Converts a YYYY-MM-DD date-input value (e.g. p.apsDate) into DD-MM-YY
  // for compact display on the Rounds card.
  function fmtDDMMYY(dateStr){
    if(!dateStr) return '—';
    const parts = dateStr.split('-');
    if(parts.length!==3) return dateStr;
    const [y,m,d] = parts;
    return `${d}-${m}-${y.slice(-2)}`;
  }
  // Day 0 = APS Date itself, Day 1 = APS Date + 1, etc. — the CLINICAL date a
  // day-slot represents, independent of when it was actually entered/saved.
  // Returns a YYYY-MM-DD string, or null if apsDate is missing.
  function dayCalendarDate(apsDate, idx){
    if(!apsDate) return null;
    const d = new Date(apsDate+'T12:00:00');
    if(isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + Number(idx||0));
    return d.toLocaleDateString('en-CA', {timeZone: HOSPITAL_TZ});
  }
  // Rounds "glimpse" text — only ever shows a remark saved TODAY, so it
  // self-resets every 24h without any timer/cron: once the calendar date
  // rolls over, todayStr() no longer matches yesterday's stamp and the
  // glimpse falls back to "Not reviewed yet today" on its own.
  function todaysGlimpse(p){
    const today = todayStr();
    for(let d=5; d>=0; d--){
      const dObj = getDay(p, d);
      if(dObj.stamp === today){
        // Reviewed today — return the note if one was written, or '' if the
        // day was saved with no note. Either way this is NOT "not reviewed".
        return (dObj.remarks && dObj.remarks.trim()) ? dObj.remarks.trim() : '';
      }
    }
    return null; // genuinely not reviewed at all today
  }
  // ---------- Dose-holder abstraction ----------
  // A "dose holder" is any object that carries day0..day5 + drug/frequency/
  // freqType/startedAt/boluses — today that's always the patient object `p`,
  // but from the multi-catheter work onward it can also be a single entry in
  // p.catheters. All the *Raw functions below operate on a generic holder so
  // this logic is written once and reused for both shapes. The originally-named
  // functions (getDay, effectiveDose, lastBolusAt, etc.) are kept as thin
  // wrappers that just forward the patient object as the holder — so every
  // existing call site (Rounds, Bolus, Bird's Eye, export) behaves exactly as
  // before with zero visible change.
  function getDayRaw(holder, idx){
    const v = holder['day'+idx];
    if(v && typeof v === 'object') return {
      stamp: v.stamp||null,
      painRest: v.painRest||'',
      painMove: v.painMove||'',
      motorBlock: v.motorBlock||'',
      dermCover: v.dermCover||'',
      catheterSite: v.catheterSite||'',
      remarks: v.remarks!=null ? v.remarks : (v.note||''), // legacy note -> remarks
      drug: v.drug!=null ? v.drug : null,
      frequency: v.frequency!=null ? v.frequency : null,
      freqType: v.freqType!=null ? v.freqType : null,
      startedAt: v.startedAt!=null ? v.startedAt : null
    };
    return {stamp:null, painRest:'',painMove:'',motorBlock:'',dermCover:'',catheterSite:'',remarks:v||'', drug:null, frequency:null, freqType:null, startedAt:null};
  }
  function getDay(p, idx){ return getDayRaw(p, idx); }
  // Walks backward from `idx` to Day 0 looking for the nearest day that has its
  // own recorded dose. Lets an unsaved day show what was last actually prescribed
  // instead of a blank field, while still leaving a trail of exactly which day
  // each dose change was recorded on. Falls back to the legacy top-level fields
  // on the holder itself for patients/catheters created before per-day dosing
  // existed.
  function effectiveDoseRaw(holder, idx){
    for(let i=idx;i>=0;i--){
      const dd = getDayRaw(holder, i);
      if(dd.drug!=null || dd.frequency!=null || dd.freqType!=null || dd.startedAt){
        // A fresh Started-at recorded on ANY day (not just Day 0/1) becomes the new
        // bolus anchor from that day forward — e.g. Continuous -> Q8H switched on
        // Day 3 is treated as a brand new "first bolus" moment, same as Day 0.
        return {drug:dd.drug||'', frequency:dd.frequency||'', freqType:dd.freqType||'', startedAt:dd.startedAt||'', stamp:dd.stamp||null, fromDay:i, own:i===idx};
      }
    }
    return {drug:holder.drug||'', frequency:holder.frequency||'', freqType:holder.freqType||'', startedAt:holder.startedAt||'', stamp:(holder.day0&&holder.day0.stamp)||null, fromDay:null, own:false};
  }
  function effectiveDose(p, idx){ return effectiveDoseRaw(p, idx); }
  // Keeps the top-level drug/frequency/freqType fields (read by the Rounds
  // card, Bolus board, Bird's Eye, and Excel export) in sync with whichever
  // day currently holds the most recent recorded dose — chosen by day number,
  // not save order, since Day 3 is clinically "later" than Day 1 even if Day 1
  // happens to be edited afterward.
  function syncCurrentDoseMirror(p){
    // For NBC patients with (up to two) catheters, mirror from the first
    // active catheter — this keeps the Bolus board, Bird's Eye, and export
    // showing something sensible for a 2-catheter patient until Stages 3–4
    // make those screens fully catheter-aware. Every other mode is
    // untouched: the holder is the patient itself, same as before.
    const holder = (p.mode==='NBC' && p.catheters && p.catheters.length)
      ? (activeCatheters(p)[0] || p.catheters[0])
      : p;
    const eff = effectiveDoseRaw(holder, 5);
    p.drug = eff.drug;
    p.frequency = eff.frequency;
    p.freqType = eff.freqType;
    p.startedAt = eff.startedAt;
    p.startedAtStamp = eff.stamp;
  }
  // Same idea as syncCurrentDoseMirror, but for one catheter: keeps a
  // catheter's own top-level drug/frequency/freqType/startedAt in sync with
  // its most recent day so isBolusEligible/lastBolusAt/nextBolusDueAt (which
  // read those top-level fields directly) work correctly per catheter. Call
  // this whenever a specific catheter's day record is saved.
  function syncCatheterDoseMirror(cath){
    const eff = effectiveDoseRaw(cath, 5);
    cath.drug = eff.drug;
    cath.frequency = eff.frequency;
    cath.freqType = eff.freqType;
    cath.startedAt = eff.startedAt;
    cath.startedAtStamp = eff.stamp;
  }
  // ---------- Catheters (NBC multi-catheter support) ----------
  // Returns the list of catheters for a patient. NBC patients can have up to
  // two (Femoral/Sciatic-style, free-text labelled); every other mode is
  // treated as a single implicit catheter. For patients saved before this
  // feature existed, synthesizes a single-entry array from the patient's own
  // legacy top-level fields — read-only for now (Stage 1), nothing writes
  // p.catheters back yet. This keeps today's behavior byte-for-byte identical
  // while giving later stages one consistent shape to build on.
  function getCatheters(p){
    if(p.catheters && Array.isArray(p.catheters) && p.catheters.length) return p.catheters;
    return [{
      id: 'c1', label: '', status: 'active', activated: p.activated !== false, createdAt: p.createdAt || Date.now(),
      day0:p.day0, day1:p.day1, day2:p.day2, day3:p.day3, day4:p.day4, day5:p.day5,
      boluses: p.boluses || [],
      drug: p.drug, frequency: p.frequency, freqType: p.freqType,
      startedAt: p.startedAt, startedAtStamp: p.startedAtStamp
    }];
  }
  function renderPainScale(id, selected){
    let opts = '<option value="">—</option>';
    for(let i=0;i<=10;i++){
      opts += `<option value="${i}" ${String(selected)===String(i)?'selected':''}>${i}</option>`;
    }
    return `<select class="pain-select" id="${id}">${opts}</select>`;
  }
  function renderMotorBlockSelect(id, selected){
    const val = selected || 'NO'; // defaults to NO until changed
    return `
      <select class="yn-select" id="${id}">
        <option value="NO" ${val==='NO'?'selected':''}>NO</option>
        <option value="YES" ${val==='YES'?'selected':''}>YES</option>
      </select>`;
  }
  function renderDermCoverSelect(id, selected){
    const val = selected || ''; // blank until the user picks one
    return `
      <select class="yn-select" id="${id}">
        <option value="" ${!val?'selected':''}>— Select —</option>
        <option value="Adequate" ${val==='Adequate'?'selected':''}>Adequate</option>
        <option value="Patchy" ${val==='Patchy'?'selected':''}>Patchy</option>
        <option value="No levels" ${val==='No levels'?'selected':''}>No levels</option>
      </select>`;
  }
  function renderCatheterSiteSelect(id, selected){
    const val = selected || 'Clean'; // defaults to Clean until changed
    return `
      <select class="yn-select" id="${id}">
        <option value="Clean" ${val==='Clean'?'selected':''}>Clean</option>
        <option value="Dressing changed" ${val==='Dressing changed'?'selected':''}>Dressing changed</option>
      </select>`;
  }
  // ---------- Catheters: card + shell rendering (Stage 2) ----------
  // Returns catheters that should still appear in active Rounds/Bolus work —
  // a removed catheter (soft-deleted, see removeCatheterFlow) keeps its full
  // history in p.catheters but drops out of this list.
  function activeCatheters(p){ return getCatheters(p).filter(c=> c.status !== 'removed'); }
  // A "dose unit" is one independent thing that can carry its own dosing
  // schedule / bolus history: the patient itself for every mode except NBC,
  // or each active (non-removed) catheter for NBC. This is the single place
  // Bolus, Bird's Eye, and Excel export enumerate what needs its own
  // interval/last-bolus/next-due/log — so a 2-catheter NBC patient is never
  // silently collapsed down to "catheter 1 represents the patient".
  function getDoseUnits(p){ return p.mode === 'NBC' ? activeCatheters(p) : [p]; }
  // Materializes p.catheters (via getCatheters' legacy-synthesis) onto the
  // patient object itself, so add/remove/save operations have a real array
  // to mutate. Safe to call repeatedly — no-ops once p.catheters exists.
  function ensureCatheters(p){
    if(!p.catheters || !Array.isArray(p.catheters) || !p.catheters.length){
      p.catheters = getCatheters(p);
    }
    return p.catheters;
  }
  function dosingScheduleSelect(id, freqType){
    return `<select id="${id}">
      <option value="" ${!freqType?'selected':''}>— Select —</option>
      <option value="Continuous" ${freqType==='Continuous'?'selected':''}>Continuous</option>
      <option value="PIB Pump" ${freqType==='PIB Pump'?'selected':''}>PIB Pump</option>
      <option value="Q6H" ${freqType==='Q6H'?'selected':''}>Q6H</option>
      <option value="Q8H" ${freqType==='Q8H'?'selected':''}>Q8H</option>
      <option value="Q12H" ${freqType==='Q12H'?'selected':''}>Q12H</option>
      <option value="Other" ${freqType==='Other'?'selected':''}>Other</option>
    </select>`;
  }
  // Dose + assessment fields for ONE catheter (or the whole patient, for
  // single-catheter modes). `suf` is appended to every field id so multiple
  // copies of this block — one per catheter — can coexist in the same DOM
  // without id collisions; suf is '' for the single-catheter (non-NBC) case,
  // which reproduces the original field ids exactly.
  function renderDoseAndAssessmentFields(suf, eff, dObj, activeDay, holder){
    const doseHint = eff.own ? `Recorded on Day ${activeDay}` : (eff.fromDay!=null ? `Carried from Day ${eff.fromDay} — edit and save to change it for Day ${activeDay}` : '');
    const isAct = (holder && holder.activated !== false);
    return `
      <div class="full-row" style="display:flex;align-items:center;justify-content:space-between;background:var(--surface-soft);border-radius:8px;padding:7px 12px;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:11.5px;font-weight:700;color:var(--ink-soft);">Status:</span>
          <select id="dr-activated${suf}" style="width:auto;padding:3px 8px;font-size:12px;font-weight:600;border-radius:6px;">
            <option value="active" ${isAct ? 'selected' : ''}>Active (started / infusing)</option>
            <option value="inactive" ${!isAct ? 'selected' : ''}>Not yet activated (placed / on hold)</option>
          </select>
        </div>
        <span class="inactive-badge" id="dr-badge-inactive${suf}" style="${isAct ? 'display:none;' : ''}">On hold</span>
      </div>
      <div class="full-row inactive-notice" id="dr-inactive-notice${suf}" style="${isAct ? 'display:none;' : ''}">
        <span class="inactive-notice-icon">⏸</span>
        <div class="inactive-notice-body">
          <b>Catheter placed · Not yet activated</b>
          <span>Pain-score requirement is waived while on hold. Inspection, motor block & anticoagulation remain trackable.</span>
        </div>
        <button type="button" class="btn activate-now-btn" data-act-suf="${suf}">Activate now</button>
      </div>
      <div class="full-row" style="background:var(--surface-soft);border-radius:8px;padding:10px 12px;">
        <div class="row2">
          <div><label>Drug</label><input type="text" id="dr-drug${suf}" value="${escapeHtml(eff.drug)}"></div>
          <div><label>Volume (ml)</label><input type="text" id="dr-freq${suf}" value="${escapeHtml(eff.frequency)}"></div>
        </div>
        <div class="row2">
          <div><label>Dosing schedule</label>${dosingScheduleSelect('dr-freqtype'+suf, eff.freqType)}</div>
          <div><label>${activeDay===0?'Started at':'Started / Changed at'}</label><input type="time" id="dr-startedat${suf}" value="${escapeHtml(eff.startedAt||'')}"></div>
        </div>
        <div class="field-hint" id="dr-bolus-hint${suf}" style="display:none;"></div>
        ${doseHint?`<div class="field-hint">${escapeHtml(doseHint)}</div>`:''}
      </div>
      <div class="mini-row">
        <div><label>Pain at rest ${isAct ? '*' : '<span style="font-weight:400;color:var(--ink-faint);">(optional)</span>'}</label>${renderPainScale('dr-painrest-scale'+suf, dObj.painRest)}</div>
        <div><label>Pain on movement ${isAct ? '*' : '<span style="font-weight:400;color:var(--ink-faint);">(optional)</span>'}</label>${renderPainScale('dr-painmove-scale'+suf, dObj.painMove)}</div>
        <div><label>Derm. cover</label>${renderDermCoverSelect('dr-dermcover-select'+suf, dObj.dermCover)}</div>
        <div><label>Motor block</label>${renderMotorBlockSelect('dr-motorblock-select'+suf, dObj.motorBlock)}</div>
      </div>
      <div><label>Catheter site</label>${renderCatheterSiteSelect('dr-cathsite'+suf, dObj.catheterSite)}</div>
      <div class="full-row"><label>Remarks</label><textarea id="dr-dayremarks${suf}" rows="3" placeholder="Notes for this day's review">${escapeHtml(dObj.remarks)}</textarea></div>
    `;
  }
  // One stacked card for one NBC catheter — its own dose/assessment fields
  // for the currently-selected day, and its own SAVE button (saves the whole
  // sheet, same as the single-card case, but writes the day record onto this
  // specific catheter). `totalCount` controls whether a Remove action shows —
  // never let it go below one catheter.
  function renderCatheterCard(p, cath, idx, activeDay, totalCount){
    const suf = '-'+cath.id;
    const dObj = getDayRaw(cath, activeDay);
    const eff = effectiveDoseRaw(cath, activeDay);
    const label = (cath.label && cath.label.trim()) ? cath.label.trim() : ('Catheter '+(idx+1));
    return `
      <div class="cath-card" data-cath-id="${cath.id}">
        <div class="cath-card-head">
          <span class="cath-card-title">${escapeHtml(label.toUpperCase())}</span>
          ${totalCount>1 ? `<button type="button" class="cath-remove-btn" data-cath-id="${cath.id}" data-cath-label="${escapeHtml(label)}">Remove</button>` : ''}
        </div>
        <div class="day-review-grid">
          ${renderDoseAndAssessmentFields(suf, eff, dObj, activeDay, cath)}
          <div class="full-row">
            <button type="button" class="save-day-btn cath-save-btn" data-cath-id="${cath.id}" data-cath-label="${escapeHtml(label)}">
              <span class="save-label">SAVE</span>
              <span class="save-day">${escapeHtml(label)} · Day ${activeDay}</span>
            </button>
          </div>
        </div>
        ${dObj.stamp?`<div style="font-size:12px;color:var(--safe);margin-top:6px;">✓ Saved ${fmtShortDate(dObj.stamp)}</div>`:''}
      </div>
    `;
  }
  function renderDailyRoundsBlock(p, activeDay){
    const isNBC = (p.mode === 'NBC');
    const catheters = isNBC ? activeCatheters(p) : null;
    // A day's ✓ on the shared tab strip means "fully reviewed" — for NBC that
    // requires EVERY current catheter to have saved that day, not just one,
    // so a half-finished round doesn't look complete and get skipped.
    const dayHasStamp = (d) => isNBC
      ? (catheters.length>0 && catheters.every(c=>!!getDayRaw(c,d).stamp))
      : !!getDayRaw(p,d).stamp;
    const tabs = [0,1,2,3,4,5].map(d=>
      `<button type="button" class="day-tab ${d===activeDay?'active':''}" data-day="${d}">Day ${d}${dayHasStamp(d)?' ✓':''}</button>`
    ).join('');

    let mainBody, singleStamp = null;
    if(isNBC){
      const cards = catheters.map((c,i)=>renderCatheterCard(p,c,i,activeDay,catheters.length)).join('');
      const addBtn = catheters.length < 2 ? `<button type="button" class="btn secondary" id="addCatheterBtn">+ Add another catheter</button>` : '';
      mainBody = `<div class="cath-stack">${cards}</div>${addBtn}`;
    } else {
      const dObj = getDay(p, activeDay);
      const eff = effectiveDose(p, activeDay);
      singleStamp = dObj.stamp;
      mainBody = `<div class="day-review-grid">${renderDoseAndAssessmentFields('', eff, dObj, activeDay, p)}</div>`;
    }

    return `
      ${(isNBC && p.location) ? `<div style="font-size:13px;font-weight:800;color:var(--ink);margin-bottom:10px;">${escapeHtml(p.location)}</div>` : ''}
      <div class="day-tabs">${tabs}</div>
      <div class="day-review-grid">
        <div class="full-row" style="background:var(--alert-bg);border:1.5px solid var(--alert);border-radius:8px;padding:10px 12px;">
          <div style="font-size:11px;font-weight:700;color:var(--alert);margin-bottom:6px;">Anticoag ${isNBC ? '<span style="font-weight:400;color:var(--ink-faint);">(applies to this patient — saved with either catheter below)</span>' : ''}</div>
          <div class="row2">
            <div><label>Status</label><select id="dr-anticoagstatus">
              <option value="NO" ${(p.anticoagStatus||'NO')==='NO'?'selected':''}>NO</option>
              <option value="YES" ${p.anticoagStatus==='YES'?'selected':''}>YES</option>
            </select></div>
            <div><label>Notes</label><input type="text" id="dr-anticoagnotes" value="${escapeHtml(p.anticoag||'')}" placeholder="e.g. Cleared 02/09 06:00"></div>
          </div>
        </div>
      </div>
      ${mainBody}
      ${isNBC ? '' : `
      <div class="day-review-grid" style="margin-top:14px;">
        <div class="full-row review-footer-row">
          <button type="button" class="save-day-btn" id="saveDayBtn">
            <span class="save-label">SAVE</span>
            <span class="save-day">Day ${activeDay}</span>
          </button>
        </div>
      </div>`}
      ${(!isNBC && singleStamp)?`<div style="font-size:12px;color:var(--safe);margin-top:6px;">✓ Saved ${fmtShortDate(singleStamp)}</div>`:''}
    `;
  }
  // Wires the live "next bolus due ~" preview under Dosing schedule + Started
  // at — once per catheter for NBC, once for the single-catheter case. Safe
  // to call unconditionally: wireBolusHint no-ops if the ids it's looking for
  // aren't in the DOM (e.g. any day other than Day 0, where Started-at isn't shown).
  function wireAllBolusHints(p){
    if(p.mode === 'NBC'){
      activeCatheters(p).forEach(c=> wireBolusHint('dr-freqtype-'+c.id, 'dr-startedat-'+c.id, 'dr-bolus-hint-'+c.id));
    } else {
      wireBolusHint('dr-freqtype','dr-startedat','dr-bolus-hint');
    }
  }
  function fmtShortDate(dateStr){
    if(!dateStr) return '';
    const d = new Date(dateStr+'T00:00:00');
    return d.toLocaleDateString(undefined,{day:'2-digit',month:'short'});
  }
  // Same short format as fmtShortDate, but for a raw timestamp (e.g.
  // p.dischargedAt) rather than a YYYY-MM-DD date-input string.
  function fmtShortDateFromTs(ts){
    if(!ts) return '';
    return new Date(ts).toLocaleDateString(undefined,{day:'2-digit',month:'short'});
  }

  // ---------- Bolus timing ----------
  // Only fixed-interval schedules can have a "next dose due" calculated.
  // Continuous / PIB Pump / Other are deliberately left out — they're not
  // on interval dosing, so "overdue" wouldn't mean anything for them.
  const BOLUS_INTERVAL_HOURS = {'Q6H':6, 'Q8H':8, 'Q12H':12};
  function isBolusEligible(holder){
    if(!holder || holder.activated === false) return false;
    return !!BOLUS_INTERVAL_HOURS[holder.freqType];
  }
  // Combines a day's own date (its stamp, e.g. "2026-09-08") with the "Started at"
  // time typed in that day's box (e.g. "06:00") into a real timestamp. This is the
  // clinical start time — when the epidural/PCA/etc. actually began — as opposed to
  // createdAt, which is only ever when the record was typed into Dolora.
  function startedAtTimestamp(stamp, startedAt){
    if(!stamp || !startedAt) return null;
    const cleanTime = startedAt.trim();
    const timePart = cleanTime.length === 5 ? (cleanTime + ':00') : cleanTime;
    const t = new Date(stamp+'T'+timePart).getTime();
    return isNaN(t) ? null : t;
  }
  function lastBolusAtRaw(holder){
    if(holder.boluses && holder.boluses.length) return holder.boluses[holder.boluses.length-1].ts;
    // Never logged yet — prefer the clinically-entered Started-at time. Only fall
    // back to createdAt (record-entry time) if Started-at was never set at all.
    return startedAtTimestamp(holder.startedAtStamp, holder.startedAt) || holder.createdAt || null;
  }
  function lastBolusAt(p){ return lastBolusAtRaw(p); }
  function nextBolusDueAtRaw(holder){
    const hrs = BOLUS_INTERVAL_HOURS[holder.freqType];
    if(!hrs) return null;
    const base = lastBolusAtRaw(holder) || Date.now();
    return base + hrs*3600*1000;
  }
  function nextBolusDueAt(p){ return nextBolusDueAtRaw(p); }
  function bolusStatusRaw(holder){ // 'overdue' | 'soon' | 'ok' | null (not eligible)
    const due = nextBolusDueAtRaw(holder);
    if(due==null) return null;
    const now = Date.now();
    if(now >= due) return 'overdue';
    if(due - now <= 30*60*1000) return 'soon'; // within 30 min
    return 'ok';
  }
  function bolusStatus(p){ return bolusStatusRaw(p); }
  function fmtDueLabelRaw(holder){
    const due = nextBolusDueAtRaw(holder);
    if(due==null) return '—';
    const now = Date.now();
    const diff = Math.abs(now - due);
    const diffMin = Math.round(diff / 60000);
    let countdown = '';
    if(diffMin < 60){
      countdown = diffMin + 'm';
    } else {
      const h = Math.floor(diffMin / 60);
      const m = diffMin % 60;
      countdown = m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    const label = 'Next due ' + fmtTimeOfDay(due);
    return now >= due ? `${label} — overdue by ${countdown}` : `${label} (in ${countdown})`;
  }
  function fmtDueLabel(p){ return fmtDueLabelRaw(p); }
  function fmtTimeOfDay(ts){
    if(!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit', timeZone: HOSPITAL_TZ});
    } catch(e) {
      return new Date(ts).toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit'});
    }
  }
  // Live grey-hint preview shown right under Dosing schedule + Started at while
  // typing, before anything is saved. Only meaningful for Q6H/Q8H/Q12H — other
  // schedules just record Started at without a due-time calculation.
  function wireBolusHint(freqSelId, startedAtId, hintId){
    const freqEl = $(freqSelId), startedEl = $(startedAtId), hintEl = $(hintId);
    if(!freqEl || !startedEl || !hintEl) return;
    const update = ()=>{
      const hrs = BOLUS_INTERVAL_HOURS[freqEl.value];
      const startedTs = startedAtTimestamp(todayStr(), startedEl.value);
      if(!hrs || !startedTs){
        hintEl.style.display = 'none';
        hintEl.textContent = '';
        return;
      }
      const due = startedTs + hrs*3600*1000;
      hintEl.style.display = '';
      hintEl.textContent = 'Next bolus due ~'+fmtTimeOfDay(due)+' — estimate, replaced once a bolus is logged';
    };
    freqEl.addEventListener('change', update);
    startedEl.addEventListener('input', update);
    update();
  }
  function fmtLastGivenRaw(holder){
    if(!(holder.boluses && holder.boluses.length)) return 'Never logged';
    const last = holder.boluses[holder.boluses.length-1];
    const whenPart = 'Last given '+fmtTimeOfDay(last.ts);
    return last.by ? whenPart+' by '+last.by : whenPart; // older entries logged before attribution existed just show the time
  }
  function fmtLastGiven(p){ return fmtLastGivenRaw(p); }
  const modeLabels = {Epidural:'Epidural', NBC:'NBC', PCA:'PCA', Dosifuser:'Dosifuser'};
  function updateModeBadge(selectId, badgeId){
    const sel = $(selectId), badge = $(badgeId);
    if(!sel || !badge) return;
    const v = sel.value;
    badge.className = 'mode-badge mode-'+v;
    badge.textContent = modeLabels[v] || v;
  }
  function isToday(ts){ if(!ts) return false; return new Date(ts).toLocaleDateString('en-CA', {timeZone: HOSPITAL_TZ})===todayStr(); }
  function isAttendedToday(p){ return !!(p.attendance && p.attendance[todayStr()]); }

  function campusFilter(list){
    if(currentCampus==='all') return list;
    return list.filter(p=>(p.campus||'Main Campus')===currentCampus);
  }
  function activePatients(){
    return campusFilter(Object.values(patients).filter(p=>p && p.status!=='discharged' && p.status!=='deleted'));
  }
  function allPatientsList(){
    return campusFilter(Object.values(patients).filter(p=>p && p.status!=='deleted'));
  }
  function wardsUsed(){ return [...new Set(activePatients().map(p=>p.ward).filter(Boolean))].sort(); }

  function setCampus(c){
    currentCampus = c;
    document.querySelectorAll('.campus-pill').forEach(el=>{
      el.classList.toggle('active', el.getAttribute('data-campus')===c);
    });
    try{ localStorage.setItem('aps-current-campus', c); }catch(e){}
    refreshWardOptions();
    renderAll();
  }
  document.querySelectorAll('.campus-pill').forEach(el=>{
    el.addEventListener('click', ()=>setCampus(el.getAttribute('data-campus')));
  });

  function naturalSort(a,b){
    return (a||'').toString().localeCompare((b||'').toString(), undefined, {numeric:true, sensitivity:'base'});
  }

  function groupByWard(list){
    const groups = {};
    list.forEach(p=>{
      const w = p.ward && p.ward.trim() ? p.ward.trim() : 'Unassigned';
      (groups[w] = groups[w] || []).push(p);
    });
    const wardNames = Object.keys(groups).sort(naturalSort);
    wardNames.forEach(w=> groups[w].sort((a,b)=> naturalSort(a.bed,b.bed) || naturalSort(a.name,b.name)));
    return {wardNames, groups};
  }

  // ---------- datalist ----------
  function refreshWardOptions(){
    $('wardOptions').innerHTML = wardsUsed().map(w=>`<option value="${escapeHtml(w)}">`).join('');
  }

  // ---------- Dashboard ----------
  function renderDashboard(){
    const active = activePatients();
    $('statActive').textContent = active.length;
    const wardCounts = {};
    active.forEach(p=>{ const w=p.ward||'Unassigned'; wardCounts[w]=(wardCounts[w]||0)+1; });
    $('statWards').textContent = Object.keys(wardCounts).length;
    $('statToday').textContent = active.filter(p=>isToday(p.createdAt)).length;

    $('wardChips').innerHTML = Object.keys(wardCounts).sort(naturalSort).map(w=>
      `<div class="ward-chip">${escapeHtml(w)} <b>${wardCounts[w]}</b></div>`
    ).join('') || '<div class="empty" style="padding:10px;"><p>No active patients yet.</p></div>';

    const recent = active.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,5);
    $('recentBoard').innerHTML = recent.length ? recent.map(p=>`
      <div class="row">
        <div class="avatar mode-${p.mode||'Epidural'}">${escapeHtml(initials(p.name))}</div>
        <div class="row-main">
          <div class="row-top"><span class="p-name">${escapeHtml(p.name||'—')}</span><span class="p-bed">${escapeHtml(p.ward||'')} · Bed ${escapeHtml(p.bed||'—')}</span></div>
          <div class="p-sub">${escapeHtml(p.dx||'—')} · ${escapeHtml(p.drug||'—')}</div>
        </div>
      </div>`).join('') : '<div class="empty"><div class="big">—</div><p>Nothing added yet. Use "Add" to log a patient from the yellow sheet.</p></div>';
  }

  // ---------- Insights ----------
  const MODE_ORDER = ['Epidural','NBC','PCA','Dosifuser'];
  const MODE_VARCOLOR = {Epidural:'var(--mode-epidural)', NBC:'var(--mode-nbc)', PCA:'var(--mode-pca)', Dosifuser:'var(--mode-dosifuser)'};

  function insightsRange(){
    const sel = $('ins-range').value;
    const now = new Date();
    let from=null, to=null, label='';
    if(sel==='thismonth'){
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now.getFullYear(), now.getMonth()+1, 0);
      label = from.toLocaleDateString(undefined,{month:'long', year:'numeric'});
    } else if(sel==='lastmonth'){
      from = new Date(now.getFullYear(), now.getMonth()-1, 1);
      to = new Date(now.getFullYear(), now.getMonth(), 0);
      label = from.toLocaleDateString(undefined,{month:'long', year:'numeric'});
    } else if(sel==='last3'){
      from = new Date(now.getFullYear(), now.getMonth()-2, 1);
      to = new Date(now.getFullYear(), now.getMonth()+1, 0);
      label = from.toLocaleDateString(undefined,{month:'short', year:'numeric'})+' – '+to.toLocaleDateString(undefined,{month:'short', year:'numeric'});
    } else { // custom
      if(!$('ins-from').value){
        const d1 = new Date(now.getFullYear(), now.getMonth(), 1);
        $('ins-from').value = d1.toISOString().slice(0,10);
      }
      if(!$('ins-to').value){
        $('ins-to').value = todayStr();
      }
      const fromVal = $('ins-from').value, toVal = $('ins-to').value;
      from = fromVal ? new Date(fromVal+'T00:00:00') : null;
      to = toVal ? new Date(toVal+'T00:00:00') : null;
      label = (fromVal && toVal) ? (fmtDDMMYY(fromVal)+' – '+fmtDDMMYY(toVal)) : 'Pick both a start and end date';
    }
    if(to) to.setHours(23,59,59,999);
    return {from, to, label};
  }

  function insightsPatients(from, to, scope='aps'){
    const all = Object.values(patients).filter(p=>{
      if(!p || p.status==='deleted') return false;
      if(scope==='aps' && p.doneByRole==='surgeon') return false;
      if(scope==='surgeon' && p.doneByRole!=='surgeon') return false;
      if(!p.apsDate) return false;
      const d = new Date(p.apsDate+'T12:00:00');
      if(isNaN(d)) return false;
      if(from && d < from) return false;
      if(to && d > to) return false;
      return true;
    });
    return campusFilter(all);
  }

  let latestAuditSummaryText = '';

  function renderInsights(){
    const {from, to, label} = insightsRange();
    $('ins-rangelabel').textContent = label;
    const scope = ($('ins-scope') && $('ins-scope').value) || 'aps';
    const list = insightsPatients(from, to, scope);
    const body = $('insightsBody');

    if(!list.length){
      const scopeLabel = scope==='aps' ? ' (APS managed)' : (scope==='surgeon' ? ' (Surgical placements)' : '');
      body.innerHTML = '<div class="card"><div class="ins-empty">No patients with an APS date in this range' + scopeLabel + '.</div></div>';
      latestAuditSummaryText = 'No patient data in selected audit range (' + label + ').';
      return;
    }

    const inRangePatients = campusFilter(Object.values(patients).filter(p=>{
      if(!p || p.status==='deleted' || !p.apsDate) return false;
      const d = new Date(p.apsDate+'T12:00:00');
      if(isNaN(d)) return false;
      if(from && d < from) return false;
      if(to && d > to) return false;
      return true;
    }));
    const apsCount = inRangePatients.filter(p=>p.doneByRole!=='surgeon').length;
    const surgCount = inRangePatients.filter(p=>p.doneByRole==='surgeon').length;

    // 1. Volume by modality
    const modeCounts = {Epidural:0, NBC:0, PCA:0, Dosifuser:0};
    list.forEach(p=>{ const m=p.mode||'Epidural'; if(modeCounts[m]===undefined) modeCounts[m]=0; modeCounts[m]++; });
    const maxModeCount = Math.max(1, ...Object.values(modeCounts));

    // 5. Anticoag flag rate
    const anticoagYes = list.filter(p=>p.anticoagStatus==='YES').length;
    const anticoagPct = Math.round((anticoagYes/list.length)*100);

    // 2. Pain outcomes, Day 0-3, per modality (avg of rest+move)
    // For NBC, correctly read each catheter's day reviews via getDayRaw
    const painDays = ['day0','day1','day2','day3'];
    const painByMode = {}; // mode -> [ {sum,count} per day ]
    MODE_ORDER.forEach(m=>{ painByMode[m] = painDays.map(()=>({sum:0,count:0})); });
    list.forEach(p=>{
      const m = MODE_ORDER.includes(p.mode) ? p.mode : 'Epidural';
      const holders = (p.mode==='NBC' && p.catheters && p.catheters.length) ? activeCatheters(p) : [p];
      holders.forEach(holder=>{
        painDays.forEach((dk, i)=>{
          const d = getDayRaw(holder, i);
          if(!d) return;
          const r = parseFloat(d.painRest), mv = parseFloat(d.painMove);
          const vals = [r,mv].filter(v=>!isNaN(v));
          if(!vals.length) return;
          const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
          painByMode[m][i].sum += avg;
          painByMode[m][i].count++;
        });
      });
    });
    const activeModesForPain = MODE_ORDER.filter(m=>painByMode[m].some(d=>d.count>0));

    // 6. Avg days on APS by modality (discharged patients with a recorded dischargedAt only)
    const durByMode = {}; MODE_ORDER.forEach(m=>durByMode[m]={sum:0,count:0});
    list.forEach(p=>{
      if(p.status!=='discharged' || !p.dischargedAt || !p.apsDate) return;
      const start = new Date(p.apsDate+'T00:00:00').getTime();
      const days = (p.dischargedAt - start)/86400000;
      if(days < 0) return;
      const m = MODE_ORDER.includes(p.mode) ? p.mode : 'Epidural';
      durByMode[m].sum += days; durByMode[m].count++;
    });
    const durSampleTotal = MODE_ORDER.reduce((a,m)=>a+durByMode[m].count,0);

    // 9. Top surgeries (normalized: trim + lowercase, displayed with first-seen casing)
    const surgeryCounts = {}; const surgeryDisplay = {};
    list.forEach(p=>{
      const raw = (p.surgery||'').trim();
      if(!raw) return;
      const key = raw.toLowerCase();
      surgeryCounts[key] = (surgeryCounts[key]||0)+1;
      if(!surgeryDisplay[key]) surgeryDisplay[key] = raw;
    });
    const sortedSurgeries = Object.keys(surgeryCounts).sort((a,b)=>surgeryCounts[b]-surgeryCounts[a]);
    const topSurgeries = sortedSurgeries.slice(0,10);
    const otherSurgeryCount = sortedSurgeries.slice(10).reduce((a,k)=>a+surgeryCounts[k],0);

    // ---- render ----
    let html = '';

    if(scope === 'aps' && surgCount > 0){
      html += `<div style="background:var(--surface-soft);border:1px solid var(--line);border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:11.5px;color:var(--ink-soft);display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span>Auditing <b>${list.length} APS-managed</b> procedure${list.length===1?'':'s'} · <b>${surgCount}</b> surgical placement${surgCount===1?'':'s'} registered separately (excluded from daily rounds & KPIs)</span>
      </div>`;
    } else if(scope === 'surgeon'){
      html += `<div style="background:#FEF3C7;border:1px solid #FDE68A;border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:11.5px;color:#92400E;">
        <b>Surgical Placements Registry:</b> Viewing ${list.length} procedure${list.length===1?'':'s'} placed by surgeons. These are tracked for catheter safety and are not followed on daily APS rounds.
      </div>`;
    } else if(scope === 'all'){
      html += `<div style="background:var(--surface-soft);border:1px solid var(--line);border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:11.5px;color:var(--ink-soft);">
        <b>Total Hospital Devices:</b> Showing combined count of <b>${apsCount}</b> APS-managed and <b>${surgCount}</b> surgical placement${surgCount===1?'':'s'}.
      </div>`;
    }

    html += `<div class="card">
      <div class="stat-grid" style="grid-template-columns:1fr 1fr;">
        <div class="stat-card"><div class="num">${list.length}</div><div class="lbl">${scope==='surgeon'?'Surgical devices':(scope==='all'?'Total hospital devices':'APS procedures')}</div></div>
        <div class="stat-card"><div class="num">${anticoagPct}%</div><div class="lbl">Anticoag flagged (${anticoagYes}/${list.length})</div></div>
      </div>
    </div>`;

    html += `<div class="ins-section-label">By modality</div><div class="card">`;
    MODE_ORDER.forEach(m=>{
      const c = modeCounts[m]||0;
      const pct = Math.round((c/maxModeCount)*100);
      html += `<div class="ins-bar-row">
        <div class="ins-bar-label">${escapeHtml(modeLabels[m]||m)}</div>
        <div class="ins-bar-track"><div class="ins-bar-fill" style="width:${pct}%;background:${MODE_VARCOLOR[m]};"></div></div>
        <div class="ins-bar-count">${c}</div>
      </div>`;
    });
    html += `</div>`;

    html += `<div class="ins-section-label">Pain score, day 0–3 (avg of rest + movement)</div><div class="card">`;
    if(!activeModesForPain.length){
      html += `<div class="ins-empty">No daily reviews logged yet for this range.</div>`;
    } else {
      const W=300, H=110, padL=14, padR=14, padT=12, padB=22, plotW=W-padL-padR, plotH=H-padT-padB;
      let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;">
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT+plotH}" stroke="var(--line)"/>
        <line x1="${padL}" y1="${padT+plotH}" x2="${padL+plotW}" y2="${padT+plotH}" stroke="var(--line)"/>`;
      const xStep = plotW/(painDays.length-1);
      activeModesForPain.forEach(m=>{
        const pts = painByMode[m].map((d,i)=>{
          const avg = d.count ? d.sum/d.count : null;
          return avg===null ? null : {x: padL+i*xStep, y: padT + plotH - (Math.min(avg,10)/10)*plotH, val: avg, day: i};
        }).filter(Boolean);
        if(pts.length<1) return;
        if(pts.length > 1){
          const pointsAttr = pts.map(pt=>`${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
          svg += `<polyline points="${pointsAttr}" fill="none" stroke="${MODE_VARCOLOR[m]}" stroke-width="2"/>`;
        }
        pts.forEach(pt=>{
          svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3.5" fill="${MODE_VARCOLOR[m]}" stroke="#fff" stroke-width="1.5">
            <title>${escapeHtml(modeLabels[m]||m)} D${pt.day}: ${pt.val.toFixed(1)}/10</title>
          </circle>`;
        });
      });
      painDays.forEach((dk,i)=>{
        svg += `<text x="${padL+i*xStep}" y="${H-6}" font-size="9" fill="var(--ink-soft)" text-anchor="middle">D${i}</text>`;
      });
      svg += `</svg>`;
      html += svg;
      html += `<div class="ins-legend">${activeModesForPain.map(m=>
        `<div class="ins-legend-item"><span class="ins-legend-dot" style="background:${MODE_VARCOLOR[m]};"></span>${escapeHtml(modeLabels[m]||m)}</div>`
      ).join('')}</div>`;
      html += `<div class="ins-note">Scale is 0–10. Points show average of pain at rest + movement. Days with no logged review for a modality are skipped.</div>`;
    }
    html += `</div>`;

    html += `<div class="ins-section-label">Avg days on APS, by modality</div><div class="card">`;
    if(!durSampleTotal){
      html += `<div class="ins-empty">No discharge duration recorded yet — this fills in as patients are discharged from now on.</div>`;
    } else {
      html += `<div class="ins-tile-grid">`;
      MODE_ORDER.forEach(m=>{
        const d = durByMode[m];
        const avg = d.count ? (d.sum/d.count).toFixed(1) : '—';
        html += `<div class="ins-tile"><div class="num">${avg}</div><div class="lbl">${escapeHtml(modeLabels[m]||m)}</div></div>`;
      });
      html += `</div><div class="ins-note">Based on ${durSampleTotal} discharged patient${durSampleTotal===1?'':'s'} with a recorded discharge date. Duration for patients discharged before this feature was added can't be calculated.</div>`;
    }
    html += `</div>`;

    html += `<div class="ins-section-label">Top surgeries</div><div class="card" style="padding:6px 17px;">`;
    if(!topSurgeries.length){
      html += `<div class="ins-empty">No surgery entries logged in this range.</div>`;
    } else {
      topSurgeries.forEach(k=>{
        html += `<div class="ins-surgery-row"><span>${escapeHtml(surgeryDisplay[k])}</span><span class="ins-surgery-count">${surgeryCounts[k]}</span></div>`;
      });
      if(otherSurgeryCount>0){
        html += `<div class="ins-surgery-row"><span>Other</span><span class="ins-surgery-count">${otherSurgeryCount}</span></div>`;
      }
      html += `<div class="ins-note">Grouped by exact text as entered (case-insensitive). Entries typed differently — e.g. "TKR" vs "Total knee replacement" — are counted separately.</div>`;
    }
    html += `</div>`;

    body.innerHTML = html;

    // Build plain-text summary for clipboard copying
    const scopeName = scope==='surgeon' ? 'Surgical Placements Only' : (scope==='all' ? 'Total Hospital Devices' : 'APS Managed');
    latestAuditSummaryText = [
      `DOLORA APS CLINICAL AUDIT REPORT`,
      `Range: ${label}`,
      `Scope: ${scopeName}`,
      `Campus: ${currentCampus==='all' ? 'All Campuses' : currentCampus}`,
      `Total Procedures: ${list.length}`,
      `Anticoagulation Flagged: ${anticoagPct}% (${anticoagYes}/${list.length})`,
      ``,
      `Modality Breakdown:`,
      ...MODE_ORDER.map(m=>`- ${modeLabels[m]||m}: ${modeCounts[m]||0}`),
      ``,
      `Top Surgeries:`,
      ...topSurgeries.slice(0,5).map(k=>`- ${surgeryDisplay[k]}: ${surgeryCounts[k]}`)
    ].join('\n');
  }

  $('ins-range').addEventListener('change', ()=>{
    $('ins-customrange').style.display = $('ins-range').value==='custom' ? 'flex' : 'none';
    renderInsights();
  });
  $('ins-from').addEventListener('change', renderInsights);
  $('ins-to').addEventListener('change', renderInsights);
  if($('ins-scope')) $('ins-scope').addEventListener('change', renderInsights);
  if($('copyAuditBtn')){
    $('copyAuditBtn').addEventListener('click', async ()=>{
      if(!latestAuditSummaryText){ toast('No audit data to copy'); return; }
      try{
        await navigator.clipboard.writeText(latestAuditSummaryText);
        toast('Audit summary copied to clipboard');
      }catch(e){
        toast('Could not copy to clipboard');
      }
    });
  }

  // ---------- Reusable confirm popup (discharge, delete, conflict-reload) ----------
  // A promise-based modal instead of window.confirm(), which is unreliable inside
  // installed PWAs / mobile webviews — this is why "Delete patient" wasn't showing
  // a warning before.
  let dcResolve = null;
  function askConfirm({title, message, confirmLabel, danger}){
    return new Promise(resolve=>{
      dcResolve = resolve;
      $('dcTitle').textContent = title;
      $('dcMsg').textContent = message;
      $('dcConfirm').textContent = confirmLabel;
      $('dcConfirm').classList.toggle('dc-danger', !!danger);
      $('dcBackdrop').classList.add('open');
    });
  }
  function closeConfirmModal(result){
    $('dcBackdrop').classList.remove('open');
    if(dcResolve){ const r = dcResolve; dcResolve = null; r(result); }
  }
  $('dcCancel').addEventListener('click', ()=>closeConfirmModal(false));
  $('dcBackdrop').addEventListener('click', (e)=>{ if(e.target.id==='dcBackdrop') closeConfirmModal(false); });
  $('dcConfirm').addEventListener('click', ()=>closeConfirmModal(true));

  async function openDischargeConfirm(id){
    const p = patients[id];
    if(!p) return;
    const ok = await askConfirm({
      title: 'Mark discharged?',
      message: (p.name||'This patient')+' · Bed '+(p.bed||'—')+' will move out of active rounds. You can reactivate later from their record if needed.',
      confirmLabel: 'Discharge'
    });
    if(!ok) return;
    try{
      await savePatientField(id, (base)=>{
        base.status = 'discharged';
        base.dischargedAt = Date.now();
        logActivity(base, 'discharged');
      });
    }catch(e){
      if(e && e.doloraDeleted){ handleDeletedElsewhere(id); return; }
      toast('Could not save — check your connection and try again ('+errMsg(e)+')', 5000);
      return; // don't close the sheet or re-render as if it worked — nothing was actually saved
    }
    toast('Marked discharged');
    closeDetail(); // no-op if the sheet wasn't open (e.g. confirmed from Rounds); closes it if it was (confirmed from Details)
    renderAll();
  }

  async function deletePatientFlow(p){
    const ok = await askConfirm({
      title: 'Delete this patient?',
      message: 'This permanently erases every daily review for '+(p.name||'this patient')+' and cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    });
    if(!ok) return;
    // Deleting isn't something a field-level merge can protect (there's no
    // "merge" for erasing a record) — so instead warn if someone else saved
    // changes to this patient since we last loaded them, and let the user
    // decide whether to delete anyway or go look at what changed first.
    const conflict = await hasConflict(p.id, patientUpdatedAt[p.id]);
    if(conflict === 'deleted'){
      // Already gone — nothing left to delete. Just sync local state instead
      // of showing a confusing "delete anyway?" prompt for a record that no
      // longer exists.
      handleDeletedElsewhere(p.id);
      return;
    }
    if(conflict === 'edited'){
      const proceed = await askConfirm({
        title: 'Record updated elsewhere',
        message: 'Someone else updated this record after you last loaded it. Delete anyway, or cancel to review their changes first?',
        confirmLabel: 'Delete anyway',
        danger: true
      });
      if(!proceed) return;
    }
    try{
      await window.storage.delete('patient:'+p.id, true);
    }catch(e){
      toast('Delete failed: '+errMsg(e), 5000);
      return;
    }
    await recordDeletion(p);
    delete patients[p.id];
    delete patientUpdatedAt[p.id];
    toast('Patient deleted');
    renderAll();
    closeDetail();
  }

  // ---------- Rounds ----------
  function roundsActivePatients(){
    return Object.values(patients).filter(p=>p && p.status!=='discharged' && p.status!=='deleted' && (p.campus||'Main Campus')===roomCampus && p.doneByRole!=='surgeon');
  }
  function renderRounds(){
    const active = roundsActivePatients();
    $('roundsCount').textContent = active.length;
    const activeSurg = Object.values(patients).filter(p=>p && p.status!=='discharged' && p.status!=='deleted' && (p.campus||'Main Campus')===roomCampus && p.doneByRole==='surgeon');
    const {wardNames, groups} = groupByWard(active);
    if(!wardNames.length){
      let emptyHtml = '<div class="empty"><div class="big">—</div><p>No active patients on rounds at '+escapeHtml(roomCampus)+'.<br>Add one from the yellow sheet to get started.</p></div>';
      if(activeSurg.length){
        emptyHtml += `
        <div class="surg-registry-bar" style="margin-top:16px;padding:12px 14px;background:var(--surface-soft);border:1px solid var(--line);border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div>
            <span style="font-weight:700;font-size:12.5px;color:var(--ink);">🏥 Surgical Placements: ${activeSurg.length}</span>
            <span style="display:block;font-size:11px;color:var(--ink-soft);margin-top:2px;">Registered in catheter database · Excluded from daily APS rounds</span>
          </div>
          <button type="button" class="btn secondary view-surg-btn" style="width:auto;margin:0;padding:5px 12px;font-size:11.5px;white-space:nowrap;">View in Bird's eye</button>
        </div>`;
      }
      $('roundsBoard').innerHTML = emptyHtml;
      document.querySelectorAll('#roundsBoard .view-surg-btn').forEach(btn=>{
        btn.addEventListener('click', ()=>switchView('eagle'));
      });
      return;
    }
    let html = '';
    wardNames.forEach(w=>{
      html += `<div class="ward-header">${escapeHtml(w)} · ${groups[w].length}</div><div class="board">`;
      groups[w].forEach(p=>{
        const mode = p.mode || 'Epidural';
        const seenToday = isAttendedToday(p);
        const glimpse = todaysGlimpse(p);
        const isInactive = (p.mode === 'NBC')
          ? (activeCatheters(p).length > 0 && activeCatheters(p).every(c=>c.activated===false))
          : (p.activated === false);
        const partialInactive = (p.mode === 'NBC') && (activeCatheters(p).length > 1) && activeCatheters(p).some(c=>c.activated===false) && !isInactive;
        const defaultGlimpse = isInactive ? 'Catheter placed · Not yet activated' : 'Not reviewed yet today';
        html += `
        <div class="row clickable rmode-${mode}" data-id="${p.id}">
          <button type="button" class="attend-box ${seenToday?'checked':''}" data-attend-id="${p.id}" aria-label="${seenToday?'Marked attended today — tap to unmark':'Mark attended today'}">${seenToday?'✓':''}</button>
          <div class="row-main">
            <div class="row-top"><span class="p-name">${escapeHtml(p.name||'—')}</span></div>
            <div class="p-sub">Bed ${escapeHtml(p.bed||'—')} · ${escapeHtml(p.hospitalNo||'—')}</div>
            <div class="p-glimpse ${glimpse?'':'p-glimpse-empty'}">${glimpse ? escapeHtml(glimpse) : (glimpse===null ? defaultGlimpse : '')}</div>
          </div>
          <div class="row-right">
            <div style="display:flex;align-items:center;gap:5px;">
              <span class="mode-badge mode-${mode}">${escapeHtml(modeLabels[mode]||mode)}</span>
              ${isInactive ? '<span class="inactive-badge">Not activated</span>' : (partialInactive ? '<span class="inactive-badge">1 cath on hold</span>' : '')}
            </div>
            <span class="row-date">${p.apsDate?fmtDDMMYY(p.apsDate):'—'}</span>
            <span class="anticoag-badge anticoag-${(p.anticoagStatus||'NO').toLowerCase()}">Anticoag: ${escapeHtml(p.anticoagStatus||'NO')}</span>
            <button class="discharge-btn" data-discharge-id="${p.id}" aria-label="Discharge patient" type="button">${ICON_LOGOUT}</button>
          </div>
          <span class="chev">›</span>
        </div>`;
      });
      html += `</div>`;
    });

    if(activeSurg.length){
      html += `
      <div class="surg-registry-bar" style="margin-top:16px;padding:12px 14px;background:var(--surface-soft);border:1px solid var(--line);border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div>
          <span style="font-weight:700;font-size:12.5px;color:var(--ink);">🏥 Surgical Placements: ${activeSurg.length}</span>
          <span style="display:block;font-size:11px;color:var(--ink-soft);margin-top:2px;">Registered in catheter database · Excluded from daily APS rounds</span>
        </div>
        <button type="button" class="btn secondary view-surg-btn" style="width:auto;margin:0;padding:5px 12px;font-size:11.5px;white-space:nowrap;">View in Bird's eye</button>
      </div>`;
    }

    $('roundsBoard').innerHTML = html;
    document.querySelectorAll('#roundsBoard .row[data-id]').forEach(el=>{
      el.addEventListener('click', ()=>openDetail(el.getAttribute('data-id')));
    });
    document.querySelectorAll('#roundsBoard .discharge-btn').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        openDischargeConfirm(btn.getAttribute('data-discharge-id'));
      });
    });
    document.querySelectorAll('#roundsBoard .attend-box[data-attend-id]').forEach(btn=>{
      btn.addEventListener('click', async (e)=>{
        e.stopPropagation();
        const id = btn.getAttribute('data-attend-id');
        const p = patients[id];
        if(!p) return;
        const nowOn = !isAttendedToday(p);
        btn.disabled = true;
        try{
          await savePatientField(id, (base)=>{
            base.attendance = base.attendance || {};
            if(nowOn){ base.attendance[todayStr()] = true; }
            else{ delete base.attendance[todayStr()]; }
          });
          btn.classList.toggle('checked', nowOn);
          btn.textContent = nowOn ? '✓' : '';
          btn.setAttribute('aria-label', nowOn ? 'Marked attended today — tap to unmark' : 'Mark attended today');
        }catch(err){
          if(err && err.doloraDeleted){ toast('This patient was deleted elsewhere', 4000); renderRounds(); return; }
          toast('Could not save — check your connection and try again ('+errMsg(err)+')', 5000);
        }finally{
          btn.disabled = false;
        }
      });
    });
    document.querySelectorAll('#roundsBoard .view-surg-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>switchView('eagle'));
    });
  }

  // ---------- Detail sheet (Rounds - editable) ----------
  function openDetail(id){
    const p = patients[id];
    if(!p) return;
    let sheetOpenedAt = patientUpdatedAt[id] || null; // baseline for conflict check on save — refreshed after each successful save below

    let activeDay = 0;

    $('sheet').innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-head">
        <div><h3>${escapeHtml(p.name||'—')}</h3></div>
        <button class="close-x" id="closeSheet">✕</button>
      </div>

      <div class="card">
        ${(p.doneByRole==='surgeon') ? `
        <div style="margin-bottom:12px;padding:9px 12px;background:#FEF3C7;border:1px solid #FDE68A;border-radius:8px;font-size:12px;color:#92400E;display:flex;align-items:center;gap:8px;">
          <span style="font-weight:700;">🏥 Surgical Placement (Registry Only):</span>
          <span>Registered for hospital catheter tracking. Excluded from daily APS rounds.</span>
        </div>` : ''}
        <div class="row2">
          <div><label>Hospital No <span class="campus-badge" title="Hospital No is this record's key and can't be edited">LOCKED</span></label><input type="text" id="ed-hno" value="${escapeHtml(p.hospitalNo||'')}" readonly style="background:var(--surface-soft);color:var(--ink-soft);"></div>
          <div><label>Campus</label>
            <select id="ed-campus">
              <option ${((p.campus||'Main Campus')==='Main Campus')?'selected':''}>Main Campus</option>
              <option ${p.campus==='Ranipet'?'selected':''}>Ranipet</option>
            </select>
          </div>
        </div>
        <div class="row2">
          <div><label>Ward</label><input type="text" id="ed-ward" list="wardOptions" value="${escapeHtml(p.ward||'')}"></div>
          <div><label>Bed</label><input type="text" id="ed-bed" value="${escapeHtml(p.bed||'')}"></div>
        </div>
        <label>Name</label><input type="text" id="ed-name" value="${escapeHtml(p.name||'')}">
        <div class="row2 row2-date">
          <div><label>APS Date</label><input type="date" id="ed-apsdate" value="${escapeHtml(p.apsDate||'')}"></div>
          <div><label>Gender</label>
            <select id="ed-gender">
              <option value="" ${!p.gender?'selected':''}>—</option>
              <option ${p.gender==='Male'?'selected':''}>Male</option>
              <option ${p.gender==='Female'?'selected':''}>Female</option>
              <option ${p.gender==='Other'?'selected':''}>Other</option>
            </select>
          </div>
        </div>
        <div class="row2">
          <div><label>Age</label><input type="number" id="ed-age" value="${escapeHtml(p.age||'')}"></div>
          <div>
            <label>Done by</label>
            <select id="ed-doneby-role">
              <option value="anaesthetist" ${(p.doneByRole||'anaesthetist')==='anaesthetist'?'selected':''}>Anaesthetist</option>
              <option value="surgeon" ${p.doneByRole==='surgeon'?'selected':''}>Surgeon</option>
            </select>
          </div>
        </div>
        <div style="margin-bottom:8px;">
          <label id="ed-doneby-label">${(p.doneByRole==='surgeon') ? 'Surgeon / Surgical unit' : 'Anaesthetist name'}</label>
          <input type="text" id="ed-doneby" list="doneby-suggestions" value="${escapeHtml(p.doneBy||'')}" placeholder="${(p.doneByRole==='surgeon') ? 'e.g. Dr. Mohan / Ortho Unit' : 'e.g. Dr. Anand'}">
          <div class="field-hint" id="ed-doneby-hint" style="${p.doneByRole==='surgeon'?'display:block;':'display:none;'}color:#92400E;background:#FEF3C7;border:1px solid #FDE68A;padding:7px 10px;border-radius:6px;margin-top:4px;">
            Registered for catheter safety & institutional tracking. Excluded from daily APS rounds and audit KPIs.
          </div>
        </div>
        <label>Dx</label><input type="text" id="ed-dx" list="dx-suggestions" value="${escapeHtml(p.dx||'')}">
        <label>Surgery</label><input type="text" id="ed-surgery" list="surgery-suggestions" value="${escapeHtml(p.surgery||'')}">

        <label>APS mode</label>
        <div style="display:flex;align-items:center;gap:10px;">
          <select id="ed-mode" style="flex:1;">
            <option value="Epidural" ${(p.mode||'Epidural')==='Epidural'?'selected':''}>Epidural</option>
            <option value="NBC" ${p.mode==='NBC'?'selected':''}>NBC (Nerve Block Catheter)</option>
            <option value="PCA" ${p.mode==='PCA'?'selected':''}>PCA (Patient Controlled Analgesia)</option>
            <option value="Dosifuser" ${p.mode==='Dosifuser'?'selected':''}>Dosifuser</option>
          </select>
          <span class="mode-badge mode-${p.mode||'Epidural'}" id="ed-mode-badge">${escapeHtml(modeLabels[p.mode||'Epidural'])}</span>
        </div>
        <div style="font-size:11px;color:var(--ink-soft);font-weight:600;margin:12px 0 5px;">Location</div>
        <input type="text" id="ed-location" value="${escapeHtml(p.location||'')}" placeholder="Level of epidural / nerve block site">

        <div style="font-size:11px;color:var(--ink-soft);font-weight:600;margin:12px 0 5px;">Current dose</div>
        <div class="field-hint">${p.mode==='NBC' ? activeCatheters(p).map(c=>{
          const label = (c.label&&c.label.trim()) ? c.label.trim() : 'Catheter';
          const eff = effectiveDoseRaw(c, 5);
          const dueBit = BOLUS_INTERVAL_HOURS[eff.freqType] ? ` · ${escapeHtml(fmtDueLabelRaw(c))}` : '';
          return `<b>${escapeHtml(label)}:</b> ${escapeHtml(eff.drug||'—')} · ${escapeHtml(eff.frequency||'—')} · ${escapeHtml(eff.freqType||'—')}${dueBit}`;
        }).join('<br>') : `${escapeHtml(p.drug||'—')} · ${escapeHtml(p.frequency||'—')} · ${escapeHtml(p.freqType||'—')}${BOLUS_INTERVAL_HOURS[p.freqType] ? ` · ${escapeHtml(fmtDueLabel(p))}` : ''}`} — edit in Daily APS Review below</div>
        </div>

        <fieldset>
          <legend>Daily APS Review</legend>
          <div id="dailyRoundsBlock">${renderDailyRoundsBlock(p, activeDay)}</div>
        </fieldset>

        ${(p.transferLog&&p.transferLog.length) ? `
        <div style="font-size:11px;color:var(--ink-faint);margin-top:12px;">
          Transfer history: ${p.transferLog.map(t=>`${escapeHtml(t.from)} → ${escapeHtml(t.to)} (${new Date(t.ts).toLocaleDateString()})`).join('; ')}
        </div>` : ''}

        ${p.status==='discharged'
          ? `<button class="btn secondary" id="dischargeBtn" style="margin-top:14px;">Reactivate patient</button>
             <button class="btn danger" id="deleteBtn" style="margin-top:10px;">Delete patient</button>`
          : `<div class="icon-btn-row">
               <button class="icon-action-btn" id="dischargeBtn" aria-label="Discharge patient" title="Discharge patient">${ICON_LOGOUT}</button>
               <button class="icon-action-btn danger" id="deleteBtn" aria-label="Delete patient" title="Delete patient">${ICON_TRASH}</button>
             </div>`
        }
      </div>
    `;
    $('sheetBackdrop').classList.add('open');
    $('sheet').classList.add('open');
    $('closeSheet').onclick = closeDetail;
    $('sheetBackdrop').onclick = closeDetail;
    $('ed-mode').addEventListener('change', ()=>{
      updateModeBadge('ed-mode','ed-mode-badge');
      p.mode = $('ed-mode').value;
      roundsBlock.innerHTML = renderDailyRoundsBlock(p, activeDay);
      wireAllBolusHints(p);
    });
    const edRoleEl = $('ed-doneby-role');
    if(edRoleEl){
      edRoleEl.addEventListener('change', (e)=>{
        const isSurg = e.target.value === 'surgeon';
        const lbl = $('ed-doneby-label');
        const inp = $('ed-doneby');
        const hnt = $('ed-doneby-hint');
        if(lbl) lbl.textContent = isSurg ? 'Surgeon / Surgical unit' : 'Anaesthetist name';
        if(inp) inp.placeholder = isSurg ? 'e.g. Dr. Mohan / Ortho Unit' : 'e.g. Dr. Anand';
        if(hnt) hnt.style.display = isSurg ? 'block' : 'none';
      });
    }

    // Daily APS Review — tab switching, attendance toggle, anticoag, and the
    // single per-day save all live here now, delegated so they survive
    // re-renders of #dailyRoundsBlock.
    const roundsBlock = $('dailyRoundsBlock');
    wireAllBolusHints(p);
    roundsBlock.addEventListener('change', (e)=>{
      if(e.target.id.startsWith('dr-painrest-scale') || e.target.id.startsWith('dr-painmove-scale')){
        if(e.target.value) e.target.style.borderColor = '';
      }
      if(e.target.id.startsWith('dr-activated')){
        const suf = e.target.id.replace('dr-activated','');
        const isAct = e.target.value === 'active';
        const noticeEl = $('dr-inactive-notice'+suf);
        if(noticeEl) noticeEl.style.display = isAct ? 'none' : 'flex';
        const badgeEl = $('dr-badge-inactive'+suf);
        if(badgeEl) badgeEl.style.display = isAct ? 'none' : 'inline-block';
      }
    });
    roundsBlock.addEventListener('click', async (e)=>{
      const actNowBtn = e.target.closest('.activate-now-btn');
      if(actNowBtn){
        const suf = actNowBtn.dataset.actSuf || '';
        const actSel = $('dr-activated'+suf);
        if(actSel) actSel.value = 'active';
        const noticeEl = $('dr-inactive-notice'+suf);
        if(noticeEl) noticeEl.style.display = 'none';
        const badgeEl = $('dr-badge-inactive'+suf);
        if(badgeEl) badgeEl.style.display = 'none';
        const startedAtEl = $('dr-startedat'+suf);
        if(startedAtEl && !startedAtEl.value){
          const nowTime = new Date().toTimeString().slice(0,5);
          startedAtEl.value = nowTime;
        }
        toast('Status set to Active — remember to record pain scores when saving');
        return;
      }
      const tabBtn = e.target.closest('.day-tab');
      if(tabBtn){
        activeDay = Number(tabBtn.dataset.day);
        roundsBlock.innerHTML = renderDailyRoundsBlock(p, activeDay);
        wireAllBolusHints(p);
        return;
      }
      if(e.target.closest('#addCatheterBtn')){
        const label = window.prompt('Label for the new catheter (e.g. Femoral, Sciatic):', '');
        if(label === null) return; // cancelled
        ensureCatheters(p);
        if(activeCatheters(p).length >= 2){
          toast('Only two catheters are supported per patient');
          return;
        }
        const newCath = {
          id: 'c'+Date.now(), label: label.trim(), status: 'active', activated: true, createdAt: Date.now(),
          day0:{}, day1:{}, day2:{}, day3:{}, day4:{}, day5:{},
          boluses: [], drug:'', frequency:'', freqType:'', startedAt:''
        };
        try{
          await savePatientField(p.id, (base)=>{
            ensureCatheters(base).push(JSON.parse(JSON.stringify(newCath)));
          });
        }catch(err){
          if(err && err.doloraDeleted){ handleDeletedElsewhere(p.id); return; }
          toast('Could not add catheter: '+errMsg(err), 5000);
          return;
        }
        toast('Catheter added');
        sheetOpenedAt = patientUpdatedAt[p.id] || sheetOpenedAt;
        roundsBlock.innerHTML = renderDailyRoundsBlock(p, activeDay);
        wireAllBolusHints(p);
        renderAll();
        return;
      }
      const removeCathBtn = e.target.closest('.cath-remove-btn');
      if(removeCathBtn){
        const cathId = removeCathBtn.dataset.cathId;
        const cathLabel = removeCathBtn.dataset.cathLabel || 'this catheter';
        const ok = await askConfirm({
          title: 'Remove catheter?',
          message: `Remove ${cathLabel}? It drops out of active Rounds and Bolus tracking, but its full day-by-day history and bolus log are kept — it will still appear (marked Removed) in Bird's Eye and exports.`,
          confirmLabel: 'Remove',
          danger: true
        });
        if(!ok) return;
        try{
          await savePatientField(p.id, (base)=>{
            const c = ensureCatheters(base).find(x=>x.id===cathId);
            if(c){ c.status='removed'; c.removedAt=Date.now(); c.removedBy=(window.doloraUser&&window.doloraUser.name)||'Unknown'; }
          });
        }catch(err){
          if(err && err.doloraDeleted){ handleDeletedElsewhere(p.id); return; }
          toast('Could not remove catheter: '+errMsg(err), 5000);
          return;
        }
        toast(cathLabel+' removed');
        sheetOpenedAt = patientUpdatedAt[p.id] || sheetOpenedAt;
        roundsBlock.innerHTML = renderDailyRoundsBlock(p, activeDay);
        wireAllBolusHints(p);
        renderAll();
        return;
      }
      const saveBtn = e.target.closest('.save-day-btn');
      if(saveBtn){
        // cathId is set for a per-catheter card's SAVE button (NBC, see
        // renderCatheterCard); null for the single combined SAVE button used
        // by every other mode. `suf` matches the id suffix those fields were
        // rendered with in renderDoseAndAssessmentFields.
        const cathId = saveBtn.dataset.cathId || null;
        const cathLabel = saveBtn.dataset.cathLabel || null;
        const suf = cathId ? '-'+cathId : '';

        const actSelect = $('dr-activated'+suf);
        const willBeActive = actSelect ? (actSelect.value === 'active') : true;

        const painRestVal = $('dr-painrest-scale'+suf).value;
        const painMoveVal = $('dr-painmove-scale'+suf).value;
        $('dr-painrest-scale'+suf).style.borderColor = '';
        $('dr-painmove-scale'+suf).style.borderColor = '';

        const isSurgCase = $('ed-doneby-role') ? ($('ed-doneby-role').value === 'surgeon') : (p.doneByRole === 'surgeon');
        if(willBeActive && !isSurgCase){
          if(!painRestVal || !painMoveVal){
            if(!painRestVal) $('dr-painrest-scale'+suf).style.borderColor = 'var(--alert)';
            if(!painMoveVal) $('dr-painmove-scale'+suf).style.borderColor = 'var(--alert)';
            toast('Enter both Pain at rest and Pain on movement before saving (or set status to Not yet activated)', 3500);
            return;
          }
        }
        const snapshot = JSON.parse(JSON.stringify(p)); // full rollback point — this button now saves everything on the sheet
        const newCampus = $('ed-campus').value;
        if(newCampus !== (p.campus||'Main Campus')){
          p.transferLog = p.transferLog || [];
          p.transferLog.push({from:p.campus||'Main Campus', to:newCampus, ts:Date.now()});
          p.campus = newCampus;
        }
        p.ward=$('ed-ward').value.trim();
        p.bed=$('ed-bed').value.trim();
        p.name=$('ed-name').value.trim();
        p.apsDate=$('ed-apsdate').value;
        p.gender=$('ed-gender').value;
        p.age=$('ed-age').value.trim();
        p.doneByRole = $('ed-doneby-role') ? $('ed-doneby-role').value : (p.doneByRole || 'anaesthetist');
        p.doneBy=$('ed-doneby').value.trim();
        p.dx=$('ed-dx').value.trim();
        p.surgery=$('ed-surgery').value.trim();
        p.mode=$('ed-mode').value;
        p.location=$('ed-location').value.trim();
        p.anticoagStatus=$('dr-anticoagstatus').value;
        p.anticoag=$('dr-anticoagnotes').value.trim();

        // For NBC this writes onto the specific catheter that owns this SAVE
        // button; for every other mode `dayTargetHolder` is the patient
        // itself, exactly as before.
        let dayTargetHolder = p;
        if(cathId){
          ensureCatheters(p);
          dayTargetHolder = p.catheters.find(c=>c.id===cathId);
          if(!dayTargetHolder){
            toast('Could not find that catheter — close and reopen this patient', 5000);
            return;
          }
        }
        dayTargetHolder.activated = willBeActive;
        if(willBeActive && !dayTargetHolder.activatedAt){
          dayTargetHolder.activatedAt = Date.now();
        }
        if(!cathId){
          p.activated = willBeActive;
          if(willBeActive && !p.activatedAt){
            p.activatedAt = Date.now();
          }
        } else {
          p.activated = activeCatheters(p).some(c=>c.activated !== false);
        }
        const existing = getDayRaw(dayTargetHolder, activeDay);
        const carriedEff = effectiveDoseRaw(dayTargetHolder, activeDay);
        const carriedStartedAt = carriedEff.startedAt || '';
        dayTargetHolder['day'+activeDay] = {
          ...existing,
          stamp: todayStr(),
          drug: $('dr-drug'+suf).value.trim(),
          frequency: $('dr-freq'+suf).value.trim(),
          freqType: $('dr-freqtype'+suf).value,
          startedAt: ($('dr-startedat'+suf) && $('dr-startedat'+suf).value) ? $('dr-startedat'+suf).value : (existing.startedAt || carriedStartedAt),
          painRest: painRestVal,
          painMove: painMoveVal,
          motorBlock: $('dr-motorblock-select'+suf).value,
          dermCover: $('dr-dermcover-select'+suf).value,
          catheterSite: $('dr-cathsite'+suf).value,
          remarks: $('dr-dayremarks'+suf).value.trim()
        };
        if(cathId) syncCatheterDoseMirror(dayTargetHolder);
        syncCurrentDoseMirror(p);

        const conflict = await hasConflict(p.id, sheetOpenedAt);
        if(conflict === 'deleted'){
          // Someone else deleted this patient while we had the sheet open.
          // Discard our in-memory edits and clean up — do NOT save, since
          // that would upsert this patient right back in, silently undoing
          // the delete.
          Object.keys(p).forEach(k=>delete p[k]);
          Object.assign(p, snapshot);
          handleDeletedElsewhere(p.id);
          return;
        }
        if(conflict === 'edited'){
          const reload = await askConfirm({
            title: 'Record updated elsewhere',
            message: 'Someone else updated this record while you had it open. Load their latest version? Any unsaved changes on this screen will be lost — copy anything important first.',
            confirmLabel: 'Load latest'
          });
          Object.keys(p).forEach(k=>delete p[k]);
          Object.assign(p, snapshot); // undo the in-memory edits either way — only a real save should persist them
          if(reload){
            await loadAll();
            renderAll();
            openDetail(p.id);
          } else {
            roundsBlock.innerHTML = renderDailyRoundsBlock(p, activeDay);
            wireAllBolusHints(p);
            toast('Not saved — refresh to see the latest before editing again', 5000);
          }
          return;
        }

        logActivity(p, 'edited');
        try{
          await savePatient(p);
        }catch(err){
          Object.keys(p).forEach(k=>delete p[k]);
          Object.assign(p, snapshot); // roll back everything so the form doesn't show unsaved data as saved
          toast('Could not save — check your connection and try again ('+errMsg(err)+')', 5000);
          return;
        }
        toast(cathLabel ? (cathLabel+' · Day '+activeDay+' saved') : ('Day '+activeDay+' saved'));
        sheetOpenedAt = patientUpdatedAt[p.id] || sheetOpenedAt;
        refreshWardOptions();
        roundsBlock.innerHTML = renderDailyRoundsBlock(p, activeDay);
        wireAllBolusHints(p);
        renderAll();
      }
    });

    if($('dischargeBtn')){
      $('dischargeBtn').onclick = async ()=>{
        if(p.status==='discharged'){
          // Reactivate: recovery action, no confirm needed, fires instantly
          try{
            await savePatientField(p.id, (base)=>{
              base.status = 'active';
              base.dischargedAt = null;
              logActivity(base, 'reactivated');
            });
          }catch(e){
            if(e && e.doloraDeleted){ handleDeletedElsewhere(p.id); return; }
            toast('Could not save — check your connection and try again ('+errMsg(e)+')', 5000);
            return;
          }
          toast('Reactivated');
          renderAll();
          closeDetail();
        } else {
          // Discharge: same confirm popup as the Rounds row icon, for consistency
          openDischargeConfirm(p.id);
        }
      };
    }

    if($('deleteBtn')){
      $('deleteBtn').onclick = ()=>deletePatientFlow(p);
    }
  }
  function closeDetail(){ $('sheetBackdrop').classList.remove('open'); $('sheet').classList.remove('open'); }

  // ---------- Add ----------
  wireBolusHint('f-freqtype','f-startedat','f-bolus-hint');
  $('submitBtn').addEventListener('click', async ()=>{
    const name = $('f-name').value.trim();
    const ward = $('f-ward').value.trim();
    const hnoRaw = $('f-hno').value.trim();
    if(!name || !ward || !hnoRaw){ toast('Enter Hospital No, patient name, and ward'); return; }

    const key = patientKey(hnoRaw);
    if(patients[key]){
      const existing = patients[key];
      toast('Hospital No '+hnoRaw+' already exists ('+(existing.campus||'Main Campus')+') — opening that record', 3500);
      switchView(existing.campus==='Ranipet' ? 'room-ranipet' : 'room-main');
      openDetail(key);
      return;
    }

    const isAct = ($('f-activation') && $('f-activation').value === 'inactive') ? false : true;
    const doneByRole = ($('f-doneby-role') && $('f-doneby-role').value) || 'anaesthetist';
    const isSurg = doneByRole === 'surgeon';

    const p = {
      id: key,
      hospitalNo: hnoRaw,
      campus: $('f-campus').value || 'Main Campus',
      ward,
      bed: $('f-bed').value.trim(),
      name,
      apsDate: $('f-apsdate').value || todayStr(),
      gender: $('f-gender').value,
      age: $('f-age').value.trim(),
      doneByRole,
      doneBy: $('f-doneby').value.trim(),
      dx: $('f-dx').value.trim(),
      surgery: $('f-surgery').value.trim(),
      mode: $('f-mode').value,
      location: $('f-location').value.trim(),
      drug: $('f-drug').value.trim(),
      frequency: $('f-freq').value.trim(),
      freqType: $('f-freqtype').value,
      startedAt: $('f-startedat').value,
      startedAtStamp: todayStr(),
      activated: isAct,
      activatedAt: isAct ? Date.now() : null,
      boluses: [],
      anticoag: '',
      anticoagStatus: 'NO',
      attendance: {},
      day0:{stamp:todayStr(),remarks:'',drug:$('f-drug').value.trim(),frequency:$('f-freq').value.trim(),freqType:$('f-freqtype').value,startedAt:$('f-startedat').value},
      day1:{stamp:null,note:''},day2:{stamp:null,note:''},
      day3:{stamp:null,note:''},day4:{stamp:null,note:''},day5:{stamp:null,note:''},
      transferLog: [],
      status: 'active',
      dischargedAt: null,
      createdAt: Date.now()
    };

    const secondCathActive = p.mode==='NBC' && $('secondCathBlock').style.display !== 'none';
    if(secondCathActive){
      // Two catheters from the same yellow sheet, entered together right here
      // instead of having to save the patient first and hunt for "Add another
      // catheter" inside the daily review. Catheter 1 carries the fields
      // already captured above (its "label" is just its Location text);
      // catheter 2 gets its own Location + Day 0.
      const cath1Label = $('f-location').value.trim();
      const cath2Label = $('f2-location').value.trim();
      const cath2Drug = $('f2-drug').value.trim();
      const cath2Freq = $('f2-freq').value.trim();
      const cath2FreqType = $('f2-freqtype').value;
      const cath2StartedAt = $('f2-startedat').value;
      const isAct2 = ($('f2-activation') && $('f2-activation').value === 'inactive') ? false : true;
      p.catheters = [
        {
          id: 'c1', label: cath1Label, status: 'active', activated: isAct, activatedAt: isAct ? Date.now() : null, createdAt: Date.now(),
          day0: {stamp:todayStr(), remarks:'', drug:p.drug, frequency:p.frequency, freqType:p.freqType, startedAt:p.startedAt},
          day1:{}, day2:{}, day3:{}, day4:{}, day5:{},
          boluses: [], drug:p.drug, frequency:p.frequency, freqType:p.freqType, startedAt:p.startedAt
        },
        {
          id: 'c2', label: cath2Label, status: 'active', activated: isAct2, activatedAt: isAct2 ? Date.now() : null, createdAt: Date.now(),
          day0: {stamp:todayStr(), remarks:'', drug:cath2Drug, frequency:cath2Freq, freqType:cath2FreqType, startedAt:cath2StartedAt},
          day1:{}, day2:{}, day3:{}, day4:{}, day5:{},
          boluses: [], drug:cath2Drug, frequency:cath2Freq, freqType:cath2FreqType, startedAt:cath2StartedAt
        }
      ];
      p.activated = isAct || isAct2;
    }

    patients[key] = p;
    try{
      await savePatient(p);
    }catch(e){
      console.error('Save failed:', errMsg(e));
      toast('Save failed: '+errMsg(e), 6000);
      delete patients[key];
      return;
    }
    toast(isSurg ? 'Registered in catheter database (not on APS rounds)' : 'Added to '+p.campus+' rounds');

    ['f-hno','f-ward','f-bed','f-name','f-gender','f-age','f-doneby','f-dx','f-surgery','f-location','f-drug','f-freq','f-freqtype','f-startedat',
     'f2-location','f2-drug','f2-freq','f2-freqtype','f2-startedat']
      .forEach(id=>$(id).value='');
    if($('f-apsdate')) $('f-apsdate').value = todayStr();
    $('f-mode').value = 'Epidural';
    $('f-campus').value = 'Main Campus';
    if($('f-doneby-role')) $('f-doneby-role').value = 'anaesthetist';
    updateDoneByUI();
    if($('f-activation')) $('f-activation').value = 'active';
    if($('f2-activation')) $('f2-activation').value = 'active';
    updateModeBadge('f-mode','f-mode-badge');
    $('f-bolus-hint').style.display = 'none';
    $('nbcSecondCathWrap').style.display = 'none';
    $('secondCathBlock').style.display = 'none';
    $('addSecondCathBtn').textContent = '+ Add second nerve block catheter';
    syncLocHeader();
    syncLoc2Header();

    refreshWardOptions();
    renderAll();
    switchView(isSurg ? 'eagle' : (p.campus==='Ranipet' ? 'room-ranipet' : 'room-main'));
  });

  function updateDoneByUI(){
    const sel = $('f-doneby-role');
    if(!sel) return;
    const isSurg = sel.value === 'surgeon';
    const labelEl = $('f-doneby-label');
    const inputEl = $('f-doneby');
    const hintEl = $('f-doneby-hint');
    const submitBtn = $('submitBtn');
    if(labelEl) labelEl.textContent = isSurg ? 'Surgeon / Surgical unit' : 'Anaesthetist name';
    if(inputEl) inputEl.placeholder = isSurg ? 'e.g. Dr. Mohan / Ortho Unit' : 'e.g. Dr. Anand';
    if(hintEl) hintEl.style.display = isSurg ? 'block' : 'none';
    if(submitBtn) submitBtn.textContent = isSurg ? 'Register catheter (surgical registry)' : 'Add to rounds';
  }
  if($('f-doneby-role')){
    $('f-doneby-role').addEventListener('change', updateDoneByUI);
  }

  // ---------- Eagle view ----------
  function dayCell(p, idx){
    const d = getDay(p, idx);
    const calDate = dayCalendarDate(p.apsDate, idx);
    const stampTag = d.stamp ? `<span style="color:var(--safe);font-family:var(--mono);font-size:10px;">✓${calDate?fmtShortDate(calDate):fmtShortDate(d.stamp)}</span> ` : '';
    const remarksText = d.remarks ? `<span style="display:block;font-size:11px;color:var(--ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;">${escapeHtml(d.remarks)}</span>` : '';
    return stampTag + remarksText;
  }
  function eagleStatusLabel(p){
    if(p.status==='deleted') return 'Deleted';
    if(p.status==='discharged') return 'Discharged';
    if(p.doneByRole==='surgeon') return 'Surgical (Registry)';
    if(p.activated === false) return 'Not yet activated';
    return 'Active';
  }
  // ---------- Bolus ----------
  // One bolus-eligible dose unit — the patient itself for non-NBC modes, or
  // one active catheter for NBC — carrying enough patient context (ward/
  // bed/name/hospitalNo) for grouping/display alongside the actual holder
  // whose freqType/boluses/etc. drive the calculations. A 2-catheter NBC
  // patient on Q8H Femoral + Q12H Sciatic produces two independent units
  // here; logging a bolus against one NEVER touches the other's history.
  function bolusUnits(){
    // Lives inside each campus Room now, so it's scoped to whichever Room
    // is currently open — same patients as that Room's Rounds tab, not the
    // top All/Main/Ranipet pill (that pill only applies to Bird's-eye).
    const units = [];
    roundsActivePatients().forEach(p=>{
      getDoseUnits(p).forEach(holder=>{
        if(!isBolusEligible(holder)) return;
        units.push({
          patientId: p.id,
          catheterId: p.mode==='NBC' ? holder.id : null,
          label: p.mode==='NBC' ? ((holder.label&&holder.label.trim())||'Catheter') : null,
          ward: p.ward, bed: p.bed, name: p.name, hospitalNo: p.hospitalNo,
          holder
        });
      });
    });
    return units;
  }
  function renderBolus(){
    const list = bolusUnits();
    $('bolusCount').textContent = list.length;
    if(!list.length){
      $('bolusBoard').innerHTML = '<div class="empty"><div class="big">—</div><p>No patients on Q6H / Q8H / Q12H interval dosing at '+escapeHtml(roomCampus)+' right now.</p></div>';
      return;
    }
    const {wardNames, groups} = groupByWard(list);
    // groupByWard sorts each ward's list by bed/name — re-sort within each
    // ward by soonest-due-first (most overdue bubbles to the top) instead,
    // since that's the order a nurse would actually want to work through.
    wardNames.forEach(w=> groups[w].sort((a,b)=> nextBolusDueAtRaw(a.holder)-nextBolusDueAtRaw(b.holder)));

    let html = '';
    wardNames.forEach(w=>{
      html += `<div class="ward-header">${escapeHtml(w)} · ${groups[w].length}</div><div class="board">`;
      groups[w].forEach(u=>{
        const status = bolusStatusRaw(u.holder); // 'overdue' | 'soon' | 'ok'
        const unitKey = u.patientId + (u.catheterId ? ('::'+u.catheterId) : '');
        const nameLine = u.label ? `${escapeHtml(u.name||'—')} — ${escapeHtml(u.label)}` : escapeHtml(u.name||'—');
        html += `
        <div class="row bolus-${status}" data-bolus-id="${unitKey}">
          <div class="row-main">
            <div class="row-top"><span class="p-name">${nameLine}</span></div>
            <div class="p-sub">Bed ${escapeHtml(u.bed||'—')} · ${escapeHtml(u.hospitalNo||'—')} · ${escapeHtml(u.holder.freqType)}</div>
            <div class="bolus-due-label">${escapeHtml(fmtDueLabelRaw(u.holder))}</div>
            <div class="bolus-last-label">${escapeHtml(fmtLastGivenRaw(u.holder))}</div>
          </div>
          <button class="btn log-bolus" data-patient-id="${u.patientId}" data-cath-id="${u.catheterId||''}">Log bolus</button>
        </div>`;
      });
      html += '</div>';
    });
    $('bolusBoard').innerHTML = html;

    document.querySelectorAll('#bolusBoard .log-bolus').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const patientId = btn.getAttribute('data-patient-id');
        const cathId = btn.getAttribute('data-cath-id') || null;
        const p = patients[patientId];
        if(!p) return;
        const cathLabel = cathId ? (activeCatheters(p).find(c=>c.id===cathId)||{}).label : null;
        const confirmName = cathLabel ? `${p.name||'this patient'} — ${cathLabel}` : (p.name||'this patient');
        const ok = await askConfirm({
          title: 'Confirm bolus?',
          message: `Confirm bolus given now for ${confirmName} (Bed ${p.bed||'—'})?`,
          confirmLabel: 'Confirm'
        });
        if(!ok) return;
        const bolusEntry = {
          ts: Date.now(),
          by: (window.doloraUser && window.doloraUser.name) || 'Unknown',
          byId: (window.doloraUser && window.doloraUser.id) || null
        };
        try{
          await savePatientField(patientId, (base)=>{
            // cathId set = NBC catheter's own bolus log; unset = patient-level
            // (every other mode) — never cross-write between the two.
            if(cathId){
              const c = ensureCatheters(base).find(x=>x.id===cathId);
              if(!c) throw new Error('catheter not found (may have been removed)');
              c.boluses = c.boluses || [];
              c.boluses.push(bolusEntry);
            } else {
              base.boluses = base.boluses || [];
              base.boluses.push(bolusEntry);
            }
          });
        }catch(e){
          if(e && e.doloraDeleted){ handleDeletedElsewhere(patientId); return; }
          toast('Could not log bolus: '+errMsg(e), 5000);
          return;
        }
        toast('Bolus logged for '+confirmName);
        renderBolus();
      });
    });
  }

  // One Bird's-eye row per dose-bearing unit — the patient itself for
  // non-NBC modes, or one row per catheter (active AND removed, so removed
  // catheters stay visible for audit as the app already promises when
  // removing one) for NBC. A 2-catheter NBC patient always produces two
  // rows here; a patient is never flattened down to catheter 1. Carries
  // ward/bed/name at the top level so groupByWard's sort works unchanged.
  function eagleRows(p){
    if(p.mode !== 'NBC') return [{p, holder:p, catheterLabel:null, catheterStatus:null, ward:p.ward, bed:p.bed, name:p.name}];
    const cats = getCatheters(p);
    if(!cats.length) return [{p, holder:p, catheterLabel:null, catheterStatus:null, ward:p.ward, bed:p.bed, name:p.name}];
    return cats.map(c=> ({
      p, holder:c,
      catheterLabel: (c.label&&c.label.trim())||'Catheter',
      catheterStatus: c.status==='removed' ? 'Removed' : (c.activated===false ? 'Not activated' : 'Active'),
      ward:p.ward, bed:p.bed, name:p.name
    }));
  }

  // ---------- Bird's Eye Month Navigation & Duty Team Roster ----------
  let eagleMonth = todayStr().slice(0,7); // 'YYYY-MM' or 'all'
  const monthlyRosters = {}; // ym -> { team: string, by: string, ts: number }

  function fmtMonthYear(ym){
    if(!ym || ym==='all') return 'All Time';
    const parts = ym.split('-');
    if(parts.length!==2) return ym;
    const d = new Date(Number(parts[0]), Number(parts[1])-1, 1);
    return d.toLocaleDateString(undefined, {month:'long', year:'numeric'});
  }

  function shiftMonth(ym, delta){
    if(!ym || ym==='all') ym = todayStr().slice(0,7);
    const parts = ym.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]) - 1 + delta;
    const d = new Date(y, m, 1);
    const nextY = d.getFullYear();
    const nextM = String(d.getMonth()+1).padStart(2,'0');
    return `${nextY}-${nextM}`;
  }

  async function loadMonthlyRoster(ym){
    if(!ym || ym==='all') return null;
    if(monthlyRosters[ym] !== undefined) return monthlyRosters[ym];
    try{
      const r = await window.storage.get('aps-roster:'+ym, true);
      if(r && r.value){
        const parsed = JSON.parse(r.value);
        monthlyRosters[ym] = {
          mainTeam: parsed.mainTeam || (parsed.team || ''),
          ranipetTeam: parsed.ranipetTeam || '',
          team: parsed.team || [parsed.mainTeam, parsed.ranipetTeam].filter(Boolean).join(', '),
          by: parsed.by || 'Admin',
          byId: parsed.byId || null,
          ts: parsed.ts || Date.now()
        };
      } else {
        monthlyRosters[ym] = null;
      }
    }catch(e){
      monthlyRosters[ym] = null;
    }
    return monthlyRosters[ym];
  }

  async function saveMonthlyRoster(ym, dataOrText){
    if(!ym || ym==='all') return;
    const user = window.doloraUser;
    let mainTeam = '';
    let ranipetTeam = '';
    let team = '';
    if(typeof dataOrText === 'object' && dataOrText !== null){
      mainTeam = (dataOrText.mainTeam || '').trim();
      ranipetTeam = (dataOrText.ranipetTeam || '').trim();
      team = [mainTeam ? ('Main: ' + mainTeam) : '', ranipetTeam ? ('Ranipet: ' + ranipetTeam) : ''].filter(Boolean).join(' | ');
      if(!team && (dataOrText.team || '')) team = dataOrText.team.trim();
    } else {
      team = (dataOrText || '').trim();
      mainTeam = team;
    }
    const entry = {
      mainTeam,
      ranipetTeam,
      team,
      by: (user && user.name) || 'Admin',
      byId: (user && user.id) || null,
      ts: Date.now()
    };
    monthlyRosters[ym] = entry;
    await window.storage.set('aps-roster:'+ym, JSON.stringify(entry), true);
    return entry;
  }

  function openTeamModal(){
    if(eagleMonth === 'all'){
      toast('Select a specific month to assign its duty team');
      return;
    }
    const ym = eagleMonth;
    const monthTitle = fmtMonthYear(ym);
    if($('teamModalTitle')) $('teamModalTitle').textContent = 'APS Duty Team · ' + monthTitle;
    if($('teamModalSubtitle')) $('teamModalSubtitle').textContent = 'Enter the attending doctors and clinicians on duty for ' + monthTitle;
    const cur = monthlyRosters[ym];
    if($('teamModalMainInput')) $('teamModalMainInput').value = (cur && cur.mainTeam) ? cur.mainTeam : ((cur && cur.team) ? cur.team : '');
    if($('teamModalRanipetInput')) $('teamModalRanipetInput').value = (cur && cur.ranipetTeam) ? cur.ranipetTeam : '';
    if($('teamModalBackdrop')) $('teamModalBackdrop').classList.add('open');
  }

  function closeTeamModal(){
    if($('teamModalBackdrop')) $('teamModalBackdrop').classList.remove('open');
  }

  // Wire up Eagle month controls and team modal
  if($('eaglePrevMonthBtn')){
    $('eaglePrevMonthBtn').addEventListener('click', ()=>{
      eagleMonth = shiftMonth(eagleMonth, -1);
      renderEagle();
    });
  }
  if($('eagleNextMonthBtn')){
    $('eagleNextMonthBtn').addEventListener('click', ()=>{
      eagleMonth = shiftMonth(eagleMonth, 1);
      renderEagle();
    });
  }
  if($('eagleMonthPicker')){
    $('eagleMonthPicker').addEventListener('change', ()=>{
      if($('eagleMonthPicker').value){
        eagleMonth = $('eagleMonthPicker').value;
        renderEagle();
      }
    });
  }
  if($('eagleThisMonthBtn')){
    $('eagleThisMonthBtn').addEventListener('click', ()=>{
      eagleMonth = todayStr().slice(0,7);
      renderEagle();
    });
  }
  if($('eagleAllTimeBtn')){
    $('eagleAllTimeBtn').addEventListener('click', ()=>{
      eagleMonth = 'all';
      renderEagle();
    });
  }
  if($('editEagleTeamBtn')){
    $('editEagleTeamBtn').addEventListener('click', openTeamModal);
  }
  if($('teamModalCancel')){
    $('teamModalCancel').addEventListener('click', closeTeamModal);
  }
  if($('teamModalBackdrop')){
    $('teamModalBackdrop').addEventListener('click', (e)=>{
      if(e.target.id === 'teamModalBackdrop') closeTeamModal();
    });
  }
  if($('teamModalSave')){
    $('teamModalSave').addEventListener('click', async ()=>{
      const mainVal = $('teamModalMainInput') ? $('teamModalMainInput').value.trim() : '';
      const ranipetVal = $('teamModalRanipetInput') ? $('teamModalRanipetInput').value.trim() : '';
      await saveMonthlyRoster(eagleMonth, {
        mainTeam: mainVal,
        ranipetTeam: ranipetVal,
        team: [mainVal, ranipetVal].filter(Boolean).join(', ')
      });
      closeTeamModal();
      toast('Duty teams saved for ' + fmtMonthYear(eagleMonth));
      renderEagle();
    });
  }

  async function renderEagle(){
    const isCurMonth = (eagleMonth === todayStr().slice(0,7));
    const isAllTime = (eagleMonth === 'all');

    if($('eagleMonthPicker')) $('eagleMonthPicker').value = isAllTime ? '' : eagleMonth;
    if($('eagleThisMonthBtn')) $('eagleThisMonthBtn').classList.toggle('active', isCurMonth);
    if($('eagleAllTimeBtn')) $('eagleAllTimeBtn').classList.toggle('active', isAllTime);

    const monthTitle = fmtMonthYear(eagleMonth);
    if($('eagleTeamMonthLabel')) $('eagleTeamMonthLabel').textContent = monthTitle;

    const isAdmin = window.doloraUser && window.doloraUser.role === 'admin';
    if($('editEagleTeamBtn')){
      $('editEagleTeamBtn').style.display = (isAdmin && !isAllTime) ? 'inline-block' : 'none';
    }

    if(isAllTime){
      if($('eagleTeamBody')){
        $('eagleTeamBody').innerHTML = `<span class="eagle-team-empty">Viewing all-time records across all months. Pick a month using the calendar above to view that month's duty team.</span>`;
      }
    } else {
      const roster = await loadMonthlyRoster(eagleMonth);
      const bodyEl = $('eagleTeamBody');
      if(bodyEl){
        const mainNames = (roster && roster.mainTeam) ? roster.mainTeam.split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean) : [];
        const ranipetNames = (roster && roster.ranipetTeam) ? roster.ranipetTeam.split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean) : [];
        const fallbackNames = (roster && roster.team && !mainNames.length && !ranipetNames.length) ? roster.team.split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean) : [];

        let html = '';
        if(mainNames.length > 0 || ranipetNames.length > 0 || fallbackNames.length > 0){
          if(currentCampus === 'all' || !currentCampus){
            if(mainNames.length > 0){
              html += `<div style="margin-bottom:4px;"><strong style="font-size:11px;color:var(--ink-soft);display:block;margin-bottom:2px;">🏥 MAIN CAMPUS:</strong>` +
                mainNames.map(n=>`<span class="eagle-team-chip">👨‍⚕️ ${escapeHtml(n)}</span>`).join('') + `</div>`;
            }
            if(ranipetNames.length > 0){
              html += `<div style="margin-top:4px;"><strong style="font-size:11px;color:var(--ink-soft);display:block;margin-bottom:2px;">🏥 RANIPET:</strong>` +
                ranipetNames.map(n=>`<span class="eagle-team-chip">👨‍⚕️ ${escapeHtml(n)}</span>`).join('') + `</div>`;
            }
            if(!mainNames.length && !ranipetNames.length && fallbackNames.length){
              html += fallbackNames.map(n=>`<span class="eagle-team-chip">👨‍⚕️ ${escapeHtml(n)}</span>`).join('');
            }
          } else if(currentCampus === 'Main Campus'){
            const names = mainNames.length ? mainNames : fallbackNames;
            if(names.length){
              html += names.map(n=>`<span class="eagle-team-chip">👨‍⚕️ ${escapeHtml(n)}</span>`).join('');
            } else {
              html = `<span class="eagle-team-empty">No Main Campus team assigned for ${escapeHtml(monthTitle)}.</span>`;
            }
          } else if(currentCampus === 'Ranipet'){
            const names = ranipetNames.length ? ranipetNames : fallbackNames;
            if(names.length){
              html += names.map(n=>`<span class="eagle-team-chip">👨‍⚕️ ${escapeHtml(n)}</span>`).join('');
            } else {
              html = `<span class="eagle-team-empty">No Ranipet team assigned for ${escapeHtml(monthTitle)}.</span>`;
            }
          }
          if(roster && roster.by){
            html += `<span style="font-size:11px;color:var(--ink-faint);margin-left:6px;display:inline-block;">(Assigned by ${escapeHtml(roster.by)})</span>`;
          }
          bodyEl.innerHTML = html;
        } else {
          if(isAdmin){
            bodyEl.innerHTML = `<span class="eagle-team-empty">No duty team assigned for ${escapeHtml(monthTitle)}.</span>
              <button type="button" class="btn secondary" id="assignTeamInlineBtn" style="width:auto;margin:0;padding:3px 10px;font-size:11.5px;">+ Assign team</button>`;
            const btn = $('assignTeamInlineBtn');
            if(btn) btn.addEventListener('click', openTeamModal);
          } else {
            bodyEl.innerHTML = `<span class="eagle-team-empty">No duty team recorded for ${escapeHtml(monthTitle)}.</span>`;
          }
        }
      }
    }

    // Filter patients by month (or show all if 'all')
    let patientList = allPatientsList();
    if(!isAllTime){
      patientList = patientList.filter(p => p && p.apsDate && p.apsDate.startsWith(eagleMonth));
    }

    const list = [];
    patientList.forEach(p=> eagleRows(p).forEach(r=> list.push(r)));
    $('eagleCount').textContent = patientList.length;
    const {wardNames, groups} = groupByWard(list);
    let rows = '';
    wardNames.forEach(w=>{
      rows += `<tr class="ward-group-row"><td colspan="24">${escapeHtml(w)} (${groups[w].length})</td></tr>`;
      groups[w].forEach(r=>{
        const p = r.p, holder = r.holder;
        const mode = p.mode || '';
        const cathCell = r.catheterLabel
          ? escapeHtml(r.catheterLabel) + (r.catheterStatus==='Removed' ? ` <span style="color:var(--ink-faint);font-size:10px;">(Removed)</span>` : '')
          : '—';
        const doneByRoleBadge = (p.doneByRole==='surgeon')
          ? `<span style="display:inline-block;background:#FEF3C7;color:#92400E;border:1px solid #FDE68A;font-size:9.5px;font-weight:700;padding:1px 5px;border-radius:4px;margin-right:4px;">Surg</span>`
          : `<span style="display:inline-block;background:#EFF6FF;color:#1E40AF;border:1px solid #BFDBFE;font-size:9.5px;font-weight:700;padding:1px 5px;border-radius:4px;margin-right:4px;">Anaesth</span>`;
        rows += `<tr class="clickable" data-id="${p.id}" style="cursor:pointer;">
          <td>${escapeHtml(p.campus||'Main Campus')}</td>
          <td>${escapeHtml(p.ward)}</td><td>${escapeHtml(p.bed)}</td><td>${escapeHtml(p.hospitalNo)}</td><td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.apsDate)}</td><td>${escapeHtml(p.gender)}</td><td>${escapeHtml(p.age)}</td>
          <td class="wide">${escapeHtml(p.dx)}</td><td class="wide">${escapeHtml(p.surgery)}</td>
          <td>${mode?`<span class="mode-badge mode-${mode}">${escapeHtml(modeLabels[mode]||mode)}</span>`:'—'}</td>
          <td>${cathCell}</td>
          <td class="wide">${escapeHtml(p.location)}</td><td>${doneByRoleBadge}${escapeHtml(p.doneBy||'—')}</td>
          <td>${escapeHtml(holder.drug)}</td><td>${escapeHtml(holder.frequency)}</td>
          <td class="wide"><span class="anticoag-badge anticoag-${(p.anticoagStatus||'NO').toLowerCase()}">${escapeHtml(p.anticoagStatus||'NO')}</span>${p.anticoag?`<span style="display:block;font-size:11px;color:var(--ink-soft);margin-top:3px;">${escapeHtml(p.anticoag)}</span>`:''}</td>
          <td>${dayCell(holder,0)}</td><td>${dayCell(holder,1)}</td><td>${dayCell(holder,2)}</td><td>${dayCell(holder,3)}</td><td>${dayCell(holder,4)}</td><td>${dayCell(holder,5)}</td>
          <td>${eagleStatusLabel(p)}${(p.status==='discharged' && p.dischargedAt) ? `<span style="display:block;font-size:10.5px;color:var(--ink-faint);margin-top:2px;">${fmtShortDateFromTs(p.dischargedAt)}</span>` : ''}</td>
        </tr>`;
      });
    });
    const emptyMsg = (!isAllTime)
      ? `No patients recorded in ${fmtMonthYear(eagleMonth)}`
      : `No patients to show`;
    $('eagleBody').innerHTML = rows || `<tr><td colspan="24" style="text-align:center;color:#9AA6B2;padding:24px;">${emptyMsg}</td></tr>`;
    document.querySelectorAll('#eagleBody tr[data-id]').forEach(el=>{
      el.addEventListener('click', ()=>openDetail(el.getAttribute('data-id')));
    });
  }
  // Enumerates the dose-bearing units to export for one patient — the
  // patient itself for non-NBC modes, or EVERY catheter (active AND
  // removed, via getCatheters not activeCatheters) for NBC, so a removed
  // catheter's history still shows up for audit as the app already
  // promises when removing one. Shared by the Catheters, Daily Reviews,
  // and Bolus Log sheets below so a 2-catheter patient is never collapsed
  // down to catheter 1.
  function exportDoseUnits(p){
    if(p.mode!=='NBC') return [{p, holder:p, catheterId:null, label:null, status:null, removedAt:null}];
    const cats = getCatheters(p);
    if(!cats.length) return [{p, holder:p, catheterId:null, label:null, status:null, removedAt:null}];
    return cats.map(c=>({
      p, holder:c, catheterId:c.id,
      label:(c.label&&c.label.trim())||'Catheter',
      status: c.status==='removed' ? 'Removed' : 'Active',
      removedAt: c.removedAt || null
    }));
  }
  $('exportBtn').addEventListener('click', async ()=>{
    let list = allPatientsList(); // active + discharged
    if(eagleMonth !== 'all'){
      list = list.filter(p => p && p.apsDate && p.apsDate.startsWith(eagleMonth));
    }
    if(!list.length){ toast('Nothing to export for ' + fmtMonthYear(eagleMonth)); return; }
    if(typeof XLSX === 'undefined'){ toast('Excel library failed to load — check connection'); return; }

    const roster = (eagleMonth !== 'all') ? await loadMonthlyRoster(eagleMonth) : null;

    // ---- Sheet 1: Patients — one row per patient, patient-level fields
    // only. For NBC, Drug/Volume are catheter-specific so they're left
    // blank here and a concise per-catheter summary is added instead.
    const patientRows = list.map(p=>{
      const units = exportDoseUnits(p);
      const cathSummary = p.mode==='NBC'
        ? units.map(u=> `${u.label}: ${u.holder.drug||'—'}${u.holder.frequency?' '+u.holder.frequency+'ml':''}${u.holder.freqType?' '+u.holder.freqType:''}${u.status==='Removed'?' (Removed)':''}`).join('; ')
        : '';
      const patientCampus = p.campus || 'Main Campus';
      let rowDutyTeam = 'Not assigned';
      if(roster){
        if(patientCampus === 'Ranipet'){
          rowDutyTeam = roster.ranipetTeam || roster.team || 'Not assigned';
        } else {
          rowDutyTeam = roster.mainTeam || roster.team || 'Not assigned';
        }
      }
      return {
        'Campus': patientCampus, 'Ward': p.ward, 'Bed': p.bed, 'Hospital No': p.hospitalNo, 'Name': p.name,
        'APS Date': p.apsDate, 'Gender': p.gender, 'Age': p.age,
        'Dx': p.dx, 'Surgery': p.surgery, 'APS Mode': modeLabels[p.mode]||p.mode||'', 'Location': p.location,
        'Placed By': (p.doneByRole==='surgeon') ? 'Surgeon' : 'Anaesthetist',
        'Done by': p.doneBy || '',
        'Service Management': (p.doneByRole==='surgeon') ? 'Surgical (Registry Only)' : 'APS Team',
        'APS Duty Team': rowDutyTeam,
        'Drug': p.mode==='NBC' ? '' : p.drug, 'Volume (ml)': p.mode==='NBC' ? '' : p.frequency,
        'Catheter Summary': cathSummary,
        'Anticoag Status': p.anticoagStatus||'NO', 'Anticoag Note': p.anticoag,
        'Status': eagleStatusLabel(p)
      };
    });

    // ---- Sheet 2: Catheters — one row per catheter (NBC patients only).
    const catheterRows = [];
    list.forEach(p=>{
      if(p.mode!=='NBC') return;
      getCatheters(p).forEach(c=>{
        catheterRows.push({
          'Hospital No': p.hospitalNo, 'Name': p.name, 'Campus': p.campus||'Main Campus', 'Ward': p.ward, 'Bed': p.bed,
          'Mode': modeLabels[p.mode]||p.mode||'', 'Catheter ID': c.id, 'Catheter Label': (c.label&&c.label.trim())||'Catheter',
          'Drug': c.drug||'', 'Volume/Dose': c.frequency||'', 'Frequency': c.freqType||'',
          'Started At': c.startedAt||'', 'Catheter Status': c.status==='removed'?'Removed':(c.activated===false?'Not activated':'Active'),
          'Removed At': c.removedAt ? new Date(c.removedAt).toLocaleString() : ''
        });
      });
    });

    // ---- Sheet 3: Daily Reviews — one row per Patient × Catheter ×
    // Postoperative Day, for every day that was actually reviewed (has a
    // saved stamp) — skips never-reviewed days so the sheet stays a real
    // audit log rather than mostly-blank rows.
    const reviewRows = [];
    list.forEach(p=>{
      exportDoseUnits(p).forEach(u=>{
        for(let d=0; d<=5; d++){
          const dObj = getDayRaw(u.holder, d);
          if(!dObj.stamp) continue;
          reviewRows.push({
            'Hospital No': p.hospitalNo, 'Name': p.name, 'Campus': p.campus||'Main Campus', 'Ward': p.ward, 'Bed': p.bed,
            'Mode': modeLabels[p.mode]||p.mode||'', 'Catheter ID': u.catheterId||'', 'Catheter Label': u.label||'',
            'Day': d, 'Date': fmtDDMMYY(dayCalendarDate(p.apsDate, d)),
            'Drug': dObj.drug||u.holder.drug||'', 'Volume/Dose': dObj.frequency||u.holder.frequency||'', 'Frequency': dObj.freqType||u.holder.freqType||'',
            'Pain at Rest': dObj.painRest||'', 'Pain on Movement': dObj.painMove||'', 'Motor Block': dObj.motorBlock||'',
            'Derm Cover': dObj.dermCover||'', 'Catheter Site': dObj.catheterSite||'', 'Remarks': dObj.remarks||'',
            'Anticoagulation Status': p.anticoagStatus||'NO'
          });
        }
      });
    });

    // ---- Sheet 4: Bolus Log — one row per logged bolus event.
    const bolusRows = [];
    list.forEach(p=>{
      exportDoseUnits(p).forEach(u=>{
        (u.holder.boluses||[]).forEach(b=>{
          bolusRows.push({
            'Hospital No': p.hospitalNo, 'Name': p.name, 'Catheter ID': u.catheterId||'', 'Catheter Label': u.label||'',
            'Timestamp': new Date(b.ts).toLocaleString(), 'Frequency': u.holder.freqType||'', 'Given By': b.by||''
          });
        });
      });
    });

    function addSheet(wb, rows, name){
      const ws = rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([['No data']]);
      if(rows.length) ws['!cols'] = Object.keys(rows[0]).map(k=>({wch: Math.max(10, Math.min(28, k.length+4))}));
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    const wb = XLSX.utils.book_new();
    addSheet(wb, patientRows, 'Patients');
    addSheet(wb, catheterRows, 'Catheters');
    addSheet(wb, reviewRows, 'Daily Reviews');
    addSheet(wb, bolusRows, 'Bolus Log');
    XLSX.writeFile(wb, 'APS_Registry_'+(eagleMonth==='all'?'AllTime':eagleMonth)+'_'+todayStr()+'.xlsx');
    toast('Exported');
  });

  // ---------- tabs ----------
  function applyRoomSubTabUI(){
    document.querySelectorAll('.room-subtab').forEach(b=>{
      b.classList.toggle('active', b.getAttribute('data-roomtab')===roomSubTab);
    });
    $('roomPanel-rounds').style.display = roomSubTab==='rounds' ? '' : 'none';
    $('roomPanel-updates').style.display = roomSubTab==='updates' ? '' : 'none';
    $('roomPanel-bolus').style.display = roomSubTab==='bolus' ? '' : 'none';
  }
  function switchView(name){
    if(name==='admin' && !(window.doloraUser && window.doloraUser.role === 'admin')){
      // Defense in depth: the Admin drawer link is already hidden via CSS for
      // non-admins, but that alone doesn't stop this view from being reached
      // (console, stale DOM, etc). Bounce straight back to the dashboard
      // instead of rendering pending-user data and approve/reject controls.
      name = 'dashboard';
    }
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    const isRoomAlias = (name==='room-main' || name==='room-ranipet');
    const viewId = isRoomAlias ? 'room' : name;
    $('view-'+viewId).classList.add('active');
    const tabBtn = document.querySelector(`.tab[data-view="${name}"]`);
    if(tabBtn) tabBtn.classList.add('active'); // Dashboard/Admin live in the drawer, not the bottom bar
    // The campus pill only matters for Dashboard / Eagle — New Patient
    // has its own Campus field, and each Room (Main Campus / Ranipet) is already
    // scoped to one campus by definition.
    const hideCampusBarOn = ['add','room-main','room-ranipet','admin'];
    $('campusBar').style.display = hideCampusBarOn.includes(name) ? 'none' : 'flex';
    if(isRoomAlias){
      roomCampus = (name==='room-ranipet') ? 'Ranipet' : 'Main Campus';
      try{ localStorage.setItem('aps-room-campus', roomCampus); }catch(e){}
      $('roomTitle').textContent = roomCampus;
      document.body.classList.toggle('campus-ranipet', roomCampus==='Ranipet');
      applyRoomSubTabUI();
      renderRounds();
      renderBolus();
      if(roomSubTab==='updates'){
        loadTeamUpdates().then(renderTeamUpdates);
      }
    } else {
      document.body.classList.remove('campus-ranipet'); // any other tab (Eagle, Dashboard, Add) mixes/omits campuses — stay neutral
    }
    if(name==='eagle') renderEagle();
    if(name==='dashboard') renderDashboard();
    if(name==='insights') renderInsights();
    if(name==='admin') renderAdmin();
  }
  document.querySelectorAll('.tab').forEach(t=> t.addEventListener('click', ()=>switchView(t.getAttribute('data-view'))));

  // ---------- Admin View & Team Management ----------
  async function renderAdmin(){
    const pendingListEl = $('pendingList');
    const memberListEl = $('memberList');
    if(!pendingListEl || !memberListEl) return;

    pendingListEl.innerHTML = '<div class="loading">Loading requests…</div>';
    memberListEl.innerHTML = '<div class="loading">Loading team…</div>';

    let profiles = [];
    try {
      const sb = window.doloraSupabase;
      if(sb){
        const { data, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
        if(error) throw error;
        profiles = data || [];
      }
    } catch(err) {
      pendingListEl.innerHTML = `<div class="card"><div class="gate-error">Error loading profiles: ${escapeHtml(errMsg(err))}</div></div>`;
      memberListEl.innerHTML = '';
      return;
    }

    const pending = profiles.filter(p => p.role === 'pending');
    const members = profiles.filter(p => p.role === 'user' || p.role === 'admin');

    // Render Pending
    if(!pending.length){
      pendingListEl.innerHTML = '<div class="card"><div class="field-hint" style="text-align:center;padding:12px;">No pending registration requests.</div></div>';
    } else {
      pendingListEl.innerHTML = pending.map(p => `
        <div class="card" style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;">
          <div>
            <div style="font-weight:700;font-size:14px;color:var(--ink);">${escapeHtml(p.full_name || 'Unnamed')}</div>
            <div style="font-size:12px;color:var(--ink-soft);font-family:var(--mono);margin-top:2px;">${escapeHtml(p.email || p.id)}</div>
            <div style="font-size:11px;color:var(--ink-faint);margin-top:2px;">Requested: ${p.created_at ? new Date(p.created_at).toLocaleDateString() : 'Recent'}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn" style="padding:6px 12px;font-size:12px;margin:0;" data-approve-id="${p.id}" data-approve-role="user">Approve</button>
            <button class="btn secondary" style="padding:6px 10px;font-size:12px;margin:0;" data-approve-id="${p.id}" data-approve-role="admin">Make Admin</button>
            <button class="btn danger" style="padding:6px 10px;font-size:12px;margin:0;" data-reject-id="${p.id}">Reject</button>
          </div>
        </div>
      `).join('');
    }

    // Render Members
    if(!members.length){
      memberListEl.innerHTML = '<div class="card"><div class="field-hint" style="text-align:center;padding:12px;">No active team members found.</div></div>';
    } else {
      const currentUserId = window.doloraUser && window.doloraUser.id;
      memberListEl.innerHTML = members.map(m => {
        const isSelf = m.id === currentUserId;
        return `
          <div class="card" style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <div class="avatar mode-Epidural" style="width:30px;height:30px;font-size:11px;">${escapeHtml((m.full_name||'U').slice(0,2).toUpperCase())}</div>
              <div>
                <div style="font-weight:700;font-size:13.5px;color:var(--ink);">
                  ${escapeHtml(m.full_name || 'Unnamed')}
                  ${isSelf ? '<span class="campus-badge" style="margin-left:6px;background:var(--safe-bg);color:var(--safe);border-color:#B7DCE8;">YOU</span>' : ''}
                </div>
                <div style="font-size:11px;color:var(--ink-soft);font-family:var(--mono);">${escapeHtml(m.email || m.id)}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="campus-badge" style="${m.role==='admin' ? 'background:var(--dark);color:#fff;border-color:var(--dark);' : ''}">${m.role==='admin' ? 'Admin' : 'User'}</span>
              ${!isSelf ? `
                <select class="admin-role-select" data-member-id="${m.id}" style="width:auto;padding:3px 6px;font-size:11px;border-radius:6px;">
                  <option value="user" ${m.role==='user'?'selected':''}>User</option>
                  <option value="admin" ${m.role==='admin'?'selected':''}>Admin</option>
                </select>
                <button class="icon-action-btn danger" data-remove-id="${m.id}" title="Remove team member" style="width:28px;height:28px;font-size:11px;">✕</button>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    // Attach listeners
    pendingListEl.querySelectorAll('[data-approve-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.getAttribute('data-approve-id');
        const newRole = btn.getAttribute('data-approve-role');
        await updateProfileRole(uid, newRole, 'Account approved');
      });
    });

    pendingListEl.querySelectorAll('[data-reject-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.getAttribute('data-reject-id');
        const ok = await askConfirm({ title: 'Reject request', message: 'Reject this registration request?', confirmLabel: 'Reject', danger: true });
        if(!ok) return;
        await deleteOrRejectProfile(uid);
      });
    });

    memberListEl.querySelectorAll('.admin-role-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const uid = sel.getAttribute('data-member-id');
        const newRole = sel.value;
        await updateProfileRole(uid, newRole, 'Role updated to ' + newRole);
      });
    });

    memberListEl.querySelectorAll('[data-remove-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.getAttribute('data-remove-id');
        const ok = await askConfirm({ title: 'Remove member', message: 'Remove this clinician from the team? They will no longer be able to view or edit patient records.', confirmLabel: 'Remove', danger: true });
        if(!ok) return;
        await deleteOrRejectProfile(uid);
      });
    });

    // Wire up Monthly Duty Team Roster in Admin
    if($('adminRosterMonth')){
      if(!$('adminRosterMonth').value){
        $('adminRosterMonth').value = (eagleMonth !== 'all') ? eagleMonth : todayStr().slice(0,7);
      }
      const curYm = $('adminRosterMonth').value;
      loadMonthlyRoster(curYm).then(cur => {
        if($('adminRosterMainText')) $('adminRosterMainText').value = (cur && cur.mainTeam) ? cur.mainTeam : ((cur && cur.team) ? cur.team : '');
        if($('adminRosterRanipetText')) $('adminRosterRanipetText').value = (cur && cur.ranipetTeam) ? cur.ranipetTeam : '';
      });

      $('adminLoadRosterBtn').onclick = async () => {
        const selYm = $('adminRosterMonth').value;
        if(!selYm){ toast('Select a month first'); return; }
        const r = await loadMonthlyRoster(selYm);
        if($('adminRosterMainText')) $('adminRosterMainText').value = (r && r.mainTeam) ? r.mainTeam : ((r && r.team) ? r.team : '');
        if($('adminRosterRanipetText')) $('adminRosterRanipetText').value = (r && r.ranipetTeam) ? r.ranipetTeam : '';
        toast('Loaded duty roster for ' + fmtMonthYear(selYm));
      };

      $('adminSaveRosterBtn').onclick = async () => {
        const selYm = $('adminRosterMonth').value;
        if(!selYm){ toast('Select a month first'); return; }
        const mainText = ($('adminRosterMainText') ? $('adminRosterMainText').value : '').trim();
        const ranipetText = ($('adminRosterRanipetText') ? $('adminRosterRanipetText').value : '').trim();
        await saveMonthlyRoster(selYm, {
          mainTeam: mainText,
          ranipetTeam: ranipetText,
          team: [mainText, ranipetText].filter(Boolean).join(', ')
        });
        toast('Saved duty team for ' + fmtMonthYear(selYm));
        if(eagleMonth === selYm && document.getElementById('view-eagle').classList.contains('active')){
          renderEagle();
        }
      };
    }
  }

  async function updateProfileRole(uid, role, msg){
    try{
      const sb = window.doloraSupabase;
      if(sb){
        const { error } = await sb.from('profiles').update({ role }).eq('id', uid);
        if(error) throw error;
      }
      toast(msg);
      renderAdmin();
    }catch(err){
      toast('Failed to update: ' + errMsg(err), 4000);
    }
  }

  async function deleteOrRejectProfile(uid){
    try{
      const sb = window.doloraSupabase;
      if(sb){
        const { error } = await sb.from('profiles').delete().eq('id', uid);
        if(error) throw error;
      }
      toast('Account removed');
      renderAdmin();
    }catch(err){
      toast('Failed to remove: ' + errMsg(err), 4000);
    }
  }

  // ---------- hamburger drawer ----------
  function openDrawer(){ $('drawer').classList.add('open'); $('drawerBackdrop').classList.add('open'); }
  function closeDrawer(){ $('drawer').classList.remove('open'); $('drawerBackdrop').classList.remove('open'); }
  $('menuBtn').addEventListener('click', openDrawer);
  $('drawerBackdrop').addEventListener('click', closeDrawer);
  document.querySelectorAll('.drawer-link').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      switchView(btn.getAttribute('data-view'));
      closeDrawer();
    });
  });
  document.querySelectorAll('.room-subtab').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      roomSubTab = btn.getAttribute('data-roomtab');
      try{ localStorage.setItem('aps-room-subtab', roomSubTab); }catch(e){}
      applyRoomSubTabUI();
      if(roomSubTab==='bolus'){
        renderBolus();
      }
      if(roomSubTab==='updates'){
        await loadTeamUpdates();
        renderTeamUpdates();
      }
    });
  });

  function refreshAutocompleteLists(){
    const doneBy = new Set(), dx = new Set(), surgery = new Set();
    Object.values(patients).forEach(p=>{
      if(!p || p.status==='deleted') return;
      if(p.doneBy && p.doneBy.trim()) doneBy.add(p.doneBy.trim());
      if(p.dx && p.dx.trim()) dx.add(p.dx.trim());
      if(p.surgery && p.surgery.trim()) surgery.add(p.surgery.trim());
    });
    const fill = (id, set) => {
      const el = $(id);
      if(!el) return;
      el.innerHTML = Array.from(set).sort().map(v=>`<option value="${escapeHtml(v)}"></option>`).join('');
    };
    fill('doneby-suggestions', doneBy);
    fill('dx-suggestions', dx);
    fill('surgery-suggestions', surgery);
  }

  function renderAll(){
    renderDashboard();
    renderRounds();
    if(document.getElementById('view-eagle').classList.contains('active')) renderEagle();
    if(document.getElementById('view-room').classList.contains('active') && roomSubTab==='bolus') renderBolus();
    if(document.getElementById('view-insights').classList.contains('active')) renderInsights();
    refreshAutocompleteLists();
  }

  function tickClock(){
    const dateEl = $('topbarDate');
    if(dateEl){
      const tStr = todayStr(); // YYYY-MM-DD
      const parts = (tStr || '').split('-');
      if(parts.length === 3){
        dateEl.textContent = `${parts[2]}-${parts[1]}-${parts[0].slice(-2)}`;
      }
    }
    const clockEl = $('clock');
    if(clockEl){
      try {
        clockEl.textContent = new Date().toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone: HOSPITAL_TZ});
      } catch(e) {
        clockEl.textContent = new Date().toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit', second:'2-digit'});
      }
    }
  }
  setInterval(tickClock,1000); tickClock();
  // Bolus due-times are relative to "now" — keep them honest without a manual refresh.
  setInterval(()=>{
    if(document.getElementById('view-room').classList.contains('active') && roomSubTab==='bolus') renderBolus();
  }, 60000);

  function syncLocHeader(){
    const isNBC = $('f-mode').value === 'NBC';
    const loc = $('f-location').value.trim();
    const header = $('f-loc-header');
    if(isNBC && loc){
      header.textContent = loc;
      header.style.display = '';
    } else {
      header.style.display = 'none';
    }
  }
  function syncLoc2Header(){
    const loc = $('f2-location').value.trim();
    const header = $('f2-loc-header');
    if(loc){
      header.textContent = loc;
      header.style.display = '';
    } else {
      header.style.display = 'none';
    }
  }
  $('f-location').addEventListener('input', syncLocHeader);
  $('f2-location').addEventListener('input', syncLoc2Header);
  $('f-mode').addEventListener('change', ()=>{
    updateModeBadge('f-mode','f-mode-badge');
    const isNBC = $('f-mode').value === 'NBC';
    $('nbcSecondCathWrap').style.display = isNBC ? '' : 'none';
    syncLocHeader();
    if(!isNBC){
      // Leaving NBC mode: collapse and clear the second-catheter section so a
      // stray value can't sneak onto a non-NBC patient.
      $('secondCathBlock').style.display = 'none';
      $('addSecondCathBtn').textContent = '+ Add second nerve block catheter';
      ['f2-location','f2-drug','f2-freq','f2-freqtype','f2-startedat'].forEach(id=>$(id).value='');
      syncLoc2Header();
    }
  });
  $('addSecondCathBtn').addEventListener('click', ()=>{
    const showing = $('secondCathBlock').style.display !== 'none';
    $('secondCathBlock').style.display = showing ? 'none' : '';
    $('addSecondCathBtn').textContent = showing ? '+ Add second nerve block catheter' : '− Remove second catheter';
    if(showing){
      ['f2-location','f2-drug','f2-freq','f2-freqtype','f2-startedat'].forEach(id=>$(id).value='');
      syncLoc2Header();
    }
  });
  $('postUpdateBtn').addEventListener('click', postTeamUpdate);
  $('updateText').addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); postTeamUpdate(); }
  });

  // ---------- Keeping shared data actually live ----------
  // loadAll() used to only ever run once, on page load — so a colleague's
  // new patient, bolus log, or chart edit on another device never appeared
  // here until you manually reloaded the whole page. This refreshes the
  // shared patient data on a timer and whenever the app comes back into
  // view, so the Dashboard/Rounds/Bolus/Eagle views stay current.
  // Never refresh while a patient's detail sheet is open — pulling fresh
  // data mid-edit would silently overwrite whatever the user is typing.
  function isSheetOpen(){ return $('sheet').classList.contains('open'); }
  let refreshingPatients = false; // avoid overlapping refreshes if one is slow
  async function refreshPatients(){
    if(isSheetOpen() || refreshingPatients) return;
    refreshingPatients = true;
    try{
      await loadAll();
      refreshWardOptions();
      renderAll();
    }finally{
      refreshingPatients = false;
    }
  }

  window.startDoloraApp = async function(){
    try{
      const savedCampus = localStorage.getItem('aps-current-campus');
      if(savedCampus){
        currentCampus = savedCampus;
        document.querySelectorAll('.campus-pill').forEach(el=>{
          el.classList.toggle('active', el.getAttribute('data-campus')===savedCampus);
        });
      }
    }catch(e){}
    $('recentBoard').innerHTML = '<div class="loading">Loading shared data…</div>';
    await loadAll();
    $('roomTitle').textContent = roomCampus;
    if(document.getElementById('view-room').classList.contains('active')){
      document.body.classList.toggle('campus-ranipet', roomCampus==='Ranipet');
    }
    applyRoomSubTabUI();
    await loadTeamUpdates();
    refreshWardOptions();
    if($('f-apsdate')) $('f-apsdate').value = todayStr();
    updateModeBadge('f-mode','f-mode-badge');
    renderAll();
    // Poll for teammates' new updates while that campus's Updates tab is open
    setInterval(async ()=>{
      const roomActive = document.getElementById('view-room').classList.contains('active');
      if(!roomActive || roomSubTab!=='updates') return;
      await loadTeamUpdates();
      renderTeamUpdates();
    }, 15000);
    // Poll for teammates' patient/bolus/chart changes everywhere else
    setInterval(refreshPatients, 20000);
    // Also refresh the moment the app is reopened/foregrounded (e.g. phone
    // was locked for 10 minutes) instead of waiting for the next tick —
    // this is when data is most likely to already be stale.
    document.addEventListener('visibilitychange', ()=>{
      if(document.visibilityState === 'visible') refreshPatients();
    });

    // Escape key closes open detail sheet, team modal, or confirm dialogs
    document.addEventListener('keydown', (e)=>{
      if(e.key === 'Escape'){
        if($('sheet') && $('sheet').classList.contains('open')){
          closeDetail();
        } else if($('teamModalBackdrop') && $('teamModalBackdrop').classList.contains('open')){
          closeTeamModal();
        } else if($('dcBackdrop') && $('dcBackdrop').classList.contains('open')){
          closeConfirmModal(false);
        } else if($('drawer') && $('drawer').classList.contains('open')){
          closeDrawer();
        }
      }
    });
  };
})();
