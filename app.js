const $ = id => document.getElementById(id);
let peer, dc, mic, run, recorders = [], allEvents = [], pending = [], flushing = false;
let audioJobs = [], closing = false, finishing = false, closed = false, failed = false, timeout, timer;
const transcripts = new Map();
function log(type, detail = {}) {
  const row = {type, browser_monotonic_ms: performance.now(), browser_time_origin_ms: performance.timeOrigin,
    wall_time: new Date().toISOString(), detail};
  allEvents.push(row); pending.push(row);
  $('log').textContent = allEvents.slice(-18).map(x => `${x.browser_monotonic_ms.toFixed(1)} ${x.type}`).join('\n');
}
async function post(path, data, binary = false) {
  const res = await fetch(path, {method:'POST', headers:{'Content-Type':binary?'application/octet-stream':'application/json'},
    body:binary?data:JSON.stringify(data)});
  const result = await res.json();
  if (!res.ok) throw Error(result.error || `HTTP ${res.status}`);
  return result;
}
async function flush() {
  if (flushing || !run || !pending.length) return;
  flushing = true; const batch = pending.splice(0);
  try { await post(`/api/run/${run}/events`, batch); }
  catch (err) { pending.unshift(...batch); failed = true; $('status').textContent = `Log save failed: ${err.message}. Use event backup.`; }
  finally { flushing = false; }
}
function record(stream, name) {
  const mime = ['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(x => MediaRecorder.isTypeSupported(x));
  if (!mime) throw Error('No supported audio recorder; use current Chrome.');
  const ext = mime.includes('webm')?'webm':mime.includes('ogg')?'ogg':'mp4';
  const rec = new MediaRecorder(stream, {mimeType:mime}); let sequence = 0, job = Promise.resolve();
  rec.addEventListener('dataavailable', e => {
    if (!e.data.size) return;
    const seq = sequence++;
    job = job.then(() => post(`/api/run/${run}/audio/${name}/${seq}/${ext}`,e.data,true));
    // Observe rejections immediately; retain the rejecting chain for final validation.
    job.catch(err => { failed = true; $('status').textContent = `Audio save failed: ${err.message}. Stop and inspect recordings.`; });
    audioJobs.push(job);
  });
  rec.addEventListener('error', () => { failed = true; log('recorder.error',{name}); });
  rec.start(1000); recorders.push(rec);
  log('recorder.started',{name,mime,settings:stream.getAudioTracks()[0].getSettings(),
    timing:'Independent recorder start; not a MEG/acoustic timestamp'});
}
function transcript(e) {
  if (!['session.input_transcript.delta','session.output_transcript.delta'].includes(e.type)) return;
  const speaker = e.type.includes('input_')?'Participant':'Chatbot';
  let p = transcripts.get(speaker);
  if (!p) { p = document.createElement('p'); transcripts.set(speaker,p); $('transcript').append(p); p.textContent = speaker+': '; }
  p.textContent += e.delta || '';
}
async function finish(reason) {
  if (finishing) return;
  finishing = true; clearTimeout(timeout); clearTimeout(timer);
  $('stop').disabled = true; $('marker').disabled = true;
  log('local.session.finished',{reason,final_usage_confirmed:closed});
  // Stop recorders before closing their source tracks, and wait for final data chunks.
  await Promise.all(recorders.map(rec => new Promise(resolve => {
    if (rec.state === 'inactive') return resolve();
    rec.addEventListener('stop',resolve,{once:true}); rec.stop();
  })));
  mic?.getTracks().forEach(t=>t.stop()); dc?.close(); peer?.close(); $('audio').srcObject=null;
  const saves = await Promise.allSettled(audioJobs);
  if (saves.some(x=>x.status==='rejected')) failed=true;
  while(flushing) await new Promise(r=>setTimeout(r,30));
  await flush();
  $('status').textContent = failed ? 'Stopped with save errors. Inspect recordings and download event backup.' :
    closed ? 'Stopped and saved. Final API close confirmed.' : 'Stopped and saved locally. Final API close NOT confirmed.';
  $('backup').disabled=false;
  // Reload is deliberate: avoids mixing runs and events after partially failed startup.
  $('start').textContent='Reload for next run'; $('start').disabled=false;
}
function stop() {
  if (closing || finishing) return;
  closing=true; $('stop').disabled=true; log('local.close.requested');
  if (dc?.readyState==='open') {
    dc.send(JSON.stringify({type:'session.close'}));
    $('status').textContent='Closing API session…';
    timeout=setTimeout(()=>finish('close_timeout'),10000);
  } else finish('no_open_event_channel');
}
async function start() {
  if (run) { location.reload(); return; }
  if (!$('consent').checked) { $('status').textContent='Check the recording box first.'; return; }
  $('start').disabled=true; $('status').textContent='Connecting…';
  try {
    if (!window.MediaRecorder) throw Error('Use a browser supporting MediaRecorder, such as current Chrome.');
    run=(await post('/api/run',{})).run;
    $('location').textContent=`Files: recordings/${run}/`; $('backup').disabled=false;
    log('local.run.created',{run});
    mic=await navigator.mediaDevices.getUserMedia({audio:true});
    record(mic,'participant');
    peer=new RTCPeerConnection();
    peer.addEventListener('track', e => {
      try {
        const stream=new MediaStream([e.track]); record(stream,'chatbot');
        $('audio').srcObject=stream;
        $('audio').play().catch(err=>{log('playback.blocked',{message:err.message}); $('status').textContent='Press Play on the audio controls.';});
      } catch(err) { failed=true; log('audio.error',{message:err.message}); stop(); }
    });
    for (const t of mic.getAudioTracks()) peer.addTrack(t,mic);
    peer.addEventListener('connectionstatechange',()=>{
      log('webrtc.state',{state:peer.connectionState});
      if(peer.connectionState==='failed') finish('connection_failed');
    });
    dc=peer.createDataChannel('oai-events');
    dc.addEventListener('message', ({data}) => {
      let e; try {e=JSON.parse(data);} catch {log('api.non_json',{data}); return;}
      log('api.event',e); transcript(e);
      if(e.type==='session.started') {
        $('status').textContent='Connected. Speak when ready.'; $('stop').disabled=false; $('marker').disabled=false;
        log('trigger.simulated',{code:1,meaning:'session.started event received; not acoustic onset',physical_ttl:false});
        timer=setTimeout(stop,600000);
      }
      if(e.type==='session.closed') {closed=true; finish('api_session_closed');}
      if(e.type==='error') $('status').textContent='API error: '+JSON.stringify(e.error || e);
    });
    dc.addEventListener('close',()=>{if(!closed&&!finishing) finish('event_channel_closed');});
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise((resolve,reject)=>{
      if(peer.iceGatheringState==='complete') return resolve();
      const deadline=setTimeout(()=>{peer.removeEventListener('icegatheringstatechange',check);reject(Error('ICE gathering timed out'));},10000);
      function check(){if(peer.iceGatheringState==='complete'){clearTimeout(deadline);peer.removeEventListener('icegatheringstatechange',check);resolve();}}
      peer.addEventListener('icegatheringstatechange',check); check();
    });
    log('api.session.requested');
    const result=await post(`/api/run/${run}/session`,{sdp:peer.localDescription.sdp});
    log('api.session.created',{id:result.session.id});
    await peer.setRemoteDescription({type:'answer',sdp:result.transport.sdp});
    $('stop').disabled=false;
    timeout=setTimeout(()=>{if(!timer){log('startup.timeout'); stop();}},20000);
  } catch(err) {failed=true; log('startup.error',{message:err.message}); await finish('startup_failed'); $('status').textContent=err.message;}
}
$('start').onclick=start; $('stop').onclick=stop;
$('marker').onclick=()=>log('trigger.simulated',{code:7,meaning:'manual test',physical_ttl:false});
$('backup').onclick=()=>{
  const a=document.createElement('a'),url=URL.createObjectURL(new Blob([allEvents.map(x=>JSON.stringify(x)).join('\n')],{type:'application/x-ndjson'}));
  a.href=url;a.download=`${run || 'pilot'}-events.jsonl`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
window.addEventListener('beforeunload',e=>{if(run&&!finishing){e.preventDefault();e.returnValue='Stop and save first.';}});
setInterval(flush,1000);
