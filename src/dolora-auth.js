(function(){
  const sb = window.doloraSupabase;
  const $ = (id)=>document.getElementById(id);
  let mode = 'login'; // 'login' | 'signup'
  let appStarted = false;
  function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function clearGateNotices(){ $('authError').style.display='none'; $('authMsg').style.display='none'; }
  function showGateError(msg){ clearGateNotices(); const el=$('authError'); el.textContent=msg; el.style.display='block'; }
  function showGateMsg(msg){ clearGateNotices(); const el=$('authMsg'); el.textContent=msg; el.style.display='block'; }

  function setMode(next){
    mode = next;
    clearGateNotices();
    const isSignup = mode === 'signup';
    $('auth-name-label').style.display = isSignup ? 'block' : 'none';
    $('auth-name').style.display = isSignup ? '' : 'none';
    $('authSubmitBtn').textContent = isSignup ? 'Create account' : 'Log in';
    $('authToggleBtn').textContent = isSignup ? 'Already have an account? Log in' : 'New here? Create an account';
  }
  $('authToggleBtn').addEventListener('click', ()=> setMode(mode==='login' ? 'signup' : 'login'));

  function showAuthGate(){ $('authGate').style.display='flex'; $('pendingGate').style.display='none'; $('appRoot').style.display='none'; }
  function showPendingGate(){ $('authGate').style.display='none'; $('pendingGate').style.display='flex'; $('appRoot').style.display='none'; }
  function fmtActiveSince(iso){
    if(!iso) return '';
    return new Date(iso).toLocaleDateString(undefined,{month:'long', year:'numeric'});
  }
  function renderDrawerAccount(){
    const u = window.doloraUser;
    const el = $('drawerAccount');
    if(!u || !el) return;
    const roleLabel = u.role ? (u.role.charAt(0).toUpperCase()+u.role.slice(1)) : '';
    el.innerHTML = `
      <div class="acct-name">${escapeHtml(u.name||'—')}</div>
      <div class="acct-meta">${escapeHtml(roleLabel)}${roleLabel && u.since ? ' · ' : ''}${u.since ? 'Active since '+escapeHtml(fmtActiveSince(u.since)) : ''}</div>
    `;
  }

  function showApp(role){
    $('authGate').style.display='none';
    $('pendingGate').style.display='none';
    $('appRoot').style.display='';
    $('adminDrawerBtn').style.display = role==='admin' ? 'flex' : 'none';
    renderDrawerAccount();
    // startDoloraApp does its own initial data load + polling — only ever run it once per page load
    if(!appStarted){ appStarted = true; window.startDoloraApp(); }
  }

  async function fetchProfile(userId){
    const { data, error } = await sb.from('profiles').select('role, full_name').eq('id', userId).maybeSingle();
    if(error) throw error;
    return data;
  }

  async function routeForSession(session){
    if(!session){ showAuthGate(); return; }
    try{
      let profile = await fetchProfile(session.user.id);
      if(!profile){
        // Profile row might not have been created yet by the server-side
        // trigger. New accounts always start pending here — never
        // self-assigned admin. An admin (or the manually-seeded first
        // admin account) is the only thing that can promote a user,
        // from the Admin dashboard or directly in Supabase.
        try {
          const { data: created } = await sb.from('profiles').upsert({
            id: session.user.id,
            full_name: (session.user.user_metadata && session.user.user_metadata.full_name) || session.user.email,
            role: 'pending'
          }).select().maybeSingle();
          if(created) profile = created;
        } catch(e){}
      }

      if(!profile || profile.role === 'pending'){
        showPendingGate();
        return;
      }

      // Expose who's logged in to the rest of the app, so any part of it
      // can tag an action with "done by [them]" automatically — no typing,
      // no separate lookup. session.user.created_at comes straight from
      // Supabase Auth, so "active since" needs no extra tracking either.
      window.doloraUser = {
        id: session.user.id,
        name: profile.full_name || session.user.email,
        role: profile.role,
        since: session.user.created_at
      };
      showApp(profile.role);
    }catch(e){
      showGateError('Could not check your account status: '+(e.message||e));
      showAuthGate();
    }
  }

  $('authSubmitBtn').addEventListener('click', async ()=>{
    clearGateNotices();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    if(!email || !password){ showGateError('Enter your email and password.'); return; }
    if(!sb || !sb.auth){
      showGateError('Database is currently unreachable. Please check your network connection.');
      return;
    }
    $('authSubmitBtn').disabled = true;
    try{
      if(mode === 'login'){
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if(error) throw error;
        await routeForSession(data.session);
      } else {
        const fullName = $('auth-name').value.trim();
        if(!fullName){ showGateError('Enter your full name.'); return; }
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName }
          }
        });
        if(error) throw error;
        // The profiles row is created server-side by a trigger the moment
        // the account exists — this just fills in the name on top of it.
        try{ await sb.from('profiles').update({ full_name: fullName }).eq('id', data.user.id); }catch(e){}
        if(data.session){
          await routeForSession(data.session);
        } else {
          // No session back means email confirmation is required before login works
          showGateMsg('Account created — check your email to confirm it, then log in.');
          setMode('login');
        }
      }
    }catch(e){
      showGateError(e.message || 'Something went wrong — please try again.');
    }finally{
      $('authSubmitBtn').disabled = false;
    }
  });

  async function signOut(){
    window.doloraUser = null;
    try{ if(sb && sb.auth) await sb.auth.signOut(); }catch(e){}
    location.reload();
  }
  $('signOutBtn').addEventListener('click', signOut);
  $('pendingSignOutBtn').addEventListener('click', signOut);

  // Initial check whenever the page loads (covers an already-logged-in
  // returning visitor as well as a brand new one)
  (async ()=>{
    try {
      if(sb && sb.auth){
        const { data, error } = await sb.auth.getSession();
        if(error) throw error;
        await routeForSession(data ? data.session : null);
      } else {
        showAuthGate();
      }
    } catch(e) {
      console.warn('Initial session check error:', e);
      showAuthGate();
    }
  })();
})();
