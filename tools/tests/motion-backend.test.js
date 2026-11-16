const fs = require('fs'), vm = require('vm'), path = require('path');
const root = process.argv[2];
const store = {};
const ctx = {
  console, URLSearchParams, URL, setTimeout, clearTimeout, Promise, JSON, Date, Math, Number, String, Object, Array, Set, Map, Error,
  crypto: require('crypto').webcrypto,
  chrome: {
    storage: { local: {
      get: async (keys) => { const o = {}; for (const k of [].concat(keys)) if (k in store) o[k] = JSON.parse(JSON.stringify(store[k])); return o; },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store[k] = JSON.parse(JSON.stringify(v)); },
    } },
    runtime: { getURL: (p) => 'file://' + path.join(root, p) },
  },
  fetch: async (u) => { const p = u.replace('file://', ''); try { const t = fs.readFileSync(p, 'utf8'); return { ok: true, json: async () => JSON.parse(t) }; } catch { return { ok: false, json: async () => ({}) }; } },
};
ctx.self = ctx; ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['src/core/LocalMotionBackend.js', 'src/core/LocalBackend.js', 'src/motion/MotionRunJournal.js', 'src/motion/MotionBatchSnapshot.js'])
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
const api = async (method, endpoint, data) => {
  const r = await ctx.LocalBackend.dispatch({ method, endpoint, data });
  if (!r.success) { const e = new Error(r.error?.code); e.httpStatus = r.httpStatus; throw e; }
  return r.data;
};
let fails = 0; const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };
(async () => {
  const B = 'tools/motion-studio/projects';
  // legacy row (as produced by the old generic store)
  store.local566_db = { seq: 5, store: { [B]: [{ id: 1, tool_project_id: 'legacy-1', name: 'Old', flow_project_id: 'fp1', revision: 3, data_json: { frames: [], references: [], preferences: {} }, references: { mode: 'character_only', character: [{ fileId: 'abc' }], background: [] }, ratio: '9:16', created_at: '2026-01-01', updated_at: '2026-01-01' }] } };
  const legacy = await api('GET', `${B}/legacy-1`);
  check('legacy references migrated', legacy.data_json.references.character.length === 1 && !legacy.references);
  check('legacy prefs migrated', legacy.data_json.preferences.ratio === '9:16');
  check('legacy frames object', !Array.isArray(legacy.data_json.frames));

  check('quota', (await api('GET', `${B}/quota`)).limit === -1);
  check('bulk-item missing -> null', (await api('GET', `${B}/bulk-item?bulk_create_id=x&item_id=y`)) === null);
  let p = await api('POST', B, { name: 'Test', flow_project_id: 'fp1', bulk_create_id: 'b1', item_id: 'i1', voice_mode: 'lip_sync' });
  const ep = `${B}/${p.tool_project_id}`;
  check('bulk-item found', (await api('GET', `${B}/bulk-item?bulk_create_id=b1&item_id=i1`))?.tool_project_id === p.tool_project_id);
  p = await api('PATCH', ep, { revision: p.revision, voice_enabled: true, ratio: '16:9', flow_model: 'omni-1.2-flash', references: { mode: 'character_only', character: [] } });
  check('settings -> preferences', p.data_json.preferences.voice_enabled === true && p.data_json.preferences.flow_model === 'omni-1.2-flash');
  p = await api('PATCH', ep, { revision: p.revision, references: { mode: 'character_only', character: [{ fileId: 'f-1', file_name: 'a.png' }], background: [] } });
  check('references saved in data_json', p.data_json.references.character[0].fileId === 'f-1');
  p = await api('PATCH', ep, { revision: p.revision, flow_run_mode: 'web' });
  check('flow_run_mode', p.data_json.flow_run_mode === 'web');
  p = await api('PUT', `${ep}/source-draft`, { revision: p.revision, draft_id: 'd1', file_name: 'v.mp4', mime: 'video/mp4', size: 100, duration: null });
  check('source_draft', p.data_json.source_draft.draft_id === 'd1');
  p = await api('POST', `${ep}/split-attempt`, { revision: p.revision, operation_id: 'op1', draft_id: 'd1', state: 'running', include_audio: true, cut_strategy: 'duration' });
  check('split running', p.data_json.split_operation.state === 'running');
  p = await api('PUT', `${ep}/source`, { revision: p.revision, source_revision: 1, split_operation_id: 'op1', source: { artifact_id: 'source_1', file_name: 'v.mp4', mime: 'video/mp4', size: 100, duration: 16 }, frames: [ { frame_id: 'f0001', run_id: 'op1', input_revision: 1, start: 0, end: 8 }, { frame_id: 'f0002', run_id: 'op1', input_revision: 1, start: 8, end: 16 } ] });
  check('source committed', p.data_json.source_revision === 1 && Object.keys(p.data_json.frames).length === 2 && p.data_json.split_operation.operation_id === 'op1');
  for (const fid of ['f0001', 'f0002'])
    p = await api('PATCH', `${ep}/frames/${fid}/checkpoint`, { source_revision: 1, run_id: 'op1', input_revision: 1, stage: 'split', state: 'ready', artifact_id: `clip_1_${fid}`, audio_state: 'audio_present', audio_artifact_id: `audio_1_${fid}` });
  check('split ready + audio_state', p.data_json.frames.f0002.stages.split.state === 'ready' && p.data_json.frames.f0002.stages.split.audio_state === 'audio_present');
  p = await api('POST', `${ep}/split-attempt`, { revision: p.revision, operation_id: 'op1', draft_id: 'd1', state: 'complete' });
  check('split complete keeps op', p.data_json.split_operation.state === 'complete' && p.data_json.split_operation.include_audio === true);
  // concurrency: parallel checkpoints must not lose writes
  await Promise.all(['f0001', 'f0002'].map((fid) => api('PATCH', `${ep}/frames/${fid}/checkpoint`, { source_revision: 1, run_id: 'op1', input_revision: 1, stage: 'transcribe', state: 'running', worker: { project_run_id: 'run1' } })));
  p = await api('GET', ep);
  check('parallel checkpoints both saved', p.data_json.frames.f0001.stages.transcribe?.state === 'running' && p.data_json.frames.f0002.stages.transcribe?.state === 'running');
  p = await api('PATCH', `${ep}/frames/f0001/transcript`, { revision: p.revision, source_revision: 1, run_id: 'op1', input_revision: 1, has_speech: true, transcript: 'xin chào', translated_text: null, speech_timeline: null, detected_language: 'vi' });
  check('transcript saved + worker kept', p.data_json.frames.f0001.transcript.text === 'xin chào' && p.data_json.frames.f0001.stages.transcribe.state === 'ready' && p.data_json.frames.f0001.stages.transcribe.worker?.project_run_id === 'run1');
  let err = null; try { await api('PATCH', `${ep}/frames/f0001/checkpoint`, { source_revision: 1, run_id: 'WRONG', input_revision: 1, stage: 'submit', state: 'running' }); } catch (e) { err = e; }
  check('stale run rejected 409', err && err.httpStatus === 409);
  for (const fid of ['f0001', 'f0002']) {
    await api('PATCH', `${ep}/frames/${fid}/checkpoint`, { source_revision: 1, run_id: 'op1', input_revision: 1, stage: 'submit', state: 'running', profile_revision: 1 });
    await api('PATCH', `${ep}/frames/${fid}/checkpoint`, { source_revision: 1, run_id: 'op1', input_revision: 1, stage: 'submit', state: 'ready' });
    await api('PATCH', `${ep}/frames/${fid}/checkpoint`, { source_revision: 1, run_id: 'op1', input_revision: 1, stage: 'monitor', state: 'ready', persist_artifact_id: `gen_${fid}` });
    p = await api('PATCH', `${ep}/frames/${fid}/checkpoint`, { source_revision: 1, run_id: 'op1', input_revision: 1, stage: 'persist', state: 'ready', artifact_id: `gen_${fid}`, resolution: '720p' });
  }
  check('persist ready', p.data_json.frames.f0002.stages.persist.state === 'ready' && p.data_json.frames.f0002.stages.persist.resolution === '720p');
  const frameVersions = Object.fromEntries(Object.entries(p.data_json.frames).map(([id, f]) => [id, { run_id: f.run_id, input_revision: f.input_revision, artifact_id: f.stages.persist.artifact_id }]));
  p = await api('POST', `${ep}/generation-complete`, { revision: p.revision, source_revision: 1, frames: frameVersions, merge_error: null });
  check('client isGenerationComplete()', ctx.MotionRunJournal.isGenerationComplete(p.data_json) === true);
  p = await api('POST', `${ep}/finalize`, { revision: p.revision, source_revision: 1, artifact_revision: 1, artifact_id: 'merged_1_1', duration: 16, frame_ids: ['f0001', 'f0002'], use_original_audio: false });
  check('final saved', p.data_json.final.artifact_id === 'merged_1_1' && p.data_json.final.artifact_revision === 1);
  p = await api('POST', `${ep}/batch-enabled`, { enabled: true });
  const snap = await api('GET', `${B}/batch-snapshot?flow_project_id=fp1`);
  let classified = null; try { classified = await ctx.MotionBatchSnapshot.classify({ data: snap, userId: 1, flowProjectId: 'fp1', artifactStore: { get: async () => null } }); } catch (e) { classified = e.message; }
  check('client MotionBatchSnapshot.classify accepts snapshot', classified && Array.isArray(classified.entries));
  // frame rerun / recut / result edit
  const before = p.data_json.frames.f0002;
  p = await api('POST', `${ep}/frames/f0002/rerun`, { revision: p.revision, source_revision: 1 });
  check('frame rerun bumps run', p.data_json.frames.f0002.input_revision === 2 && p.data_json.frames.f0002.run_id !== before.run_id && p.data_json.frames.f0002.stages.split.state === 'ready' && !p.data_json.final);
  const f2 = p.data_json.frames.f0002;
  p = await api('POST', `${ep}/frames/f0002/result`, { revision: p.revision, source_revision: 1, run_id: f2.run_id, input_revision: f2.input_revision, mutation_id: 'm1', action: 'reset', preserve_result: true });
  const u = p.data_json.frames.f0002;
  check('result edit contract', u.result_edit.mutation_id === 'm1' && u.input_revision === f2.input_revision + 1 && u.run_id !== f2.run_id && u.result_edit.preserve_result === true && u.result_edit.run_id === f2.run_id);
  p = await api('POST', `${ep}/rerun`, { scope: 'transcript', revision: p.revision, source_revision: 1, rerun_id: 'r2', previous_project_run_id: 'run1', frame_ids: ['f0001'] });
  check('transcript rerun receipt', p.data_json.transcript_reset.rerun_id === 'r2' && !p.data_json.frames.f0001.stages.transcribe && JSON.stringify(p.data_json.transcript_reset.frame_ids) === '["f0001"]');
  p = await api('PATCH', ep, { revision: p.revision, pause: true });
  check('pause', p.data_json.paused === true);
  p = await api('PATCH', ep, { revision: p.revision, clear_frames: true });
  check('clear frames', Object.keys(p.data_json.frames).length === 0);
  p = await api('POST', `${ep}/reset`, { revision: p.revision, reset_id: 'reset1' });
  check('reset', p.data_json.reset_id === 'reset1' && !p.data_json.source);
  // provider-web reservation flow
  const res = await api('POST', 'execution/provider-web/reserve', { run_id: 'res1', source: 'motion', provider: 'gemini', media_type: 'text', prompt_count: 1, ref_count: 0 });
  check('reserve token', typeof res.execution_token === 'string' && res.token_status === 'active' && res.expires_in > 0 && res.motion_retry_limit === 2 && res.motion_retry_enabled === true);
  const intent = await api('POST', 'execution/provider-web/intent', { run_id: 'res1', token: res.execution_token, item_id: 'res1:0', attempt_id: 'a1', prompt_index: 0 });
  check('intent allowed', intent.status === 'dispatch_intent' && intent.dispatch_allowed === true);
  const comp = await api('POST', 'execution/complete', { token: res.execution_token, status: 'success' });
  check('complete', comp.status === 'success');
  const settle = await api('POST', 'execution/settlement', { token: res.execution_token });
  check('settlement receipt', settle.provider_web.run_id === 'res1' && settle.settlement.method === 'complete' && settle.settlement.status === 'success');
  // non-motion execution/complete untouched
  check('regular execution/complete still ok', (await ctx.LocalBackend.dispatch({ method: 'POST', endpoint: 'execution/complete', data: { execution_token: 'local-x' } })).success === true);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
