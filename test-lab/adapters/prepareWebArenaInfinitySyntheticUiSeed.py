#!/usr/bin/env python3
"""Bind the pinned Gmail UI to the fixture server's bounded synthetic inbox seed."""

from pathlib import Path
import subprocess


PINNED_COMMIT = "1ca77813bf8d8e4011aa3fb1f740f70d78bd522d"


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if new in source:
        return source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"Expected one {label} anchor; found {count}.")
    return source.replace(old, new, 1)


def main() -> int:
    server_path = Path("server.py")
    index_path = Path("index.html")
    state_path = Path("js/state.js")
    if not all(path.is_file() for path in (server_path, index_path, state_path)):
        raise SystemExit("Run from apps/gmail in the pinned WebArena-Infinity checkout.")
    app_root = Path("../..").resolve()
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=app_root, text=True).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit("Pinned WebArena-Infinity git checkout is required; refusing to patch an unidentified copy.") from error
    if commit != PINNED_COMMIT:
        raise SystemExit(f"Expected WebArena-Infinity commit {PINNED_COMMIT}; found {commit}.")

    server = server_path.read_text(encoding="utf-8")
    if "_oracle_authorized" not in server or "def _handle_oracle_seed" not in server:
        raise SystemExit("Apply prepareWebArenaInfinity.py first; the isolated oracle seed route is missing.")
    server = replace_once(
        server,
        "_max_oracle_seed_bytes = 16 * 1024\n",
        "_max_oracle_seed_bytes = 16 * 1024\n_fixture_emails = None\n",
        "fixture email state",
    )
    server = replace_once(
        server,
        """        elif self.path == '/api/events':
            self._handle_sse()
""",
        """        elif self.path == '/api/fixture-data.js':
            self._handle_fixture_data()
        elif self.path == '/api/events':
            self._handle_sse()
""",
        "fixture-data GET route",
    )
    server = replace_once(
        server,
        """    def _handle_oracle_seed(self):
        global _app_state, _seed_state
""",
        """    def _handle_oracle_seed(self):
        global _app_state, _seed_state, _fixture_emails
""",
        "fixture seed state assignment",
    )
    server = replace_once(
        server,
        """            _app_state = json.loads(json.dumps(state))
            _seed_state = json.loads(json.dumps(state))
""",
        """            _app_state = json.loads(json.dumps(state))
            _seed_state = json.loads(json.dumps(state))
            _fixture_emails = json.loads(json.dumps(emails))
""",
        "fixture seed email assignment",
    )
    server = replace_once(
        server,
        """    def _handle_put_state(self):
""",
        """    def _handle_fixture_data(self):
        with _state_lock:
            emails = _fixture_emails
        payload = json.dumps(emails, separators=(',', ':')).replace('<', '\\\\u003c')
        body = ('window.ACTIVETAB_FIXTURE_EMAILS = ' + payload + ';').encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/javascript; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_put_state(self):
""",
        "fixture-data response handler",
    )

    index = index_path.read_text(encoding="utf-8")
    index = replace_once(
        index,
        '    <script src="js/state.js"></script>',
        '    <script src="/api/fixture-data.js"></script>\n    <script src="js/state.js"></script>',
        "fixture-data script tag",
    )

    state = state_path.read_text(encoding="utf-8")
    state = replace_once(
        state,
        """        } else {
            this._loadSeedData();
        }
        this._recalculateLabelCounts();
""",
        """        } else {
            this._loadSeedData();
        }
        if (Array.isArray(window.ACTIVETAB_FIXTURE_EMAILS)) {
            this.emails = window.ACTIVETAB_FIXTURE_EMAILS.map((email, index) => ({
                ...structuredClone(EMAILS[0]),
                id: 9001 + index,
                threadId: 'activetab_fixture_' + index,
                from: { name: email.from.name, email: 'fixture-' + index + '@example.test' },
                subject: email.subject,
                snippet: 'Synthetic WebArena qualification record',
                body: 'Synthetic WebArena qualification record',
                date: '2026-01-' + String(index + 1).padStart(2, '0') + 'T12:00:00Z',
                isRead: email.isRead,
                isStarred: false,
                isImportant: false,
                labels: ['INBOX', 'CATEGORY_PRIMARY'],
                category: 'primary',
                hasAttachments: false,
                attachments: [],
                isSnoozed: false,
                snoozeUntil: null,
                isTrashed: false,
                isSpam: false,
                isArchived: false,
                isDraft: false,
                isSent: false,
                isMuted: false,
            }));
            this._nextEmailId = 9001 + this.emails.length;
        }
        this._recalculateLabelCounts();
""",
        "synthetic inbox binding",
    )

    server_path.write_text(server, encoding="utf-8")
    index_path.write_text(index, encoding="utf-8")
    state_path.write_text(state, encoding="utf-8")
    print("Bound the pinned WebArena Gmail UI to the bounded synthetic fixture seed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
