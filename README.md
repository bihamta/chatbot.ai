# MEG voice pilot — local prototype

This is a local Python server and browser client built around your exported
GPT-Live configuration: `gpt-live-1`, Gleam, `gpt-6-luna`, medium reasoning,
and web search. Web search remains enabled exactly as in your export and may
add cost and alter conversation behavior. Edit `session.json` to change it.

## Run

1. Install Python 3.10 or newer if necessary. No Python packages are required.
2. Unzip this folder somewhere private on the computer where you will test.
3. Open Terminal (macOS/Linux) or PowerShell (Windows) inside this folder.
4. On macOS/Linux run `python3 server.py`; on Windows run `py server.py`.
5. Paste your project API key at the hidden prompt and press Enter. The key is
   held in server memory, not saved to the project. If OPENAI_API_KEY is already
   set, the server uses it instead. Do not paste the key into chat or commit it.
6. Open **http://localhost:3000** in current Chrome. Use that exact hostname.
7. Wear headphones, check the recording box, and click Start conversation.
   Allow the browser microphone permission. Use browser/system settings to select
   the microphone. If automatic playback is blocked, press Play in the audio controls.
8. Speak, interrupt, and test a short conversation. Click Simulate marker 7.
9. Click **Stop & save**. Wait for confirmation before closing the tab.
   The application requests API session closure and waits up to 10 seconds.
   It also requests closure after 10 minutes from `session.started` receipt.
10. Inspect `recordings/<random-run-id>/` and listen to both audio files.
    Reload the page for each new test. Ctrl+C stops the Python server after
    you have stopped and saved the conversation.

For a desktop test this needs only your computer, microphone, headphones,
internet, and an API key with GPT-Live access/billing. It is **local, not offline**:
audio is transmitted to OpenAI, and hosted web search is enabled. Do not deploy
this server on the public internet. Its endpoints are bound to loopback and
restricted to the local page, not a production authentication system.

## What gets saved

- `configuration.json`: the exact API configuration used for this run.
- `session.json`: the remote session ID, if creation succeeded.
- `participant.webm` / `.ogg` / `.mp4`: browser microphone audio, uploaded in order
  in roughly one-second chunks, using the first supported format.
- `chatbot.webm` / `.ogg` / `.mp4`: received WebRTC audio, uploaded independently.
- `events.jsonl`: original API events, transcript fragments when emitted, local
  events, and simulated marker requests. Original API payloads may contain
  conversation content. The interface offers a browser-side event backup too.
- `timing-notes.txt`: the limits on interpretation of these recordings.

The browser microphone may apply echo cancellation, automatic gain control,
and other processing. Track settings are logged. The two MediaRecorder tracks
begin independently, may use lossy codecs and include encoder delays. Their
recording-start events are approximate software observations. They are useful
for testing and reviewing conversation, **not sample-accurate MEG alignment**.
The received chatbot track does not establish actual acoustic playback or what
reached the participant's ears, especially after playback blocking/interruption.
Browser performance.now, API session times, and server monotonic times are
different clock domains: no cross-clock mapping is calibrated in this version.

Recordings are chunked to disk while running, but a crash may lose buffered
audio or logs. A missing chatbot file indicates no remote audio track was
received. Any save error must be resolved before research collection. There is
no automatic API retry or reconnection: partial sessions stay separate.

## Next: physical MEG integration

**There is no hardware TTL output in this prototype.** Marker 7 and the start
marker only write `trigger.simulated` log entries with `physical_ttl:false`.
No automatic speech onset/offset detector is implemented yet. Transcript events
are preserved but are not treated as reliable speech boundaries.

Before adding hardware, identify the lab's MEG acquisition system, the trigger
interface and minimum pulse width, the stimulus computer OS, and whether the
existing MATLAB driver works there. Do not copy address DFB8 to another machine
without checking it. A local process on the trigger computer must operate that
interface; neither this browser nor a hosted website can directly call MATLAB outp.

For final measurement, record suitable microphone and delivered-audio reference
signals on a calibrated acquisition path synchronized with MEG (e.g. supported
auxiliary channels or repeated shared synchronization pulses). Validate offset,
jitter, drift, and acoustic tubing delays with the lab engineer. Derive speaking,
listening, overlap and silence boundaries offline from that reference audio;
optionally add a measured-latency online detector for provisional markers.
Use the lab's approved audio hardware and participant data procedures.

## Hosting

Start locally. A custom domain such as thebit.me could later host a frontend,
but would require a secure backend, authentication, managed secrets, appropriate
audio storage, and an explicit bridge to local MEG hardware. A static upload
of this folder is not sufficient. Localhost avoids that extra infrastructure.

## Validation status

Python compilation, JavaScript syntax, and a local server test with a mocked API
passed. The server test covered configuration/session exchange, event saving,
ordered audio chunk storage, rejection of out-of-order chunks and foreign
origins, and duplicate session-creation prevention. Browser end-to-end testing
could not run in the build environment because Chromium could not launch under
its restrictions. No real paid API session or physical MEG/TTL hardware was
tested. You must verify the browser recording flow and live API behavior on your
account. If startup fails, the page displays the API error; keep the event backup
and inspect the terminal as needed.

Official connection reference:
https://developers.openai.com/api/docs/guides/voice-webrtc

Official event/session reference:
https://developers.openai.com/api/docs/guides/live-conversations
