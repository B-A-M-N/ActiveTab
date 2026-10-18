#!/usr/bin/env python3
"""Apply the reviewed local-only oracle patch to pinned WebArena-Infinity Gmail."""

from pathlib import Path
import subprocess


PINNED_COMMIT = "1ca77813bf8d8e4011aa3fb1f740f70d78bd522d"
SERVER_PATH = Path("server.py")


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"Expected one {label} anchor in pinned server.py; found {count}.")
    return source.replace(old, new, 1)


def main() -> int:
    if not SERVER_PATH.is_file():
        raise SystemExit("Run this script from apps/gmail in the pinned WebArena-Infinity checkout.")
    app_root = Path("../..").resolve()
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=app_root, text=True).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit("Pinned WebArena-Infinity git checkout is required; refusing to patch an unidentified copy.") from error
    if commit != PINNED_COMMIT:
        raise SystemExit(f"Expected WebArena-Infinity commit {PINNED_COMMIT}; found {commit}.")

    source = SERVER_PATH.read_text(encoding="utf-8")
    source = replace_once(source, "import http.server\nimport json\n", "import http.server\nimport hmac\nimport json\nimport os\n", "module imports")
    source = replace_once(
        source,
        "_state_lock = threading.Lock()\n",
        """_state_lock = threading.Lock()
_oracle_token = os.environ.get('ACTIVETAB_WEBARENA_ORACLE_TOKEN', '')
if len(_oracle_token) < 32 or len(_oracle_token) > 512:
    raise RuntimeError('ACTIVETAB_WEBARENA_ORACLE_TOKEN must contain 32 to 512 characters')
_max_oracle_seed_bytes = 16 * 1024


def _oracle_authorized(handler):
    supplied = handler.headers.get('X-ActiveTab-Fixture-Oracle', '')
    return hmac.compare_digest(supplied, _oracle_token)
""",
        "oracle configuration",
    )
    source = replace_once(
        source,
        """    def do_POST(self):
        if self.path == '/api/reset':
            self._handle_reset()
        else:
            self.send_error(404)
""",
        """    def do_POST(self):
        if self.path in ('/api/reset', '/api/oracle/seed') and not _oracle_authorized(self):
            self.send_error(403, 'Fixture oracle authorization required')
        elif self.path == '/api/reset':
            self._handle_reset()
        elif self.path == '/api/oracle/seed':
            self._handle_oracle_seed()
        else:
            self.send_error(404)
""",
        "POST authorization boundary",
    )
    source = replace_once(
        source,
        """    def do_GET(self):
        if self.path == '/api/state':
            self._handle_get_state()
        elif self.path == '/api/events':
""",
        """    def do_GET(self):
        if self.path == '/api/state' and not _oracle_authorized(self):
            self.send_error(403, 'Fixture oracle authorization required')
        elif self.path == '/api/state':
            self._handle_get_state()
        elif self.path == '/api/events':
""",
        "GET oracle authorization boundary",
    )
    source = replace_once(
        source,
        """    # ---- State sync ----

    def _handle_put_state(self):
""",
        """    # ---- State sync ----

    def _handle_oracle_seed(self):
        global _app_state, _seed_state
        try:
            content_length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            self.send_error(400, 'Invalid content length')
            return
        if content_length < 1 or content_length > _max_oracle_seed_bytes:
            self.send_error(413, 'Oracle seed exceeds its size bound')
            return
        try:
            parsed = json.loads(self.rfile.read(content_length))
            emails = parsed.get('emails') if isinstance(parsed, dict) else None
            if not isinstance(emails, list) or not 1 <= len(emails) <= 20:
                raise ValueError('Expected between 1 and 20 fixture emails')
            for email in emails:
                sender = email.get('from') if isinstance(email, dict) else None
                if (not isinstance(email, dict) or set(email) != {'subject', 'from', 'isRead'}
                        or not isinstance(email.get('subject'), str) or not 1 <= len(email['subject']) <= 200
                        or not isinstance(sender, dict) or set(sender) != {'name'}
                        or not isinstance(sender['name'], str) or not 1 <= len(sender['name']) <= 120
                        or not isinstance(email.get('isRead'), bool)):
                    raise ValueError('Invalid bounded fixture email')
            state = {'emails': emails}
        except (json.JSONDecodeError, ValueError, TypeError, AttributeError):
            self.send_error(400, 'Invalid fixture seed')
            return
        with _state_lock:
            _app_state = json.loads(json.dumps(state))
            _seed_state = json.loads(json.dumps(state))
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"status":"ok","seed_created":true}')

    def _handle_put_state(self):
""",
        "bounded fixture seed handler",
    )
    source = replace_once(
        source,
        "ThreadedHTTPServer(('', port), AppHandler)",
        "ThreadedHTTPServer(('127.0.0.1', port), AppHandler)",
        "loopback server bind",
    )
    SERVER_PATH.write_text(source, encoding="utf-8")
    print("Applied the bounded oracle and loopback-bind patch to server.py.")
    print("Start this app with ACTIVETAB_WEBARENA_ORACLE_TOKEN set in its environment.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
