"""Point d'entrée Passenger (o2switch) : le serveur FastAPI (ASGI) via un adaptateur WSGI."""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Audiveris livré dans ~/transpoz-test/audiveris, lancé par audiveris.sh (réglages serveur).
os.environ.setdefault("AUDIVERIS_CMD", os.path.join(os.path.dirname(HERE), "audiveris.sh"))
os.environ.setdefault("OMR_ENGINE", "audiveris")

from a2wsgi import ASGIMiddleware  # noqa: E402

from server.main import app as asgi_app  # noqa: E402

application = ASGIMiddleware(asgi_app)
