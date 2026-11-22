"""Bounded, reusable HTTPS connections for the two public archive services."""

from contextlib import contextmanager
import http.client
import os
import ssl
import threading
import urllib.error
import urllib.request
from urllib.parse import urlsplit

_gdex = threading.BoundedSemaphore(10)
_ncei = threading.BoundedSemaphore(5)
_local = threading.local()


@contextmanager
def response(url, headers=None, method="GET", timeout=85):
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise ValueError("Archive transport requires HTTPS")
    gate = _gdex if parts.hostname.endswith(".ucar.edu") else _ncei
    if not hasattr(_local, "context"):
        _local.context = ssl.create_default_context(cafile=os.getenv("CFS_CA_FILE"))
        _local.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=_local.context))
        _local.connections = {}
    head = {
        "User-Agent": "MeteoDial historical archive builder",
        "Accept-Encoding": "identity",
        **(headers or {}),
    }
    with gate:
        if os.getenv("CFS_DIRECT") != "1":
            with _local.opener.open(
                urllib.request.Request(url, method=method, headers=head), timeout=timeout
            ) as r:
                yield r
            return
        target = parts.path + ("?" + parts.query if parts.query else "")
        for attempt in range(2):
            conn = _local.connections.get(parts.netloc)
            if conn is None:
                conn = http.client.HTTPSConnection(parts.netloc, timeout=timeout, context=_local.context)
                _local.connections[parts.netloc] = conn
            conn.timeout = timeout
            if conn.sock:
                conn.sock.settimeout(timeout)
            try:
                conn.request(method, target, headers=head)
                r = conn.getresponse()
                break
            except (OSError, http.client.HTTPException):
                conn.close()
                _local.connections.pop(parts.netloc, None)
                if attempt:
                    raise
        try:
            if not 200 <= r.status < 300:
                raise urllib.error.HTTPError(url, r.status, r.reason, r.headers, None)
            yield r
        finally:
            if method == "HEAD" and not r.isclosed():
                r.read()
            if not r.isclosed():
                conn.close()
            r.close()
