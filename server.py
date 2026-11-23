"""Local-only GPT-Live prototype. Python 3.10+, no third-party dependencies."""
import json
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
ORIGIN = 'http://localhost:3000'
RUNS = ROOT / 'recordings'
LOCK = threading.Lock()
STATE = {}


def create_session(sdp, config):
    key = os.environ.get('OPENAI_API_KEY')
    if not key:
        raise ValueError('Set OPENAI_API_KEY in the terminal running server.py.')
    req = Request('https://api.openai.com/v1/live/sessions',
                  data=json.dumps({'session': config,
                                   'transport': {'type': 'webrtc', 'sdp': sdp}}).encode(),
                  headers={'Authorization': f'Bearer {key}',
                           'Content-Type': 'application/json'}, method='POST')
    with urlopen(req, timeout=40) as response:
        result = json.load(response)
    # Return only the fields needed by the browser, never arbitrary credentials.
    return {'session': {'id': result['session']['id']},
            'transport': {'sdp': result['transport']['sdp']}}


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, value, mime='application/json'):
        body = json.dumps(value).encode() if mime == 'application/json' else value
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/':
            return self.reply(200, (ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8')
        if self.path == '/app.js':
            return self.reply(200, (ROOT / 'app.js').read_bytes(), 'text/javascript; charset=utf-8')
        self.reply(404, {'error': 'Not found'})

    def do_POST(self):
        # Do not expose this local API to other sites or a network interface.
        if self.headers.get('Host') != 'localhost:3000' or self.headers.get('Origin') != ORIGIN:
            return self.reply(403, {'error': 'Open http://localhost:3000 directly.'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32 * 1024 * 1024:
                return self.reply(413, {'error': 'Invalid or oversized request'})
            raw = self.rfile.read(size)
            if self.path == '/api/run':
                run = uuid.uuid4().hex
                config = json.loads((ROOT / 'session.json').read_text())
                folder = RUNS / run
                folder.mkdir(parents=True)
                (folder / 'configuration.json').write_text(json.dumps(config, indent=2))
                (folder / 'timing-notes.txt').write_text(
                    'PROTOTYPE: no physical TTL output. Browser and server clocks are separate.\n'
                    'MediaRecorder tracks start independently and are compressed.\n'
                    'API and browser timestamps are NOT calibrated MEG or acoustic timestamps.\n'
                    'Chatbot track is received WebRTC audio, not a measurement at the ear.\n')
                with LOCK:
                    STATE[run] = {'config': config, 'next': {}, 'created': False}
                return self.reply(200, {'run': run})
            parts = self.path.split('/')
            if len(parts) < 4 or parts[1:3] != ['api', 'run'] or not re.fullmatch(r'[0-9a-f]{32}', parts[3]):
                return self.reply(404, {'error': 'Unknown route'})
            run = parts[3]
            if run not in STATE:
                return self.reply(404, {'error': 'Unknown run; reload the page'})
            folder = RUNS / run
            action = parts[4] if len(parts) > 4 else ''
            if action == 'session':
                data = json.loads(raw)
                sdp = data.get('sdp')
                if not isinstance(sdp, str) or not sdp.startswith('v=0') or len(sdp) > 65536:
                    raise ValueError('A valid SDP offer is required')
                with LOCK:
                    if STATE[run]['created']:
                        raise ValueError('Session creation already attempted; start a new run')
                    STATE[run]['created'] = True
                result = create_session(sdp, STATE[run]['config'])
                (folder / 'session.json').write_text(json.dumps({'id': result['session']['id']}))
                return self.reply(200, result)
            if action == 'events':
                rows = json.loads(raw)
                if not isinstance(rows, list) or len(rows) > 5000:
                    raise ValueError('Invalid event batch')
                with LOCK, (folder / 'events.jsonl').open('a') as file:
                    for row in rows:
                        file.write(json.dumps({'server_received_monotonic_ns': time.monotonic_ns(),
                                               'browser': row}) + '\n')
                return self.reply(200, {'saved': len(rows)})
            if action == 'audio' and len(parts) == 8:
                name, seq, ext = parts[5:]
                if name not in ('participant', 'chatbot') or ext not in ('webm', 'ogg', 'mp4'):
                    raise ValueError('Invalid audio track')
                seq = int(seq)
                with LOCK:
                    expected = STATE[run]['next'].get(name, 0)
                    if seq != expected:
                        return self.reply(409, {'error': f'Expected chunk {expected}, got {seq}'})
                    with (folder / f'{name}.{ext}').open('ab') as file:
                        file.write(raw)
                    STATE[run]['next'][name] = seq + 1
                return self.reply(200, {'saved_chunk': seq})
            self.reply(404, {'error': 'Not found'})
        except HTTPError as exc:
            # Error text is returned to this local page, not terminal logs.
            self.reply(502, {'error': f'OpenAI HTTP {exc.code}: ' + exc.read(8000).decode(errors='replace')})
        except (ValueError, KeyError, json.JSONDecodeError) as exc:
            self.reply(400, {'error': str(exc)})
        except (URLError, TimeoutError, OSError) as exc:
            self.reply(502, {'error': str(exc)})


if __name__ == '__main__':
    if not os.environ.get('OPENAI_API_KEY'):
        from getpass import getpass
        os.environ['OPENAI_API_KEY'] = getpass('OpenAI API key (hidden; kept in memory): ').strip()
    print('Open http://localhost:3000 — Ctrl+C stops the server.')
    print('Prototype only: triggers are simulated; MEG timing is not calibrated.')
    ThreadingHTTPServer(('127.0.0.1', 3000), Handler).serve_forever()
