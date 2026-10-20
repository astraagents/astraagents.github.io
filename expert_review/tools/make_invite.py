#!/usr/bin/env python3
"""Print a reviewer invite link that carries the database credentials.

The credentials travel in the URL *fragment* (`#k=...`), which browsers never send
to a server, so they do not reach GitHub Pages' logs or this public repo. The page
reads the fragment, keeps the credentials in localStorage and strips the fragment
from the address bar. Treat the link like a password: send it privately.

    python3 expert_review/tools/make_invite.py [base_url]

base_url defaults to the GitHub Pages address of expert_review/.
"""

import base64
import sys

from pscale import credentials

DEFAULT_BASE = "https://astraagents.github.io/expert_review/"


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BASE
    user, password, *_ = credentials()
    token = base64.urlsafe_b64encode(f"{user}:{password}".encode()).decode().rstrip("=")
    print(f"{base}#k={token}")


if __name__ == "__main__":
    main()
