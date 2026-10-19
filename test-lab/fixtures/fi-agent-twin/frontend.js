/** HTML rendering for the isolated FI Agent Twin application surfaces. */

export function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function htmlDocument(title, content, { script = "", style = "", bodyAttributes = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:900px;margin:3rem auto;padding:0 1.2rem;color:#172033}main{border:1px solid #ccd2dc;border-radius:12px;padding:1.5rem}form{display:grid;gap:1rem;max-width:640px}label{display:grid;gap:.4rem}input,textarea,select,button{font:inherit;padding:.65rem;border:1px solid #8b95a6;border-radius:6px}button{cursor:pointer;background:#172033;color:white}.secondary{background:white;color:#172033}.message{min-height:1.5rem}.row{display:flex;gap:.75rem;align-items:center}.modal{position:fixed;inset:10% 8%;overflow:auto;background:white;border:2px solid #172033;border-radius:12px;padding:1.5rem;box-shadow:0 0 0 100vmax #10182866}${style}</style></head><body ${bodyAttributes}>${content}<script>${script}</script></body></html>`;
}

export function renderPlatformLogin({ mfa = false } = {}) {
  if (mfa) return htmlDocument("FreeInference Fixture Login", `<main><h1>Verify sign in</h1><p>Enter the one-time code for the platform authentication realm.</p><form action="/auth/mfa" method="post"><label for="mfa-code">Verification code</label><input id="mfa-code" name="code" autocomplete="one-time-code"><button type="submit">Verify</button></form></main>`);
  return htmlDocument("FreeInference Fixture Login", `<main><h1>FreeInference Fixture</h1><p>Sign in to the platform dashboard.</p><form action="/auth/login" method="post"><label for="platform-user">Email</label><input id="platform-user" name="username" autocomplete="username"><label for="platform-password">Password</label><input id="platform-password" name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form></main>`);
}

export function renderDashboard(agentsOrigin) {
  return htmlDocument("FreeInference Dashboard", `<main><h1>Dashboard</h1><p>Signed in to the platform account.</p><nav><a href="${escapeHtml(agentsOrigin)}/gateway">Agents</a></nav><section><h2>Available models</h2><ul><li>Fixture GLM 5</li><li>Fixture GLM 4.5</li></ul></section></main>`);
}

export function renderAgentGateway() {
  return htmlDocument("Agents", `<main><h1>Agents</h1><p>Open the Cloud Agent application.</p><a href="/login">Continue to Cloud Agents</a></main>`);
}

export function renderAgentLogin({ mfa = false } = {}) {
  if (mfa) return htmlDocument("Cloud Agent Verification", `<main><h1>Verify Cloud Agent sign in</h1><p>This application uses a separate authentication realm.</p><form action="/auth/mfa" method="post"><label for="agent-mfa">Verification code</label><input id="agent-mfa" name="code" autocomplete="one-time-code"><button type="submit">Verify</button></form></main>`);
  return htmlDocument("Cloud Agent Sign In", `<main><h1>Cloud Agent</h1><p>Sign in to the Cloud Agent application.</p><form action="/auth/login" method="post"><label for="agent-user">Email</label><input id="agent-user" name="username" autocomplete="username"><label for="agent-password">Password</label><input id="agent-password" name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form></main>`);
}

function selectorMarkup(variant) {
  if (variant === "native_select") {
    return `<label for="model-select">Model</label><select id="model-select" name="modelRef"><option value="">Choose a model</option><option value="fixture-model-x">Fixture GLM 5</option><option value="fixture-model-y">Fixture GLM 4.5</option></select>`;
  }
  return `<label id="model-label" for="model-trigger">Execution model</label><button id="model-trigger" class="secondary" role="combobox" aria-labelledby="model-label" aria-haspopup="listbox" aria-expanded="false" type="button">Choose a model</button><div id="model-options" role="listbox" aria-label="Execution model" hidden><button type="button" role="option" data-model="fixture-model-x" aria-selected="false">Fixture GLM 5</button><button type="button" role="option" data-model="fixture-model-y" aria-selected="false">Fixture GLM 4.5</button></div><input id="model-value" name="modelRef" type="hidden">`;
}

function renderComposer(variant, modality, resumeRunId = "") {
  const promptFirst = variant.controlOrder === "prompt_first";
  const model = selectorMarkup(variant.modelSelector);
  const prompt = `<label for="task-prompt">${variant.modelSelector === "native_select" ? "Task prompt" : "Instructions"}</label><textarea id="task-prompt" name="prompt" rows="6" maxlength="4000"></textarea>`;
  const submit = `<input type="hidden" id="task-ref" value="fixture-task-17"><input type="hidden" id="resume-run-id" value="${escapeHtml(resumeRunId)}"><div class="row"><button id="submit-task" type="submit">Run</button><span class="message" id="task-status" role="status" aria-live="polite"></span></div>`;
  const fields = promptFirst ? `${prompt}${model}` : `${model}${prompt}`;
  return `<h1>Cloud Agent</h1><p>Start a task using an available model.</p>${modality === "modal" ? `<button id="new-task" type="button">New agent task</button><section id="composer" class="modal" role="dialog" aria-modal="true" aria-labelledby="composer-title"><h2 id="composer-title">New execution</h2><form id="task-form">${fields}${submit}</form></section>` : `<form id="task-form">${fields}${submit}</form>`}<section id="run-result" aria-live="polite"></section><nav><a href="/history">History</a> · <a href="/admin">Admin Console</a></nav>`;
}

export function renderApp(variant, resumeRunId = "") {
  const js = `
    const trigger=document.getElementById('model-trigger');
    const options=document.getElementById('model-options');
    const modelInput=document.getElementById('model-value');
    if(trigger){trigger.addEventListener('click',()=>{options.hidden=!options.hidden;trigger.setAttribute('aria-expanded',String(!options.hidden));});options.addEventListener('click',event=>{const option=event.target.closest('[data-model]');if(!option)return;modelInput.value=option.dataset.model;trigger.textContent=option.textContent;for(const row of options.querySelectorAll('[role=option]'))row.setAttribute('aria-selected',String(row===option));options.hidden=true;trigger.setAttribute('aria-expanded','false');});}
    const newTask=document.getElementById('new-task');if(newTask){newTask.addEventListener('click',()=>document.getElementById('composer').hidden=false);}
    const form=document.getElementById('task-form');
    const status=document.getElementById('task-status');
    const result=document.getElementById('run-result');
    let lastOperationKey=localStorage.getItem('fixture-operation-key');
    if(!lastOperationKey){lastOperationKey=crypto.randomUUID();localStorage.setItem('fixture-operation-key',lastOperationKey);}
    form?.addEventListener('submit',async event=>{event.preventDefault();status.textContent='Submitting task…';const data=new FormData(form);const modelRef=String(data.get('modelRef')||'');const prompt=String(data.get('prompt')||'');try{const response=await fetch('/api/runs',{method:'POST',headers:{'content-type':'application/json','idempotency-key':lastOperationKey},body:JSON.stringify({modelRef,prompt,promptRef:document.getElementById('task-ref').value})});if(!response.ok)throw new Error('Task submission did not return a successful response.');const payload=await response.json();status.textContent='Run '+payload.runId+' created';result.dataset.runId=payload.runId;result.innerHTML='<h2>Run <code>'+payload.runId+'</code></h2><p id="run-state">Status: queued</p>';localStorage.setItem('fixture-last-run',payload.runId);poll(payload.runId);}catch(error){status.textContent='Submission outcome unknown; check task history before retrying.';}});
    async function poll(id){for(let attempt=0;attempt<12;attempt++){await new Promise(resolve=>setTimeout(resolve,80));try{const response=await fetch('/api/runs/'+encodeURIComponent(id));if(!response.ok)continue;const run=await response.json();const state=document.getElementById('run-state');if(state)state.textContent='Status: '+run.status;if(['succeeded','failed'].includes(run.status))return;}catch{}}}
    const previous=${JSON.stringify(resumeRunId)};if(previous){result.dataset.runId=previous;}
    if(${JSON.stringify(variant.navigation)}==='spa'){document.body.dataset.navigation='spa';}
  `;
  return htmlDocument("Cloud Agent", `<main>${renderComposer(variant, variant.composer, resumeRunId)}</main>`, { script: js });
}
