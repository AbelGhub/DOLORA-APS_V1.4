// ---------- Live storage shim ----------
// Replaces the Claude-artifact-only window.storage with a real backend:
// shared=true data lives in Supabase (visible to the whole team),
// shared=false ("personal") data lives in this browser's localStorage.
// Every call site elsewhere in this file (window.storage.get/set/...) is unchanged.
(function(){
  const SUPABASE_URL = 'https://aqpqdqkumfzdljkssoip.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxcHFkcWt1bWZ6ZGxqa3Nzb2lwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MzI0NDksImV4cCI6MjEwNDIwODQ0OX0.td060zBdZzIcwb6e8XP4BYwF2WZpIInVZX1rjP_l03c';
  let sb = null;
  try {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
  } catch(e) {
    console.warn('Supabase initialization failed:', e);
  }
  window.doloraSupabase = sb; // shared client — the auth-gate script below reuses this instead of creating a second one
  const LOCAL_PREFIX = 'aps-local:';

  // "Key not found" needs to be reliably distinguishable from a generic
  // network/DB error — callers use this to tell "this record was deleted"
  // apart from "we couldn't reach the server right now", and must NOT treat
  // those the same way (a deleted record should never be silently recreated
  // just because a lookup failed to find it).
  function notFoundError(key){
    const e = new Error('key not found: '+key);
    e.doloraNotFound = true;
    return e;
  }

  // In-memory fallback for shared storage in the rare case Supabase is temporarily unreachable
  const memStore = {};

  window.storage = {
    async get(key, shared){
      if(!shared){
        const v = localStorage.getItem(LOCAL_PREFIX+key);
        if(v===null) throw notFoundError(key);
        return {key, value:v, shared:false};
      }
      if(!sb){
        const rec = memStore[key];
        if(!rec) throw notFoundError(key);
        return {key, value:rec.value, shared:true, updated_at:rec.updated_at};
      }
      try {
        const {data, error} = await sb.from('kv_store').select('value, updated_at').eq('key', key).maybeSingle();
        if(error) throw error; // genuine network/DB error — NOT a "not found", never gets the doloraNotFound flag
        if(!data) throw notFoundError(key);
        return {key, value:data.value, shared:true, updated_at:data.updated_at};
      } catch(err) {
        if(err && err.doloraNotFound) throw err;
        if(memStore[key]) {
          const rec = memStore[key];
          return {key, value:rec.value, shared:true, updated_at:rec.updated_at};
        }
        throw err;
      }
    },
    async set(key, value, shared){
      if(!shared){
        localStorage.setItem(LOCAL_PREFIX+key, value);
        return {key, value, shared:false};
      }
      const updated_at = new Date().toISOString();
      if(!sb){
        memStore[key] = {value, updated_at};
        return {key, value, shared:true, updated_at};
      }
      try {
        const {error} = await sb.from('kv_store').upsert({key, value, updated_at});
        if(error) throw error;
        // Only cache locally once we know Supabase actually has it — this
        // mirror is a read-through convenience, never a substitute for the
        // real write.
        memStore[key] = {value, updated_at};
        return {key, value, shared:true, updated_at};
      } catch(err) {
        // IMPORTANT: do NOT fall back to memStore here. A write that only
        // lives in this tab's memory looks identical to a real save (same
        // return shape) but disappears the moment loadAll() next refreshes
        // from Supabase — which is exactly the "patient auto-deletes after
        // saving" bug. A failed shared write must surface as a real error
        // so the caller (savePatient) can tell the user it didn't save,
        // instead of showing a success toast for data that isn't there.
        console.error('Supabase set FAILED — record was NOT saved:', err);
        throw err;
      }
    },
    async delete(key, shared){
      if(!shared){
        localStorage.removeItem(LOCAL_PREFIX+key);
        return {key, deleted:true, shared:false};
      }
      if(!sb){
        delete memStore[key];
        return {key, deleted:true, shared:true};
      }
      try {
        const {error} = await sb.from('kv_store').delete().eq('key', key);
        if(error) throw error;
        return {key, deleted:true, shared:true};
      } catch(err) {
        delete memStore[key];
        return {key, deleted:true, shared:true};
      }
    },
    async list(prefix, shared){
      if(!shared){
        const keys = Object.keys(localStorage)
          .filter(k=>k.startsWith(LOCAL_PREFIX+(prefix||'')))
          .map(k=>k.slice(LOCAL_PREFIX.length));
        return {keys, prefix, shared:false};
      }
      if(!sb){
        const keys = Object.keys(memStore).filter(k=>!prefix || k.startsWith(prefix));
        return {keys, prefix, shared:true};
      }
      try {
        let q = sb.from('kv_store').select('key');
        if(prefix) q = q.like('key', prefix+'%');
        const {data, error} = await q;
        if(error) throw error;
        return {keys:(data||[]).map(r=>r.key), prefix, shared:true};
      } catch(err) {
        const keys = Object.keys(memStore).filter(k=>!prefix || k.startsWith(prefix));
        return {keys, prefix, shared:true};
      }
    },
    // Bulk read: all keys+values under a prefix in a single round-trip,
    // instead of list() followed by one get() per key. Matters once the
    // patient census grows into the hundreds — avoids N+1 Supabase requests
    // on every load. Same key/value shape callers already get from get(),
    // just returned as an array under "items".
    async getAllByPrefix(prefix, shared){
      if(!shared){
        const full = LOCAL_PREFIX+(prefix||'');
        const items = Object.keys(localStorage)
          .filter(k=>k.startsWith(full))
          .map(k=>({key:k.slice(LOCAL_PREFIX.length), value:localStorage.getItem(k)}));
        return {items, prefix, shared:false};
      }
      if(!sb){
        const items = Object.keys(memStore)
          .filter(k=>!prefix || k.startsWith(prefix))
          .map(k=>({key:k, value:memStore[k].value, updated_at:memStore[k].updated_at}));
        return {items, prefix, shared:true};
      }
      try {
        let q = sb.from('kv_store').select('key, value, updated_at');
        if(prefix) q = q.like('key', prefix+'%');
        const {data, error} = await q;
        if(error) throw error;
        const items = (data||[]).map(r=>({key:r.key, value:r.value, updated_at:r.updated_at}));
        return {items, prefix, shared:true};
      } catch(err) {
        const items = Object.keys(memStore)
          .filter(k=>!prefix || k.startsWith(prefix))
          .map(k=>({key:k, value:memStore[k].value, updated_at:memStore[k].updated_at}));
        return {items, prefix, shared:true};
      }
    }
  };
})();
